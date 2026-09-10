# Voxelhaven

A complete, playable voxel survival sandbox that runs in the browser.
Procedurally generated terrain, first-person movement, block breaking and
placing, an inventory with crafting, caves, trees, a day/night cycle, mobs,
and world persistence — all connected into one coherent game.

Everything is original: the code, the block and item names, the mob designs,
and every texture (generated procedurally at startup from code — there are no
image, audio or font files anywhere in this project).

---

## Running it

Requirements: **Node.js 18 or newer** and a browser with **WebGL2**
(Chrome, Edge, Firefox, or Safari 15+).

```bash
cd voxelhaven
node server.js
```

Then open **http://127.0.0.1:8123/**.

The server has **no runtime dependencies** — it uses only Node's built-in
modules, so there is nothing to install. (`npm install` is only needed if you
want to run the automated browser tests.)

Options:

```bash
node server.js --port 8080      # use a different port
node server.js --host 0.0.0.0   # listen on all interfaces
node server.js --no-saves       # disable the on-disk save API
```

### Controls

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | Move |
| Mouse | Look |
| `Space` | Jump / swim up |
| `Shift` | Sprint |
| `Ctrl` or `C` | Crouch |
| Left click | Break block / attack |
| Right click | Place block |
| Middle click | Pick the targeted block into the hotbar |
| `Q` | Drop one item |
| `1`–`9`, mouse wheel | Select a hotbar slot |
| `E` or `Tab` | Inventory and crafting |
| `R` | Crafting screen |
| `F3` or `` ` `` | Debug overlay |
| `F2` | Save a screenshot |
| `M` | Mute audio |
| `Esc` | Pause menu |

Click the world once to capture the mouse. `Esc` releases it.

---

## Architecture

The project is plain ES modules and raw WebGL2. There is no build step, no
bundler and no framework: what you see in `src/` is what the browser runs.

```
voxelhaven/
├── index.html                 Markup for the canvas and every UI screen
├── styles.css                 All interface styling
├── server.js                  Static file server + JSON save API (zero deps)
├── package.json               Scripts; dev-only dependency for the tests
│
├── src/
│   ├── main.js                Entry point; turns startup failures into a screen
│   ├── Game.js                Orchestrator: lifecycle, fixed-step loop, frame render
│   ├── GameState.js           The finite states the game can be in
│   ├── Debug.js               Console/automation API (window.VH)
│   │
│   ├── core/
│   │   ├── Config.js          Every tunable constant in the game
│   │   ├── EventBus.js        Tiny publish/subscribe bus
│   │   ├── Math3D.js          Matrices, frustum culling, interpolation helpers
│   │   ├── Noise.js           Perlin noise, fBm, ridged multifractal
│   │   └── Random.js          Deterministic PRNGs and integer hashes
│   │
│   ├── world/
│   │   ├── Blocks.js          Block registry (+ flat lookup tables for hot paths)
│   │   ├── Items.js           Item registry (blocks and materials)
│   │   ├── Chunk.js           16 x 128 x 16 voxel storage, light arrays, delta map
│   │   ├── World.js           Authoritative voxel store, edits, world-coordinate API
│   │   ├── TerrainGenerator.js Biomes, elevation, caves, ore veins, trees
│   │   ├── LightEngine.js     Skylight + block light BFS (cross-chunk)
│   │   ├── MeshBuilder.js     Greedy meshing with ambient occlusion and smooth light
│   │   ├── ChunkManager.js    Streaming, worker pool, lighting/meshing queues
│   │   └── Raycast.js         Voxel DDA ray traversal (block targeting)
│   │
│   ├── render/
│   │   ├── Renderer.js        WebGL2 context, frame orchestration
│   │   ├── Shaders.js         GLSL: voxel, sky and line programs
│   │   ├── GLUtils.js         Shader compilation, VAO creation, resize helpers
│   │   ├── TextureAtlas.js    Every texture, painted procedurally into one atlas
│   │   ├── ChunkRenderer.js   Per-chunk GPU meshes, frustum culling, transparent sort
│   │   ├── DynamicMesh.js     Reusable CPU-built mesh for entities/particles/hand
│   │   ├── EntityRenderer.js  Mobs and dropped items as textured boxes
│   │   ├── ParticleSystem.js  Block-break debris and impact puffs
│   │   ├── SkyRenderer.js     Gradient sky, sun, moon, stars, clouds
│   │   └── HighlightRenderer.js Block selection outline and break progress
│   │
│   ├── player/
│   │   ├── Player.js          Player state: health, breath, spawn, inventory
│   │   ├── PlayerController.js Movement, gravity, jumping, swimming, camera
│   │   ├── Camera.js          Projection/view matrices and the view frustum
│   │   ├── Physics.js         AABB-vs-voxel collision resolution
│   │   ├── Inventory.js       Hotbar + backpack, stacking and merging
│   │   └── Interaction.js     Breaking, placing, attacking, dropping
│   │
│   ├── entities/
│   │   ├── Entity.js          Base entity: physics, turning, serialisation
│   │   ├── Mob.js             Shared mob behaviour: health, AI helpers, loot
│   │   ├── ItemEntity.js      Dropped stacks with magnet pickup
│   │   ├── Woolback.js        Passive woolly grazer (drops Fiber)
│   │   ├── Gloomling.js       Nocturnal hunter (burns in daylight)
│   │   └── EntityManager.js   Spawning, updating, culling, persistence
│   │
│   ├── systems/
│   │   ├── TimeSystem.js      Day/night cycle and the lighting environment
│   │   ├── Input.js           Keyboard, mouse and pointer lock
│   │   ├── AudioSystem.js     Every sound, synthesised with Web Audio
│   │   ├── SaveSystem.js      World persistence (seed + delta)
│   │   └── Crafting.js        The recipe book
│   │
│   ├── ui/
│   │   ├── HUD.js             Crosshair, hotbar, hearts, breath, debug overlay
│   │   ├── Menus.js           Main menu, world list, create, pause, settings, death
│   │   └── InventoryUI.js     Inventory grid and craft panel
│   │
│   └── workers/
│       └── terrain.worker.js  Off-thread chunk generation
│
└── test/
    ├── run-tests.mjs          End-to-end integration suite (drives a real browser)
    └── headless.mjs           Server + browser harness for the tests
