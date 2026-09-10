# Prompt 1 — Verify and fix Voxelhaven's visual rendering

You are working in the Voxelhaven project at `voxelhaven/` — a Minecraft-style voxel
sandbox built on vanilla JavaScript ES modules, raw WebGL2, and a zero-dependency
Node server. There is no build step and no bundler. Read `README.md` first for the
architecture, then `src/world/MeshBuilder.js`, `src/render/ChunkRenderer.js`,
`src/render/Shaders.js`, `src/render/DynamicMesh.js` and `src/render/TextureAtlas.js`.

A player reported three visual defects:

> "the trees are broken, going underground lets me see the whole wall, I don't see a
> player hand holding their item"

I have already reproduced all three in headless Chrome and reduced them to concrete,
testable root causes. **Do not re-derive these from scratch** — verify each finding,
fix it, and prove the fix. Where my analysis below is wrong, say so explicitly rather
than coding around it.

---

## Defect 1 (CRITICAL) — Faces pointing in −X, −Y and −Z are never emitted

### Evidence

Build a single stone block in mid-air, inside a cleared pocket, then mesh its chunk and
decode the emitted triangle normals from the vertex/index stream:

```
triangles for lone block: 6
  +X           emitted=2
  -X           emitted=0
  +Y top       emitted=2
  -Y bottom    emitted=0
  +Z           emitted=2
  -Z           emitted=0
```

