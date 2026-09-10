# Voxelhaven

A complete, playable voxel survival sandbox that runs in the browser.
Procedurally generated terrain, first-person movement, block breaking and
placing, an inventory with crafting, caves, trees, a day/night cycle, mobs,
and world persistence — all connected into one coherent game.

Everything is original: the code, the block and item names, the mob designs,
and every texture (generated procedurally at startup from code — there are no
image, audio or font files anywhere in this project).

---

## Licence and attribution

Voxelhaven's **code, block and item names, textures and audio are original**
and are covered by the project's MIT licence (`license` in `package.json`).

The **recipe data** in `src/data/recipes.json` is a different matter. It is
derived from recipe structure published on the
[Minecraft Wiki](https://minecraft.wiki), which is licensed
**CC BY-NC-SA 3.0** (<https://meta.weirdgloop.org/w/Licensing>). That data —
and only that data — is used under those terms:

* **Attribution.** The generated file carries a header naming the source, the
  retrieval date and the licence; see also the `NOTICE` file.
* **Non-commercial.** CC BY-NC-SA is a *non-commercial* licence. Shipping
  Voxelhaven commercially would require re-deriving the recipe corpus from a
  source that permits it.
* **Share-alike.** The recipe data itself stays under CC BY-NC-SA 3.0.
* **Structure only.** Only *which item goes in which slot, in what quantity*
  was taken. No wiki prose, images, sprites or templates are copied, and every
  Voxelhaven block name, item name, texture and line of code is original.

`tools/` contains the scraper, the mapping table and the generator that
produced the snapshot, so the derivation is fully auditable and reproducible.

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
| Right click | Place block, or use a crafting table / furnace / bucket |
| Middle click | Pick the targeted block into the hotbar |
| `Q` | Drop one item |
| `1`–`9`, mouse wheel | Select a hotbar slot |
| `E` or `Tab` | Inventory, with the 2×2 crafting grid |
| `R` | Inventory, scrolled to the recipe browser |
| `F3` or `` ` `` | Debug overlay |
| `F2` | Save a screenshot |
| `M` | Mute audio |
| `Esc` | Pause menu |

Click the world once to capture the mouse. `Esc` releases it.

---

## How to play it: the progression

Voxelhaven's crafting follows the Minecraft one closely enough that the wiki is
a usable manual, scaled down to the items the game actually has.

1. **Timber.** Punch a tree. Logs break fastest with an axe but yield to bare
   hands; you need three logs to reach an iron pickaxe.
2. **Planks and sticks.** `E` opens the inventory and its 2×2 grid. Lay a log
   out (or click *Lay out* in the recipe browser on the right) and take four
   planks; two planks stacked vertically make four sticks.
3. **Crafting table.** Four planks in a square. Place it with right-click.
4. **Wooden tools.** Right-click the placed table to open the 3×3 grid: three
   planks across the top and two sticks below make a pickaxe; the axe and the
   shovel use the wiki's own shapes.
5. **Stone.** A wooden pickaxe is the first tool that can harvest stone, and
   stone is the first block that bare hands break without getting anything.
   Cobblestone from that first block makes stone tools, which are twice as fast.
   Behind the spawn, a stone block is also the quickest way to see the tool
   tier rules for yourself.
6. **Furnace.** Eight cobblestone in a ring. Right-click it to open the
   smelting screen: fuel at the bottom, ore at the top.
7. **Charcoal and torches.** Smelt a log into charcoal, then combine charcoal
   (or coal, from the black-speckled ore near the surface) with a stick for
   four torches. Torches are crossed-billboard plants that light caves for
   twelve blocks.
8. **Iron.** Iron ore sits below y≈44 and needs a *stone* pickaxe. Smelt it
   into ingots, then craft an iron pickaxe, a bucket, a block of iron, or the
   wiki's lantern (eight iron nuggets around a torch).
9. **Water and turf.** Fill the bucket from any water block by right-clicking
   it, then use the water bucket on four loam to grow turf — the bucket comes
   back empty, which is the game's one reminder that crafting can return
   containers.
10. **Everything else.** Stone bricks, sandstone, cut sandstone, smooth stone
    and smooth sandstone come from the wiki's building-block recipes, and coal
    blocks and iron blocks compress nine items into one.

The **recipe browser** on the right of the inventory screen lists every recipe
in the game. It stays visible when you cannot afford something, greys out what
you are missing, and fills the grid for you when you can — so you can always
see what the next step is.

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
│   ├── data/
│   │   ├── recipes.json       Vendored recipe snapshot, generated from the wiki
│   │   └── RecipeBook.js      Loads and indexes the snapshot for the engine
│   │
│   ├── world/
│   │   ├── Blocks.js          Block registry (+ tool families and harvest tiers)
│   │   ├── Items.js           Item registry (blocks, materials, tools, durability)
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
│   │   ├── CraftGrid.js       The 2×2 / 3×3 crafting grid as a container
│   │   └── Interaction.js     Breaking, placing, using, attacking, dropping
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
│   │   ├── Crafting.js        Grid matching and the crafting engine
│   │   └── Smelting.js        Furnace simulation (fuel, burn timer, cook timer)
│   │
│   ├── ui/
│   │   ├── HUD.js             Crosshair, hotbar, hearts, breath, debug overlay
│   │   ├── Menus.js           Main menu, world list, create, pause, settings, death
│   │   ├── SlotView.js        Shared slot rendering and the held-stack model
│   │   ├── InventoryUI.js     Inventory / crafting-table screen and recipe browser
│   │   └── FurnaceUI.js       Smelting screen (input, fuel, result, gauges)
│   │
│   └── workers/
│       └── terrain.worker.js  Off-thread chunk generation
│
├── tools/                     Development tools; never loaded by the game
│   ├── scrape-wiki.mjs        Fetches the wiki's recipe tables into the cache
│   ├── build-recipes.mjs      Corpus + mapping -> src/data/recipes.json
│   ├── mappings/item-map.json Wiki name -> Voxelhaven item, tag and fuel tables
│   ├── lib/wiki-client.mjs    robots.txt-aware, rate-limited, caching HTTP client
│   ├── lib/html-lite.mjs      Small HTML parser (no dependencies)
│   ├── lib/recipe-extract.mjs Rendered recipe grid -> normalised records
│   └── cache/                 Cached wiki pages and the extracted corpus
│
└── test/
    ├── run-tests.mjs          Integration suite: offline checks + a real browser
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

The suite covers **237 assertions**. It runs in two halves:

**Offline checks** (plain module imports, no server, no browser) cover the
recipe snapshot and its attribution, mapping integrity (every referenced item
exists, every recipe matches its own arrangement, and every ingredient is
reachable from what the world can supply), shaped / shapeless / mirrored /
tag / "Matching" matching, grid offsets, consumption, inventory-room refusal,
remainders, per-slot counts, tool tiers and durability, the furnace
simulation, byte-identical regeneration of `recipes.json` from the cached
corpus, and `match()` performance.

**Browser checks** cover world creation, terrain generation, determinism,
caves, trees, movement, jumping, gravity, fall damage, collision, raycast
targeting, breaking, dropping, pickup, placing, placement refusal, stacking,
the hotbar, the crafting screen (2×2 and 3×3 grids, the result preview, the
recipe browser, keyboard operation, closing returns grid contents), lighting,
the day/night cycle, mobs, loot, saving, reloading, save corruption handling,
rendering output, death, respawn, console hygiene, and a full end-to-end
journey: fell a tree → craft planks → craft a crafting table → place it →
right-click it for the 3×3 grid → craft a pickaxe → mine stone with it →
smelt iron in a placed furnace → save → quit → load → confirm the crafted
items, the tool's durability and the placed blocks all survived.

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

* **Water is a block, not a fluid.** It is placed by the generator and stays
  put; breaking a block next to water does not flood the space. A bucket can
  scoop it, and that is all.
* **The recipe corpus is a coherent subset.** Voxelhaven has 49 items against
  Minecraft's several thousand, so 30 of the wiki's 622 crafting recipes and 6
  of its smelting recipes are supported. Everything shipped is craftable: the
  test suite proves every recipe's ingredients are reachable from what the
  world generates. The excluded families are listed in
  `tools/mappings/item-map.json` under `unsupported`, with a reason for each.
* **No smelting variants.** There is one furnace; there is no blast furnace,
  smoker or campfire, and no experience or hunger. Smelting returns items only.
* **No redstone, chests or item transport.** Dropped items are entities that
  despawn after five minutes, and a furnace is the only block with an
  inventory of its own.
* **No non-cube block models.** The mesher builds full cubes and crossed
  billboards, so slabs, stairs, fences, doors, panes, ladders and signs do not
  exist — which is why their recipes are absent rather than broken.
* **No dye, wool, clay, nether or ocean content,** so every recipe that needs
  those materials is excluded.
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
  A chunk never imports light from a neighbour that is itself queued for a
  rebuild, which is what stops a removed lantern from leaving a ghost behind.
* **Only one dimension.** There is no Nether-like second world.
* **No multiplayer.** Saves are local to the machine running the server.
* **The terrain is 128 blocks tall.** The generator caps peaks well below that
  limit to leave room to build.