```

### How the systems connect

```
                     ┌──────────────┐
                     │  TimeSystem  │─── environment (light, colours, fog)
                     └──────┬───────┘
                            │
  Input ──▶ PlayerController ──▶ Player ──▶ Camera
                            │                 │
                            ▼                 ▼
                     Interaction ──────▶ World ◀──── EntityManager
                            │                 │              │
                            │        ┌────────┴────────┐     │
                            ▼        ▼                 ▼     ▼
                       ParticleSystem  ChunkManager   Renderer
                                            │
                              ┌─────────────┼──────────────┐
                              ▼             ▼              ▼
                     terrain workers   LightEngine    MeshBuilder
```

Nothing reaches "upwards": the world never talks to the UI, and the renderer
never modifies voxels. Cross-system reactions go through a small event bus
(`blockChanged`, `playerDied`, `itemPickedUp`, ...).

### Design decisions worth knowing

**Chunk storage.** Each chunk is a flat `Uint8Array(16 * 128 * 16)` of block
ids plus two parallel light arrays. Indexing is `(y * 16 + z) * 16 + x`, so a
horizontal slice is contiguous — which is what the mesh sweep and the column
scans want.

**Greedy meshing.** The mesher sweeps each axis, builds a mask of visible
faces, and merges neighbouring quads whose block, facing, and all four corner
ambient-occlusion *and* light values are identical. Because the corner
attributes are part of the merge predicate, merging can never change how a
surface is shaded — it only removes vertices. Flat lit terrain collapses to a
handful of large quads.

**Lighting.** Skylight is seeded from the top of each column and flooded with a
BFS; block light is seeded by lanterns and glowcaps. Propagation reads voxels
and light across chunk borders but writes only inside the chunk being lit. When
the player changes a block, every chunk within 15 blocks (the maximum light
radius) is rebuilt in two passes: pass 1 clears and re-seeds them all, pass 2
re-imports across borders. A single pass would let a removed lantern's light
flow straight back in from a neighbour that still remembered it.

**Streaming.** Terrain generation runs in a pool of Web Workers. Lighting and
meshing run on the main thread but inside an explicit per-frame time budget, so
the frame rate never collapses while the world streams in. Player edits jump
the queue.

**Persistence.** A world is stored as its **seed** plus a **delta** of the
blocks the player changed — never as a dump of every block. Generating 289
chunks takes a couple of seconds; storing them would take tens of megabytes.
Saves are written by the server to `saves/<id>.json` using a
write-then-rename so a crash cannot leave a half-written file. If the API is
unreachable the client falls back to `localStorage`.

---

## Testing

The test suite boots the real server, launches a real browser, creates a real
world and drives the complete player journey — it is an integration test, not a
unit test.

```bash
npm install          # dev-only: puppeteer-core, to drive an existing Chrome
npm test             # headless
npm run test:headed  # watch it play
```

It looks for Chrome at `CHROME_PATH` or the usual system locations and forces
software WebGL (SwiftShader), so it runs on machines with no GPU.

The suite covers 89 assertions across: world creation, terrain generation,
determinism, caves, trees, movement, jumping, gravity, fall damage, collision,
raycast targeting, breaking, dropping, pickup, placing, placement refusal,
stacking, the hotbar, crafting, lighting, the day/night cycle, mobs, loot,
saving, reloading, save corruption handling, rendering output, death, respawn,
and console hygiene.

---

## Performance

Measured in-page with the debug API on the reference machine, with a render
distance of 8 (225 loaded chunks, ~110k triangles visible):

| Work | Cost |
| --- | --- |
| Physics + mob/entity simulation (per 60 Hz step) | ~0.003 ms |
| Entities, particles, HUD, dynamic meshes (per frame) | ~0.24 ms |
| Chunk streaming bookkeeping, steady state (per frame) | ~0.002 ms |
| Chunk generation (per chunk, off the main thread) | ~2 ms |
| Chunk lighting (per chunk) | ~1 ms |
| Chunk meshing (per chunk) | ~2 ms |

The whole CPU side of a steady-state frame costs roughly **0.25 ms**, so the
frame rate is bound by the GPU. Generation runs in Web Workers; lighting and
meshing run on the main thread but inside an explicit 8 ms per-frame budget
with at most three chunk uploads per frame, and player edits jump the queue.

Two optimisations do most of the work:

* **Greedy meshing** collapses flat, uniformly lit terrain into a handful of
  large quads instead of one quad per block face.
* **Chunk-batched draw calls** mean a render distance of 8 needs only ~30–80
  draw calls, not one per chunk section or one per block.

---

## Known limitations

These are deliberate scope choices, not unfinished work:

* **No crafting table, furnace or tools.** The recipe book is a small
  affordance panel rather than a grid. Blocks break at a fixed speed regardless
  of what is held.
* **No fluid simulation.** Water is placed by the generator and stays put;
  breaking a block next to water does not flood the space.
* **No redstone, chests, or item transport.** Dropped items are entities that
  despawn after five minutes.
* **Caves are noise-carved, not connected.** There is no guarantee that a cave
  system links to the surface, and no ravines or mineshafts.
* **Mob AI is deliberately simple.** Mobs steer directly at their target and
  hop over single-block obstacles; there is no pathfinding, so they can get
  stuck behind a wall.
* **Lighting is per-chunk, not per-block-tick.** A block change rebuilds the
  affected chunks (up to nine) rather than doing an incremental light edit.
  This is exact but costs a few milliseconds per edit, spread across frames.
* **Only one dimension.** There is no Nether-like second world.
* **No multiplayer.** Saves are local to the machine running the server.
* **The terrain is 128 blocks tall.** The generator caps peaks well below that
  limit to leave room to build.