A lone cube must emit 12 triangles, one per face. Three of its six faces are missing —
and they are exactly the three *negative*-axis faces. The winding of the faces that
**are** emitted is correct (verified by cross-product of each triangle's edge vectors),
so this is purely an emission-logic bug, not a winding or culling bug.

Build a sealed 5×5×5 stone box, stand inside it, look straight up, and read the
framebuffer: **88.2% of pixels are sky**, 8.8% dark, 3.0% grey. The room is sealed
according to the voxel data — a 77-ray fan from the camera hits stone 77/77 times —
yet the geometry is not on screen. Inspecting the built mesh for that chunk:

```
planeHits: { ceilY: 12, floorY: 4, ... }   // 12 verts on the OUTER top face (y=122)
                                            // 0 verts on the INNER under-face (y=120)
```

The ceiling's *underside* is absent while its *top* is present. The highlight outline
(the wireframe box around the targeted block) still draws, which proves the block data
and the interaction raycast are correct and that only the mesh is wrong.

### Root cause

`MeshBuilder.buildAxis()` (`src/world/MeshBuilder.js`, roughly lines 227–285) does
**not** test the negative direction. It only samples the neighbour at `slice + 1`:

```js
nCell[axis] = slice + 1;
const neighbourId = this.sampleBlock(chunk, world, nx, ny, nz);

if (isFaceVisible(selfId, neighbourId)) {
  this.writeMaskCell(..., selfId, axis, 1);          // the +axis face
} else if (PLANT[neighbourId] !== 1 && isFaceVisible(neighbourId, selfId)) {
  // "The face belongs to the neighbour and points back along -axis."
  this.writeMaskCell(..., neighbourId, axis, -1);
}
```

The `else if` is meant to cover the −axis face "belonging to the neighbour". It is
**structurally unreachable in the one case it is needed**:

- If the −axis neighbour is air, `isFaceVisible(selfId, AIR)` is already `true`, so the
  first branch wins and the `else if` is skipped — and the first branch writes the
  **+axis** face, not the −axis face.
- The `else if` can only run when the −axis neighbour is non-opaque *and* the +axis
  neighbour is opaque — but a single cell has only one −axis neighbour, which is
  unrelated to the +axis neighbour. It therefore fires for the wrong cell entirely.

Consequence: the −axis face is only ever produced as a side effect of the *neighbour's*
sweep. That works when the neighbour exists inside the same chunk, which is why
ordinary terrain mostly looks plausible. It fails for:

- an isolated block (all three −faces vanish),
- the under-face of any ceiling or overhang,
- the −X and −Z walls of a room or cliff,
- and the −X/−Z/-Y faces of the world's edge blocks and every chunk's minimum boundary.

`sampleBlock()` at line ~633 takes **chunk-local** coordinates (it indexes
`chunk.blocks` directly and only adds `chunk.originX/originZ` when falling through to
`world.getBlock`), so passing `slice - 1 == -1` is safe and correctly resolves to the
neighbouring chunk. There is no coordinate-space obstacle to fixing this.

### What to do

Rework `buildAxis()` so that **every** face of **every** non-air, non-plant block is
considered exactly once, testing both directions:

- For a solid block, test `slice + 1`: if `isFaceVisible(selfId, neighbourId)`, emit the
  `+axis` face for the block at `slice`.
- Independently test `slice - 1`: if `isFaceVisible(selfId, belowNeighbourId)`, emit the
  `-axis` face for the block at `slice`.
- Remove the neighbour-face-delegation `else if` entirely. It exists only to compensate
  for the missing negative test, and once both directions are tested it will
  double-emit faces.
- Keep the greedy merge. The mask is indexed by `(u, v)` per slice with a single
  `maskId`/`maskAo`/`maskSky`/`maskBlock` slot per cell, so a cell can hold at most one
  face. Either run two mask passes per axis (one per direction) or widen the mask to
  hold both directions and let `mergeAndEmit` treat the direction as part of the merge
  key. **Choose one and explain the choice in a comment** — the merge key must include
  the face sign, or opposing faces of a 1-block-thick wall will merge into one quad.
- Preserve these invariants, which other systems depend on:
  - `sign > 0` still means the face is at `slice + 1` and its outward normal is
    `+axis`; `sign < 0` means the face is at `slice` with normal `-axis`. The existing
    `emitQuad` corner ordering and its `sign`-dependent index swap are already correct
    (I verified the emitted normals) — **do not change `emitQuad`'s winding.**
  - `computeCornerData(chunk, world, x, y, z, axis, sign)` expects the coordinates of
    the *owning* block and the face sign, which is how it is already called.
  - Plants are skipped in the axis sweep and drawn by `buildPlants()`; keep that.
  - The liquid surface drop still applies only to water with air above it.

### Acceptance test (write this as a permanent regression test)

Add a test asserting that a lone stone block surrounded by air emits exactly
**6 faces / 12 triangles**, and that the six geometric normals recovered from the
index stream are the six unit axis vectors — `+X, −X, +Y, −Y, +Z, −Z` — each exactly
once. This test must fail on the current code (it emits 3 faces / 6 triangles) and pass
after the fix. Also assert the sealed-box case: standing inside a sealed 5×5×5 stone
box looking straight up must produce **0% sky pixels** in the centre of the frame. This
is the strongest available guard against the class of bug, because it fails loudly if
any future mesher change drops interior faces again.

---

## Defect 2 — Trees look riddled with holes ("broken trees")

### Evidence

A broadleaf tree photographed head-on shows a canopy full of hard-edged rectangular
gaps that read as bites taken out of the leaves, plus straight vertical seams where the
canopy changes shape mid-tree. The trunk renders as a clean solid column, so this is
specific to the leaf block.

### Root cause (two independent causes — fix both)

**(a) The canopy texture is authored with hard alpha holes.** In
`src/render/TextureAtlas.js` around line 260:

```js
canopy: (set, rng) => {
  // Clumped leaves with transparent gaps so canopies read as foliage.
  for (let y = 0; y < TILE; y++) {
    for (let x = 0; x < TILE; x++) {
      const n = rng.next();
      if (n < 0.10) { set(x, y, null); continue; }   // <-- 10% fully transparent
```

Combined with the opaque pass's alpha test (`gl.uniform1f(u.uAlphaCutoff, 0.5)` in
`Renderer.applyVoxelState`), those 10% of texels become literal holes you can see
through. On a 16×16 tile that is ~26 punched holes per face, and they line up across
adjacent leaf blocks into obvious repeating perforations.

