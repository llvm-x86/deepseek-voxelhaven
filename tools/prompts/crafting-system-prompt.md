# Prompt 2 — Implement Voxelhaven's full grid-based crafting system, sourced from the Minecraft Wiki

You are working in the Voxelhaven project at `voxelhaven/` — a Minecraft-style voxel
sandbox built on vanilla JavaScript ES modules, raw WebGL2, and a zero-dependency Node
server. There is no build step, no bundler, and **no runtime npm dependencies**. Read
`README.md` first, then `src/systems/Crafting.js`, `src/world/Items.js`,
`src/world/Blocks.js`, `src/player/Inventory.js`, `src/ui/InventoryUI.js`,
`src/player/Interaction.js`, `src/systems/SaveSystem.js`, `index.html` and `styles.css`.

## Current state

Crafting today is a placeholder. `src/systems/Crafting.js` is a flat array of **four**
recipes with a single input list each:

```js
export const RECIPES = [
  { id: 'planks',  inputs: [{ item: 'timber', count: 1 }], output: { item: 'planks', count: 4 }, ... },
  { id: 'glass',   inputs: [{ item: 'sand',   count: 2 }], output: { item: 'glass',  count: 1 }, ... },
  { id: 'lantern', inputs: [{ item: 'coal', count: 1 }, { item: 'planks', count: 4 }], ... },
  { id: 'canopy',  inputs: [{ item: 'fiber',  count: 4 }], output: { item: 'canopy', count: 1 }, ... }
];
```

`Crafting.available(inventory)` renders every affordable recipe as a button in a
scrollable list (`InventoryUI.refreshCrafting()`). There is **no grid, no shaped
recipes, no recipe matching, no crafting table block, no ingredients/tags, and no
durability or tool tiers.**

The item registry (`src/world/Items.js`) has exactly 21 blocks and 2 material items
(`coal`, `fiber`), each defined by `{ key, name, maxStack, tile, blockId }`. Item keys
are stable strings written into save files, so **adding items is safe; renaming or
removing one breaks existing saves.**

## Goal

Replace the placeholder with a **complete, real crafting system**: a 3×3 crafting grid
with shaped and shapeless recipe matching, a 2×2 inventory grid, a placeable crafting
table, item tags/ingredients, correct remainder and container semantics, and an item
set large enough that the recipes are actually playable — with the recipe corpus
**derived from the Minecraft Wiki**.

---

## Part 1 — Acquiring the recipe corpus from the Minecraft Wiki

### The wiki does expose structured recipe data. Use it; do not hand-transcribe recipes.

The Minecraft Wiki stores recipes as Semantic MediaWiki subobjects with dedicated
properties, documented at
<https://minecraft.wiki/w/Minecraft_Wiki:Projects/Recipe_usage_rewrite/Data_architecture>:

- **`Crafting JSON`** — the recipe template arguments serialised as JSON. This is the
  authoritative structured form and is what you want.
- **`Crafting ingredient`** / **`Crafting output`** — the ingredient and output names,
  with group aliases expanded (e.g. the boats recipe expands `Matching Overworld Planks`
  into all 11 plank variants).
- **`Crafting type`** — a coarse category used for grouping.

The recipe template arguments are grid-keyed: `A1`–`C3` for the 3×3 slots, plus
`Output`, `type`, and a shapeless flag. A real example, the crafting table, is stored as:

```json
{ "A1": "...", "A2": "...", "B2": "...", "C1": "...", "C2": "...", "Output": "...", "type": "..." }
```

Note the distinction the wiki draws between **"Any"** and **"Matching"** aliases:
`Any` ingredients behave like item tags (any member will do, and members may differ),
whereas `Matching` ingredients must all be the *same* member and that member determines
the output variant. Your matcher must model both.

### Suggested acquisition strategy

1. **Bulk path:** try a Semantic MediaWiki ask query against
   `https://minecraft.wiki/api.php` for the `Crafting JSON` property across recipe-bearing
   pages. Verify whether the SMW ask API is enabled on this wiki before relying on it; if
   it is not, fall back to the next step.