**(b) Trees are clipped at chunk boundaries.** `TerrainGenerator.generateChunk` iterates
only the chunk's own columns and calls `treeAt(wx, wz)` / `writeTree(chunk, tree)` for
trees whose *trunk* is inside the chunk. `writeTree`'s `put()` helper drops any block
outside the chunk bounds. A broadleaf canopy has radius 2, so any tree whose trunk sits
within 2 blocks of a chunk edge loses the part of its canopy that overhangs into the
neighbouring chunk — and nothing regenerates it, because the neighbouring column's
`treeAt()` returns `null` (that column is not the tree's candidate column). This
produces the straight vertical cut and a half-canopy.

### What to do

For (a), give canopy a leaf texture that is solid — or, if you want visual depth, keep
the holes but make them *shaded* leaf colour rather than transparent, so the geometry
stays opaque and the alpha test has nothing to reject. Do **not** disable the alpha test
globally: it is what makes `bramble`, `bloom`, `glass` and plant billboards work.
Whatever you choose, the leaf block must render as a continuous surface with no gaps
through which the sky is visible, and the result must still read as foliage rather than
a flat green cube.

For (b), generate trees for a margin of columns *outside* the chunk, then let `put()`
clip them as it already does. Concretely: when generating chunk `(cx, cz)`, iterate
columns from `originX - TREE_MARGIN` to `originX + CHUNK_SIZE - 1 + TREE_MARGIN`
(and the same for Z), call `treeAt()` on each, and stamp every returned tree with
`writeTree()`. `TREE_MARGIN` must be at least the maximum canopy radius (2 for
broadleaf, and 1 for the needle cross layer plus the `rng.int(-2, 2)` extra-leaf spread
— so **2** is sufficient, but derive it from the generation constants rather than
hard-coding a magic number, and add an assertion or comment tying it to those values).
`treeAt()` already calls `surfaceHeight()` and `biomeAt()` purely from noise, so it is
safe to evaluate for columns outside the chunk. Make sure this does not introduce a
visible cost regression — measure `generate` time per chunk before and after and report
both numbers.

### Acceptance test

For every tree whose canopy radius extends past a chunk border, assert that all canopy
blocks the generator intends to place exist in the world, whether or not they land in
the trunk's own chunk. A practical formulation: pick a seed, find a tree within 2 blocks
of a chunk edge, and assert that the canopy block count within the trunk's canopy volume
matches the count produced by the same generator run without chunk partitioning. Also
add a rendering assertion: photograph a tree against the sky and assert that the canopy
region contains no sky-coloured pixels.

---

## Defect 3 — "I don't see a player hand holding their item"

### Evidence

There **is** a held-item mesh and it **is** being drawn. `buildHeldItem()` returns a
well-formed full cube, and the pass runs without a GL error:

```
buildHeldItem -> { indexCount: 36, vertexCount: 24 }    // 6 quads, a full cube
HELD-PROBE: glError 0, heldStack { item: "lantern", count: 24 }
```

My framebuffer diff for this case was **contaminated**: emptying the selected slot also
changed the hotbar UI, so the reported pixel delta covers the HUD, not the hand. Do not
trust that number — re-measure it properly (see the acceptance test below, which hides
the mesh without mutating the inventory).

The confirmed problem is presentation, and the screenshots show it plainly: the held
cube renders as a large, free-floating, axis-yawed cube sitting well to the right of the
crosshair, roughly a third of the viewport tall, with nothing that reads as a hand or
arm. A player reasonably concludes there is no held item at all.

### Root cause

`Game.buildHeldItem()` (`src/Game.js`, ~lines 958–998) composes a single full-size
block cube in view space:

```js
const x = 0.30 - swing * 0.06;
const y = -0.24 + bob - swing * 0.12;
const z = -0.62;
const scale = 0.155;
composeViewMatrix(matrix, x, y, z, 0.62 + swing * 0.55, -0.30 + swing * 0.5, 0.1, scale, scale, scale);
mesh.addBoxMulti(matrix, tilesLocal, 1.0, 0.55, 1.0);
```

At `z = -0.62` with a 72° field of view, a `0.155`-scaled unit cube subtends an
extremely large angle, and `x = 0.30` pushes it off to the right. There is no arm, no
hand, and no anchoring to the screen edge, so it reads as a stray object rather than a
held item.

### What to do

Make it read unmistakably as a first-person held item:

- Reduce the apparent size and anchor the item to the bottom-right corner of the view,
  partially cropped by the screen edge so it reads as "in hand" rather than "floating in
  the world". A good starting point is to push it further from the camera and closer to
  the corner (roughly `z ≈ -0.85`, `x ≈ 0.42`, `y ≈ -0.42`, scale around `0.10`), then
  tune by eye against screenshots.
- **Add an arm.** Render a short forearm/hand shape beneath and behind the item so the
  player reads "I am holding this". Use `DynamicMesh.addBoxMulti` with a dedicated
  skin-tone `hand`/`arm` tile painted into the atlas, built in the same view space.
  Keep it subtle — it must not obscure the crosshair or more than a small corner of the
  view.
- Keep the swing animation, and make sure the arm swings with the item rather than
  independently.
- Keep the item's tile correct for both block items and material items — the existing
  `ItemRegistry.blockIdOf` / `BlockRegistry.faceTileName` / `ItemRegistry.tile` logic is
  right; preserve it.
- Preserve the current depth handling: `Renderer.render()` clears the depth buffer
  before the held-item pass (line ~218) so the item is never clipped by geometry the
  camera is inside. That behaviour is correct and must stay.
- The held item must be **absent** in the loading preview (`renderWorldPreview`) and
  must not appear when the selected slot is empty.

### Acceptance test

- With an empty selected slot, the lower-right region of the frame is identical to a
  frame rendered with the held-item pass disabled — i.e. nothing is drawn.
- With a block in the selected slot, a bounded region in the lower-right changes, and
  the crosshair centre pixel does **not** change (the item must not cover the crosshair).
- Both a block item (e.g. `lantern`) and a material item (e.g. `fiber`) render.
- `gl.getError()` stays `0` after the held-item pass.

---

## Required workflow

1. **Reproduce before fixing.** Write a throwaway probe against the existing harness in
   `test/headless.mjs` (see `test/run-tests.mjs` for how it is driven). Boot a fixed-seed
   world with `VH.createWorld({ seed: 4242 })`, drive input through
   `VH.setAction(action, down)` rather than synthetic DOM events, and read pixels with
   `gl.readPixels` (works because the renderer sets `preserveDrawingBuffer: true`).
2. **Fix one defect at a time**, re-running your probe after each to confirm the specific
   symptom changed.
3. **Turn each reproduction into a permanent assertion** in `test/run-tests.mjs`. The
   suite currently passes 89 assertions with `node test/run-tests.mjs`; it must still
   pass, with the new assertions added. Do not weaken or delete existing assertions.
4. **Verify the whole game still works**, not just the mesher. Run the full suite and
   confirm a real session end-to-end: create world → play → mine → place → save → quit →
   load, with 0 page errors and 0 console errors.
5. **Check for performance regressions.** The mesher runs inside an 8 ms frame budget
   (`FRAME_BUDGET_MS`). Emitting the previously-missing faces will legitimately increase
   vertex counts for overhangs and interiors, and the tree margin increases generation
   work. Report before/after numbers for: vertices per representative chunk, visible
   triangles, mesh time per chunk, and generation time per chunk. If visible triangle
   count grows by more than about 30% on a typical surface view, say so and explain why
   the increase is correct rather than trying to hide it.

## Deliverables

Report back with:

- The root cause you confirmed for each of the three defects, and any place my analysis
  above was wrong or incomplete.
- The exact fix for each, with file and line references.
- The new tests, and confirmation they fail before and pass after the fix.
- Full `node test/run-tests.mjs` output (pass/fail counts).
- Before/after screenshots for: a lone block, the inside of a sealed room looking up and
  looking sideways, a tree against the sky, and the held item with an empty slot vs a
  filled slot.
- The performance numbers requested above.

## Constraints

- Keep the zero-dependency architecture: no new runtime npm packages, no build step, no
  bundler, no external asset files. Textures stay procedurally generated into the atlas.
- Keep the greedy-mesh and 11-float vertex format. Do not switch to per-block cubes.
- Do not change `src/world/Blocks.js` face-index ordering (`0=+X, 1=−X, 2=+Y, 3=−Y,
  4=+Z, 5=−Z`) or `U_AXIS`/`V_AXIS`; the atlas tile painters and `DynamicMesh.CUBE_FACES`
  depend on that convention. If you believe the convention itself is the bug, prove it
  and explain the blast radius before changing it.
- No placeholders, no stub functions, no `TODO`, no `...` elisions. Production-quality
  code with comments explaining *why*, matching the existing file style.