2. **Per-page path (known to work):** fetch rendered/raw page content through the
   standard MediaWiki API, which I confirmed responds correctly:

   ```
   https://minecraft.wiki/api.php?action=parse&page=Crafting_Table&prop=wikitext&format=json
   ```

   Recipes live in `{{Crafting|...}}` template invocations in the wikitext. Harvest the
   page list from the crafting index (<https://minecraft.wiki/w/Crafting>) and/or a
   category listing, then extract every `{{Crafting}}` invocation with a real parser —
   **not** a regex over the whole document. Template arguments contain `=` inside links
   and nested templates, so parse balanced braces and handle `{{!}}`, numbered/unnamed
   parameters, and HTML comments.
3. **Reference implementation:** the PrismarineJS
   [`minecraft-wiki-extractor`](https://github.com/PrismarineJS/minecraft-wiki-extractor)
   project extracts structured data from this same wiki and is worth reading for its
   request and parsing approach. You may imitate its technique. **Do not add it as a
   dependency** — the scraper must be our own code so the project stays dependency-free.
4. **Cache everything.** Write raw responses to disk under `tools/cache/wiki/` keyed by
   page title, and make the scraper skip any page already cached unless `--refresh` is
   passed. Re-running the scraper must be free and deterministic.

### Hard requirements for the scraper

- **Rate limit.** At most **1 request per second**, with a descriptive `User-Agent`
  identifying the project and a contact string. Retry with exponential backoff on 429/5xx
  and honour `Retry-After`.
- **Respect `robots.txt`** and stop if it disallows the API path.
- **Bounded scope.** Do not crawl the entire wiki. Fetch only pages that actually define
  crafting recipes, stop at a configured page cap, and log every page fetched.
- **Deterministic output.** The same corpus must produce a byte-identical output file.
  Sort recipes and tags by a stable key before serialising, and normalise whitespace.
- **Offline by design.** The scraper is a development tool run on demand. It is **never**
  invoked at game runtime, and the game must never make a network request. The game loads
  a vendored snapshot committed to the repository.

### Licensing — handle this explicitly, do not skip it

Minecraft Wiki content is licensed **CC BY-NC-SA 3.0** unless otherwise noted
(<https://minecraft.wiki/w/Minecraft_Wiki:Copyrights>, which redirects to
<https://meta.weirdgloop.org/w/Licensing>). Therefore:

- The generated data file must carry an attribution header naming the source, the
  retrieval date, and the licence.
- Add an attribution section to `README.md` and a `NOTICE` file recording the source,
  licence, and that the data is used non-commercially.
- **Do not copy wiki prose, images, or sprites.** Scrape *recipe structure only* —
  which item goes in which slot, in what quantity. All Voxelhaven block names, item
  names, textures and code stay original.
- Flag clearly in your final report that CC BY-NC-SA is a **non-commercial** licence and
  that shipping this data commercially would require re-deriving the corpus.

---

## Part 2 — Data model

Create `src/data/recipes.json` (generated, committed) plus a loader
`src/data/RecipeBook.js`. Required shape:

```jsonc
{
  "source": "Minecraft Wiki (minecraft.wiki), Crafting recipe data",
  "license": "CC BY-NC-SA 3.0",
  "retrieved": "YYYY-MM-DD",
  "tags": { "planks": ["planks"], "any_wool": ["..."] },
  "recipes": [
    {
      "id": "crafting_table",
      "type": "shaped",
      "pattern": ["##", "##"],          // rows, top to bottom; " " = empty
      "key": { "#": ["planks"] },        // symbol -> list of accepted item keys or tag names
      "output": { "item": "crafting_table", "count": 1 },
      "mirrored": true,                  // shaped recipes may be mirrored
      "matching": false                  // "Matching" semantics: all uses must be the same item
    },
    {
      "id": "shapeless_example",
      "type": "shapeless",
      "ingredients": [["fiber"], ["fiber"], ["fiber"]],
      "output": { "item": "canopy", "count": 1 }
    }
  ]
}
```

Normalisation rules, applied once at generation time so runtime stays simple:

- Strip empty border rows and columns from every shaped pattern; record the resulting
  bounding `width`/`height`.
- Collapse wiki ingredient names to Voxelhaven item keys or tag names through an
  explicit, auditable mapping table (`tools/mappings/item-map.json`). A name that maps to
  nothing must be **reported and skipped with a warning**, never silently dropped, and
  the scraper must print a summary of unmapped names so the mapping table can be
  extended.
- Reject any recipe referencing an item that does not exist in Voxelhaven's item
  registry at load time, with a clear error naming the recipe and the missing item.

## Part 3 — Runtime engine

Rewrite `src/systems/Crafting.js` into a real engine. Keep the module DOM-free and free
of side effects so it stays testable and importable from workers.

Required API surface (keep names where they already exist so existing callers and tests
keep working, and extend rather than replace):

- `match(grid, size)` → `{ recipe, output } | null`
  - `grid` is a row-major array of `size * size` slots, each `null` or `{ item, count }`.
  - Shaped matching: normalise the grid's occupied bounding box, compare against the
    pattern, and honour `mirrored` by also testing the horizontally flipped grid. A
    shaped recipe must match **only** the correct arrangement — position matters.
  - Shapeless matching: compare the multiset of ingredients regardless of position.
  - Tag ingredients match any member. `matching: true` ingredients additionally require
    every slot using that symbol to hold the **same** item key.
  - `count` in an input slot means "this many of this item consumed from that slot"
    (used by recipes that consume more than one per slot); default 1.
- `craftFromGrid(grid, size, inventory)` → `{ ok, reason?, output? }`
  - Verifies there is inventory room **before** consuming anything (the existing code
    already gets this right — preserve that property).
  - Consumes exactly one item from each non-empty slot, leaves remainder items
    (e.g. a bucket) in the grid, and returns the output to the player or the grid as
    appropriate.
- `recipesFor(itemKey)` → recipes producing that item, for a recipe browser.
- `canCraft(recipe, inventory)` / `affordableCount(recipe, inventory)` — keep these
  working for the flat-list UI until it is replaced.
- Every recipe gets a stable `id`. Recipes are indexed by output item and by pattern
  signature at load time so `match()` is not a linear scan over the whole corpus on every
  keystroke. Measure and report the match cost.

## Part 4 — Item set expansion

The recipe corpus is useless without a broader item set. Extend
`src/world/Items.js` and `src/world/Blocks.js` with whatever the chosen recipe subset
needs, aiming at a coherent early-to-mid game:

- **Intermediates:** sticks, and at least one metal line (ore → ingot → tools).
- **A crafting table block** — placeable, with its own atlas tile, right-click to open
  the 3×3 grid.
- **Tools** (pickaxe, axe, shovel at minimum; add sword if you add combat scaling),
  with tiers that actually matter: mining speed and which blocks a tool can harvest.
- **A furnace or equivalent** if your chosen subset needs smelting, including a smelting
  system; if you deliberately exclude smelting, say so and gate those recipes out rather
  than shipping recipes that cannot ever complete.
- **A recipe browser** so the player can discover recipes they cannot yet afford.

Every new item needs: a `key`, `name`, `maxStack`, an atlas tile painted procedurally in
`src/render/TextureAtlas.js` (in the existing style — no image files), and save
compatibility. Tool items need durability with `maxStack: 1` and must not stack.

**Item keys are save-format surface.** Adding them is fine. If you must change an
existing key, add a migration in `src/systems/SaveSystem.js` and bump
`SAVE.formatVersion` from 3, and say so explicitly in your report.

## Part 5 — UI

Extend the existing DOM/CSS overlay approach — the UI is plain HTML and CSS, **not**
canvas. There is already a `#craft-list` panel (`InventoryUI.js`,
`index.html`, `styles.css`).

- **Inventory screen:** 27-slot main inventory plus a 2×2 crafting grid and its result
  slot, exactly like the real thing. The result slot previews the output and is
  click-to-take.
- **Crafting table screen:** 3×3 grid plus result slot, opened by right-clicking a placed
  crafting table.
- Reuse the existing held-stack click model and shift-click splitting in
  `InventoryUI.js`. Dragging stacks between the grid and the inventory must work, and
  closing the screen must **return grid contents to the inventory** rather than deleting
  them (and must refuse to close if there is nowhere to put them, or drop them as items —
  pick one behaviour, implement it, and test it).
- Shift-click crafting must craft as many as possible, respecting stack limits.
- Keyboard: `E` toggles the inventory, `Esc` closes, and the grid must be reachable and
  operable without a mouse if the rest of the UI is.
- The result preview must update on every grid mutation — assert this in a test.
- Keep the existing visual language (`--accent`, `--slot-size`, dark slate panels). No
  new CSS framework, no inline styles beyond what already exists.

## Part 6 — Tests

Extend `test/run-tests.mjs`, which currently passes **89 assertions**. Do not weaken or
delete existing assertions. Add coverage for at least:

1. **Shaped matching, position-sensitive.** The same items in the wrong arrangement must
   not match. A mirrored arrangement must match only when `mirrored: true`.
2. **Shapeless matching.** Order-independence, and that a wrong multiset fails.
3. **Tag ingredients.** Any member matches; a non-member does not.
4. **"Matching" semantics.** Two different members of the same tag are rejected when
   `matching: true`, accepted when false.
5. **Grid offset.** A 2×2 pattern placed in any corner of the 3×3 grid must match.
6. **Consumption.** Exactly one item per slot is consumed; a failed craft consumes
   nothing; a full inventory refuses the craft without eating ingredients.
7. **Remainder/container items** survive the craft.
8. **Scraper determinism.** Run the transform twice over the same cached corpus and
   assert byte-identical output. (This must not hit the network — commit the cache or
   generate a small fixture.)
9. **Mapping integrity.** Every item key referenced by the shipped
   `src/data/recipes.json` exists in `ItemRegistry`; every recipe is reachable and no
   recipe has an empty output.
10. **End-to-end journey.** In headless Chrome: harvest materials → craft planks → craft
    a crafting table → place it → open the 3×3 → craft a tool → use it → save → quit →
    load → confirm the crafted items and table survive the round trip.

Use the existing harness (`test/headless.mjs`) and drive input via
`VH.setAction(action, down)` rather than synthetic DOM events. `window.VH` is the debug
API; extend it with whatever the tests need (e.g. `VH.setCraftGrid(...)`,
`VH.getCraftResult()`), and document the additions.

## Deliverables

Report back with:

- The exact wiki endpoints and pages you fetched, how many requests, and the retrieval
  date; plus a copy of the scraper's summary output (pages fetched, recipes extracted,
  recipes mapped, unmapped names skipped).
- The generated `src/data/recipes.json` size and recipe count, and the count of recipes
  that are actually craftable given the shipped item set (a recipe nobody can ever craft
  is a bug — report the number and justify any intentional exclusions).
- The mapping table and an explicit list of wiki ingredients you chose **not** to
  support, with reasons.
- The new file tree and what each new file does.
- Full `node test/run-tests.mjs` output (pass/fail counts).
- A short "how to play it" section for the README covering the new progression.
- `match()` performance numbers, and the size of the generated data file as loaded.

## Constraints

- **Zero runtime dependencies.** No new packages in `package.json` dependencies. If the
  scraper needs an HTML/wikitext parser, write it — do not install one. `puppeteer-core`
  stays dev-only.
- **No build step, no bundler.** `recipes.json` is loaded with `fetch()`/JSON import and
  works when serving the directory as static files.
- **No network at runtime, ever.**
- **No placeholders, no stubs, no `TODO`, no `...` elisions.** Production-quality code
  with comments explaining *why*, matching the existing file style.
- If the full Minecraft recipe corpus cannot be supported because Voxelhaven lacks the
  underlying items, that is expected and fine — but then say so plainly, ship a coherent
  subset that is fully playable end to end, and put the excluded categories in the
  README's known-limitations section. **Do not ship recipe entries that reference items
  that do not exist.**
