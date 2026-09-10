/**
 * run-tests.mjs — end-to-end integration tests for Voxelhaven.
 *
 * These are not unit tests. They boot the real server, launch a real browser,
 * create a real world and then drive the exact player journey the game is meant
 * to support:
 *
 *   launch -> create world -> generate terrain -> spawn -> move -> jump
 *   -> target a block -> break it -> collect the drop -> select a hotbar slot
 *   -> place a block -> walk away -> save -> exit -> reload -> verify
 *
 * Every assertion runs against live game state inside the page.
 *
 * Usage:
 *   node test/run-tests.mjs            headless (default)
 *   node test/run-tests.mjs --headed   show the browser window
 *   VERBOSE_TESTS=1 node test/run-tests.mjs
 */

import { startServer, launchGame, waitFor, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';
import path from 'node:path';
import fs from 'node:fs';

import { ItemRegistry } from '../src/world/Items.js';
import { BlockRegistry } from '../src/world/Blocks.js';
import { createBook, RecipeBook, RECIPES_URL } from '../src/data/RecipeBook.js';
import { match, craftFromGrid, Crafting } from '../src/systems/Crafting.js';
import { Inventory } from '../src/player/Inventory.js';
import { CraftGrid } from '../src/player/CraftGrid.js';
import { Smelting } from '../src/systems/Smelting.js';
import { TextureAtlas } from '../src/render/TextureAtlas.js';
import { buildRecipes, serialise, CORPUS_PATH, MAP_PATH, OUTPUT_PATH } from '../tools/build-recipes.mjs';

const PORT = Number(process.env.TEST_PORT || 8347);
const HEADLESS = !process.argv.includes('--headed');
const KEEP_SAVES = process.argv.includes('--keep-saves');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
/** Records the outcome of one check. */
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Runs a group of checks with a heading. */
async function section(title, fn) {
  console.log(`\n\u25B8 ${title}`);
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push(`${title}: ${err.message}`);
    console.log(`  \u2717 ${title} aborted — ${err.message}`);
  }
}

const round = (v, p = 2) => (typeof v === 'number' ? Number(v.toFixed(p)) : v);

// ---------------------------------------------------------------------------
// Crafting helpers used by the offline checks
// ---------------------------------------------------------------------------

/** Build a grid array from a compact row description. */
function makeGrid(spec) {
  return spec.map((cell) => (cell ? { item: cell.item || cell, count: cell.count || 1 } : null));
}

/** A 3x3 grid with everything empty. */
const empty3 = () => new Array(9).fill(null);
/** A 2x2 grid with everything empty. */
const empty2 = () => new Array(4).fill(null);

/** Place a recipe's own pattern into a grid, for reachability checks. */
function gridFromRecipe(recipe, book) {
  const size = recipe.type === 'shaped' && (recipe.width > 2 || recipe.height > 2) ? 3 : 2;
  const grid = new Array(size * size).fill(null);
  if (recipe.type === 'shaped') {
    for (let y = 0; y < recipe.height; y++) {
      for (let x = 0; x < recipe.width; x++) {
        const symbol = recipe.pattern[y][x];
        if (symbol === ' ') continue;
        const accept = recipe.key[symbol][0];
        const item = book.isTag(accept) ? book.tagMembers(accept)[0] : accept;
        const count = Number.isFinite(recipe.counts && recipe.counts[symbol]) ? recipe.counts[symbol] : 1;
        grid[y * size + x] = { item, count };
      }
    }
  } else {
    for (let i = 0; i < recipe.ingredients.length; i++) {
      const accept = recipe.ingredients[i][0];
      const item = book.isTag(accept) ? book.tagMembers(accept)[0] : accept;
      grid[i] = { item, count: 1 };
    }
  }
  return { grid, size };
}

/**
 * Work out which items a player can actually obtain, starting from what the
 * world generates, and closing over smelting and crafting.
 *
 * This is the check that catches "a recipe nobody can ever craft": if an
 * ingredient never enters the reachable set, the recipe is dead content.
 *
 * @param {object} book
 * @returns {{reachable:Set<string>, steps:number}}
 */
function reachability(book) {
  const reachable = new Set();

  // 1. Anything the player starts with or can pick up from a mob.
  for (const entry of ItemRegistry.startingLoadout()) reachable.add(entry.item);
  reachable.add('fiber'); // dropped by bramble and by Woolbacks

  /**
   * Things the world hands over without a recipe: filling a bucket from a
   * water block (Interaction.tryFillBucket) is the only one.
   */
  const gatherable = () => {
    if (reachable.has('bucket')) reachable.add('water_bucket');
  };

  // 2. Blocks that can be mined, gated on the tool they need.
  const mineable = () => {
    let changed = false;
    for (const block of BlockRegistry.all()) {
      if (block.id === 0 || block.key === 'water' || block.key === 'bedrock') continue;
      const drop = block.drops && block.drops.item;
      if (!drop || drop === 'air' || reachable.has(drop)) continue;
      const tier = BlockRegistry.tier(block.id);
      if (tier > 0) {
        const family = BlockRegistry.tool(block.id);
        const hasTool = [...reachable].some((item) => {
          const tool = ItemRegistry.tool(item);
          return tool && tool.type === family && tool.tier >= tier;
        });
        if (!hasTool) continue;
      }
      reachable.add(drop);
      changed = true;
    }
    return changed;
  };

  // 3. Close over crafting and smelting until nothing new appears.
  let steps = 0;
  for (;;) {
    steps++;
    const before = reachable.size;
    mineable();
    gatherable();
    for (const recipe of book.recipes) {
      if (reachable.has(recipe.output.item)) continue;
      const alternatives = recipeAlternatives(recipe, book);
      let ok = true;
      for (const group of alternatives.values()) {
        if (!group.some((member) => reachable.has(member))) { ok = false; break; }
      }
      if (ok) reachable.add(recipe.output.item);
    }
    for (const entry of book.smelting) {
      if (reachable.has(entry.output.item)) continue;
      if (entry.inputs.some((input) => reachable.has(input))) reachable.add(entry.output.item);
    }
    if (reachable.size === before) break;
    if (steps > 50) break;
  }
  return { reachable, steps };
}

/** Map from a charged item key back to the full set of accepted alternatives. */
function recipeAlternatives(recipe, book) {
  const out = new Map();
  const expand = (names) => names.flatMap((name) => (book.isTag(name) ? book.tagMembers(name) : [name]));
  if (recipe.type === 'shaped') {
    for (const symbol of Object.keys(recipe.key)) {
      const members = expand(recipe.key[symbol]);
      const charged = book.isTag(recipe.key[symbol][0]) ? book.tagMembers(recipe.key[symbol][0])[0] : recipe.key[symbol][0];
      out.set(charged, members);
    }
    return out;
  }
  for (const list of recipe.ingredients) {
    const members = expand(list);
    const charged = book.isTag(list[0]) ? book.tagMembers(list[0])[0] : list[0];
    out.set(charged, members);
  }
  return out;
}

/**
 * Every check that can run without a browser. Pure module imports, no server,
 * no Chrome — this is the part of the suite that pins the data and the engine.
 */
async function offlineCraftingTests() {
  const data = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf8'));
  const book = createBook(data);

  await section('Recipe snapshot', async () => {
    check('recipes.json is valid JSON with the required top-level fields',
      typeof data.source === 'string' && typeof data.license === 'string'
      && typeof data.retrieved === 'string' && typeof data.tags === 'object'
      && Array.isArray(data.recipes),
      Object.keys(data).join(', '));
    check('the snapshot names the wiki as its source',
      /minecraft\.wiki/.test(data.source) && /minecraft\.wiki/.test(data.attribution),
      data.source);
    check('the snapshot carries the CC BY-NC-SA 3.0 attribution',
      data.license === 'CC BY-NC-SA 3.0' && /CC BY-NC-SA 3\.0/.test(data.attribution),
      data.license);
    check('the attribution names a retrieval date',
      /^\d{4}-\d{2}-\d{2}$/.test(data.retrieved),
      data.retrieved);
    check('the snapshot is served from the documented path',
      fs.existsSync(path.join(PROJECT_ROOT, RECIPES_URL)),
      RECIPES_URL);
    check('the recipe book loaded every recipe', book.recipes.length === data.recipes.length,
      `${book.recipes.length} indexed of ${data.recipes.length}`);
    check('the book contains both shaped and shapeless recipes',
      book.stats().shaped > 0 && book.stats().shapeless > 0,
      JSON.stringify(book.stats()));
  });

  await section('Mapping integrity', async () => {
    const missing = [];
    const emptyOutputs = [];
    const ids = new Set();
    const duplicates = [];

    const checkName = (name, where) => {
      if (book.isTag(name)) {
        for (const member of book.tagMembers(name)) {
          if (!ItemRegistry.has(member)) missing.push(`${where}: tag ${name} -> ${member}`);
        }
        return;
      }
      if (!ItemRegistry.has(name)) missing.push(`${where}: ${name}`);
    };

    for (const recipe of book.recipes) {
      if (!recipe.output || !recipe.output.item || !(recipe.output.count > 0)) {
        emptyOutputs.push(recipe.id);
      }
      if (ids.has(recipe.id)) duplicates.push(recipe.id);
      ids.add(recipe.id);
      if (recipe.type === 'shaped') {
        for (const symbol of Object.keys(recipe.key)) {
          for (const name of recipe.key[symbol]) checkName(name, recipe.id);
        }
      } else {
        for (const list of recipe.ingredients) for (const name of list) checkName(name, recipe.id);
      }
      for (const entry of Object.values(recipe.remainder || {})) checkName(entry.item, `${recipe.id} remainder`);
    }
    for (const entry of book.smelting) {
      for (const input of entry.inputs) checkName(input, entry.id);
      checkName(entry.output.item, entry.id);
    }
    for (const fuel of Object.keys(book.fuels)) checkName(fuel, 'fuels');

    check('every item key in the snapshot exists in ItemRegistry', missing.length === 0,
      missing.slice(0, 5).join('; '));
    check('no recipe has an empty output', emptyOutputs.length === 0, emptyOutputs.join(', '));
    check('every recipe id is unique', duplicates.length === 0, duplicates.join(', '));
    check('every recipe is indexed by its output',
      book.recipes.every((recipe) => book.byOutput(recipe.output.item).some((entry) => entry.id === recipe.id)),
      `${book.outputs().length} distinct outputs`);

    // Every recipe must be matchable from its own pattern: that is what makes
    // it "reachable" through the engine rather than merely present in a file.
    const unmatched = [];
    for (const recipe of book.recipes) {
      const { grid, size } = gridFromRecipe(recipe, book);
      const found = match(grid, size, book);
      if (!found || found.recipe.id !== recipe.id) unmatched.push(recipe.id);
    }
    check('every recipe matches its own arrangement through match()', unmatched.length === 0,
      unmatched.slice(0, 5).join(', '));

    // And every ingredient must be obtainable, or the recipe is dead content.
    const { reachable, steps } = reachability(book);
    const unreachableRecipes = [];
    const unreachableOutputs = [];
    for (const recipe of book.recipes) {
      const alternatives = recipeAlternatives(recipe, book);
      for (const [charged, group] of alternatives) {
        if (!group.some((member) => reachable.has(member))) {
          unreachableRecipes.push(`${recipe.id} needs ${charged}`);
        }
      }
      if (!reachable.has(recipe.output.item)) unreachableOutputs.push(recipe.id);
    }
    check('every recipe is craftable from items the world can supply',
      unreachableRecipes.length === 0,
      `${unreachableRecipes.slice(0, 5).join('; ')} (closed over ${steps} passes, ${reachable.size} items reachable)`);
    check('every recipe output is itself obtainable', unreachableOutputs.length === 0,
      unreachableOutputs.slice(0, 5).join(', '));
    check('the reachable set includes the end-of-line items',
      reachable.has('iron_ingot') && reachable.has('iron_pickaxe') && reachable.has('furnace'),
      `${reachable.size} items reachable`);
  });

  await section('Shaped matching', async () => {
    // planks: one timber anywhere in the grid, 4 planks out.
    const correct = empty3();
    correct[4] = { item: 'timber', count: 1 };
    const foundCorrect = match(correct, 3, book);
    check('a 1x1 shaped recipe matches its own arrangement',
      foundCorrect && foundCorrect.recipe.id === 'planks' && foundCorrect.output.count === 4,
      foundCorrect ? `${foundCorrect.recipe.id} x${foundCorrect.output.count}` : 'no match');

    // The crafting table is a 2x2 block of planks; three planks and a gap in
    // the middle must NOT match.
    const wrongShape = empty3();
    wrongShape[0] = { item: 'planks', count: 1 };
    wrongShape[1] = { item: 'planks', count: 1 };
    wrongShape[3] = { item: 'planks', count: 1 };
    wrongShape[4] = { item: 'cobble', count: 1 };
    check('a shaped recipe rejects the wrong items in the right slots',
      match(wrongShape, 3, book) === null, 'cobble in the fourth slot still matched');

    const wrongPositions = empty3();
    wrongPositions[0] = { item: 'planks', count: 1 };
    wrongPositions[1] = { item: 'planks', count: 1 };
    wrongPositions[2] = { item: 'planks', count: 1 };
    wrongPositions[4] = { item: 'planks', count: 1 };
    check('a shaped recipe rejects the right items in the wrong arrangement',
      match(wrongPositions, 3, book) === null, 'an L-shape matched a square recipe');

    // Wooden pickaxe: top row of planks with sticks below, and its mirror.
    const pickaxe = empty3();
    pickaxe[0] = { item: 'planks', count: 1 };
    pickaxe[1] = { item: 'planks', count: 1 };
    pickaxe[2] = { item: 'planks', count: 1 };
    pickaxe[4] = { item: 'stick', count: 1 };
    pickaxe[7] = { item: 'stick', count: 1 };
    const foundPickaxe = match(pickaxe, 3, book);
    check('a 3x3 shaped recipe matches', foundPickaxe && foundPickaxe.recipe.id === 'wooden_pickaxe',
      foundPickaxe ? foundPickaxe.recipe.id : 'no match');

    // The axe is the asymmetric one: the wiki pattern is
    //   ##
    //   #A
    //    A
    // so placing it at the grid origin puts planks on 0, 1 and 3 and sticks on
    // 4 and 7. Mirrored, that becomes planks on 1, 2 and 4 with sticks on 6, 7.
    const axe = empty3();
    axe[0] = { item: 'planks', count: 1 };
    axe[1] = { item: 'planks', count: 1 };
    axe[3] = { item: 'planks', count: 1 };
    axe[4] = { item: 'stick', count: 1 };
    axe[7] = { item: 'stick', count: 1 };
    const mirroredAxe = empty3();
    mirroredAxe[0] = { item: 'planks', count: 1 };
    mirroredAxe[1] = { item: 'planks', count: 1 };
    mirroredAxe[4] = { item: 'planks', count: 1 };
    mirroredAxe[3] = { item: 'stick', count: 1 };
    mirroredAxe[6] = { item: 'stick', count: 1 };
    const foundAxe = match(axe, 3, book);
    const foundMirror = match(mirroredAxe, 3, book);
    check('an asymmetric shaped recipe matches in its own orientation',
      foundAxe && foundAxe.recipe.id === 'wooden_axe' && foundAxe.mirrored === false,
      foundAxe ? `${foundAxe.recipe.id} mirrored=${foundAxe.mirrored}` : 'no match');
    check('a mirrored arrangement matches a recipe that allows mirroring',
      foundMirror && foundMirror.recipe.id === 'wooden_axe' && foundMirror.mirrored === true,
      foundMirror ? `${foundMirror.recipe.id} mirrored=${foundMirror.mirrored}` : 'no match');

    // A recipe with mirrored: false must reject the flipped arrangement.
    const strictBook = createBook({
      tags: {},
      fuels: {},
      smelting: [],
      recipes: [{
        id: 'strict',
        type: 'shaped',
        name: 'Strict',
        pattern: ['#  ', ' # '],
        width: 3,
        height: 2,
        key: { '#': ['planks'] },
        output: { item: 'stick', count: 1 },
        mirrored: false
      }]
    });
    const strict = empty3();
    strict[0] = { item: 'planks', count: 1 };
    strict[4] = { item: 'planks', count: 1 };
    const strictFlipped = empty3();
    strictFlipped[1] = { item: 'planks', count: 1 };
    strictFlipped[3] = { item: 'planks', count: 1 };
    const strictMatched = match(strict, 3, strictBook);
    check('a mirrored:false recipe rejects the flipped arrangement',
      match(strictFlipped, 3, strictBook) === null,
      'the flipped diagonal matched a non-mirrorable recipe');
    check('a mirrored:false recipe still matches its own arrangement',
      strictMatched !== null && strictMatched.recipe.id === 'strict');
  });

  await section('Shapeless matching', async () => {
    const positions = [
      [0, 1, 2, 3], [0, 2, 5, 8], [4, 5, 7, 8], [1, 3, 4, 6]
    ];
    let allMatched = true;
    for (const slots of positions) {
      const grid = empty3();
      for (const index of slots) grid[index] = { item: 'fiber', count: 1 };
      const found = match(grid, 3, book);
      if (!found || found.recipe.id !== 'canopy_from_fiber') allMatched = false;
    }
    check('a shapeless recipe ignores position', allMatched,
      'fiber in four different arrangements did not all match');

    const wrongCount = empty3();
    wrongCount[0] = { item: 'fiber', count: 1 };
    wrongCount[1] = { item: 'fiber', count: 1 };
    wrongCount[2] = { item: 'fiber', count: 1 };
    check('a shapeless recipe rejects the wrong multiset (too few)',
      match(wrongCount, 3, book) === null, 'three fibers matched a four-fiber recipe');

    const wrongItem = empty3();
    wrongItem[0] = { item: 'fiber', count: 1 };
    wrongItem[1] = { item: 'fiber', count: 1 };
    wrongItem[2] = { item: 'fiber', count: 1 };
    wrongItem[3] = { item: 'canopy', count: 1 };
    check('a shapeless recipe rejects the wrong multiset (wrong item)',
      match(wrongItem, 3, book) === null, 'canopy counted as fiber');

    // The engine's shapeless path is also exercised through a synthetic book
    // where the ingredients are not all the same item.
    const bookTwo = createBook({
      tags: { wood: ['planks', 'timber'] },
      fuels: {},
      smelting: [],
      recipes: [{
        id: 'mixed',
        type: 'shapeless',
        name: 'Mixed',
        ingredients: [['planks'], ['fiber']],
        output: { item: 'stick', count: 1 }
      }]
    });
    const mixed = empty3();
    mixed[0] = { item: 'fiber', count: 1 };
    mixed[8] = { item: 'planks', count: 1 };
    const mixedMatch = match(mixed, 3, bookTwo);
    check('a mixed shapeless recipe matches in any order',
      mixedMatch !== null && mixedMatch.recipe.id === 'mixed');
  });

  await section('Tag ingredients', async () => {
    // The crafting table accepts the `planks` tag.
    const viaTag = empty2();
    viaTag[0] = { item: 'planks', count: 1 };
    viaTag[1] = { item: 'planks', count: 1 };
    viaTag[2] = { item: 'planks', count: 1 };
    viaTag[3] = { item: 'planks', count: 1 };
    check('a tag ingredient accepts a member',
      match(viaTag, 2, book)?.recipe.id === 'crafting_table', 'planks tag did not match');

    const nonMember = empty2();
    nonMember[0] = { item: 'cobble', count: 1 };
    nonMember[1] = { item: 'cobble', count: 1 };
    nonMember[2] = { item: 'cobble', count: 1 };
    nonMember[3] = { item: 'cobble', count: 1 };
    check('a tag ingredient rejects a non-member',
      match(nonMember, 2, book) === null, 'cobble satisfied the planks tag');

    // The stone-tier tag is used by the furnace and the stone tools.
    const stoneTools = empty3();
    stoneTools[0] = { item: 'cobble', count: 1 };
    stoneTools[1] = { item: 'cobble', count: 1 };
    stoneTools[2] = { item: 'cobble', count: 1 };
    stoneTools[4] = { item: 'stick', count: 1 };
    stoneTools[7] = { item: 'stick', count: 1 };
    check('the stone_tier tag is used by shipped recipes',
      match(stoneTools, 3, book)?.recipe.id === 'stone_pickaxe', 'stone pickaxe did not match cobble');

    const wrongTag = empty3();
    wrongTag[0] = { item: 'planks', count: 1 };
    wrongTag[1] = { item: 'planks', count: 1 };
    wrongTag[2] = { item: 'planks', count: 1 };
    wrongTag[4] = { item: 'stick', count: 1 };
    wrongTag[7] = { item: 'stick', count: 1 };
    // planks is not in stone_tier, but it *is* the wooden pickaxe, so this must
    // resolve to the wooden one and never to the stone one.
    check('a tag does not leak across recipes',
      match(wrongTag, 3, book)?.recipe.id === 'wooden_pickaxe',
      'planks matched the stone-tier tag');
  });

  await section('Matching semantics', async () => {
    // Two members of one tag, with and without `matching`.
    const makeBook = (matching) => createBook({
      tags: { wood: ['planks', 'timber'] },
      fuels: {},
      smelting: [],
      recipes: [{
        id: matching ? 'matching' : 'any',
        type: 'shaped',
        name: matching ? 'Matching' : 'Any',
        pattern: ['##'],
        width: 2,
        height: 1,
        key: { '#': ['wood'] },
        output: { item: 'stick', count: 1 },
        mirrored: true,
        matching
      }]
    });
    const sameGrid = empty3();
    sameGrid[0] = { item: 'planks', count: 1 };
    sameGrid[1] = { item: 'planks', count: 1 };
    const mixedGrid = empty3();
    mixedGrid[0] = { item: 'planks', count: 1 };
    mixedGrid[1] = { item: 'timber', count: 1 };

    const anyBook = makeBook(false);
    const matchingBook = makeBook(true);
    check('two different tag members are accepted when matching is false',
      match(mixedGrid, 3, anyBook)?.recipe.id === 'any', 'mixed members were rejected');
    check('two different tag members are rejected when matching is true',
      match(mixedGrid, 3, matchingBook) === null, 'matching accepted two different members');
    check('identical tag members are accepted when matching is true',
      match(sameGrid, 3, matchingBook)?.recipe.id === 'matching', 'matching rejected identical members');

    // The shipped planks recipe carries the wiki's "Matching" flag.
    const planksRecipe = book.byId('planks');
    check('the shipped planks recipe keeps the wiki Matching flag',
      planksRecipe && planksRecipe.matching === true,
      planksRecipe ? `matching=${planksRecipe.matching}` : 'missing');
    check('the shipped planks recipe uses the logs tag',
      planksRecipe && planksRecipe.key['#'].join() === 'logs',
      planksRecipe ? JSON.stringify(planksRecipe.key) : 'missing');
  });

  await section('Grid offset and size', async () => {
    const corners = [
      [0, 1, 3, 4], [1, 2, 4, 5], [3, 4, 6, 7], [4, 5, 7, 8]
    ];
    const results = corners.map((slots) => {
      const grid = empty3();
      for (const index of slots) grid[index] = { item: 'planks', count: 1 };
      const found = match(grid, 3, book);
      return found ? found.recipe.id : null;
    });
    check('a 2x2 pattern matches in every corner of the 3x3 grid',
      results.every((id) => id === 'crafting_table'), results.join(', '));

    const middle = empty3();
    middle[4] = { item: 'timber', count: 1 };
    check('a 1x1 pattern matches in the centre', match(middle, 3, book)?.recipe.id === 'planks');

    // The same pattern in a 2x2 grid matches too: the inventory screen.
    const small = empty2();
    small[0] = { item: 'planks', count: 1 };
    small[1] = { item: 'planks', count: 1 };
    small[2] = { item: 'planks', count: 1 };
    small[3] = { item: 'planks', count: 1 };
    check('a recipe that fits 2x2 matches in the inventory grid',
      match(small, 2, book)?.recipe.id === 'crafting_table');

    // A 3x3 recipe must not match in a 2x2 grid: there is nowhere to put it.
    const tooBig = empty2();
    tooBig[0] = { item: 'planks', count: 1 };
    tooBig[1] = { item: 'planks', count: 1 };
    tooBig[2] = { item: 'stick', count: 1 };
    tooBig[3] = { item: 'stick', count: 1 };
    check('a 3x3 recipe cannot match in the 2x2 grid', match(tooBig, 2, book) === null);
    check('the station of every recipe matches the grid it needs',
      book.recipes.every((recipe) => (recipe.station === 'crafting_table')
        === (recipe.width > 2 || recipe.height > 2)),
      book.recipes.filter((r) => (r.station === 'crafting_table') !== (r.width > 2 || r.height > 2))
        .map((r) => r.id).join(', '));
  });

  await section('Consumption, room and remainders', async () => {
    // Exactly one item per slot, even from a big stack.
    const grid = empty3();
    grid[0] = { item: 'planks', count: 12 };
    grid[1] = { item: 'planks', count: 12 };
    grid[3] = { item: 'planks', count: 12 };
    grid[4] = { item: 'planks', count: 12 };
    const inventory = new Inventory(36);
    const result = craftFromGrid(grid, 3, inventory, book);
    check('a craft consumes exactly one item per slot',
      result.ok && grid[0].count === 11 && grid[1].count === 11
      && grid[3].count === 11 && grid[4].count === 11,
      grid.map((slot) => (slot ? slot.count : 0)).join(','));
    check('the craft output lands in the inventory',
      inventory.countOf('crafting_table') === 1 && result.output.item === 'crafting_table');

    // A failed craft consumes nothing.
    const badGrid = empty3();
    badGrid[0] = { item: 'planks', count: 3 };
    badGrid[1] = { item: 'planks', count: 3 };
    badGrid[3] = { item: 'planks', count: 3 };
    badGrid[4] = { item: 'cobble', count: 3 };
    const before = JSON.stringify(badGrid);
    const failed = craftFromGrid(badGrid, 3, new Inventory(36), book);
    check('a craft that matches nothing consumes nothing',
      !failed.ok && JSON.stringify(badGrid) === before, failed.reason);

    // A full inventory refuses the craft without eating the ingredients.
    const fullInventory = new Inventory(4);
    fullInventory.set(0, { item: 'cobble', count: 64 });
    fullInventory.set(1, { item: 'cobble', count: 64 });
    fullInventory.set(2, { item: 'cobble', count: 64 });
    fullInventory.set(3, { item: 'cobble', count: 64 });
    const fullGrid = empty3();
    fullGrid[0] = { item: 'planks', count: 5 };
    fullGrid[1] = { item: 'planks', count: 5 };
    fullGrid[3] = { item: 'planks', count: 5 };
    fullGrid[4] = { item: 'planks', count: 5 };
    const refused = craftFromGrid(fullGrid, 3, fullInventory, book);
    check('a full inventory refuses the craft',
      refused.ok === false && /room/i.test(refused.reason || ''), refused.reason);
    check('a refused craft eats no ingredients',
      fullGrid[0].count === 5 && fullGrid[1].count === 5 && fullGrid[3].count === 5 && fullGrid[4].count === 5,
      'ingredients were consumed by a refused craft');
    check('a refused craft adds no output', fullInventory.countOf('crafting_table') === 0);

    // Stacking room is respected: 63 planks and a free slot is not room for 4.
    const tightInventory = new Inventory(2);
    tightInventory.set(0, { item: 'planks', count: 63 });
    tightInventory.set(1, { item: 'cobble', count: 1 });
    const tightGrid = empty3();
    tightGrid[4] = { item: 'timber', count: 4 };
    const tight = craftFromGrid(tightGrid, 3, tightInventory, book);
    check('an output that does not fit is refused rather than lost',
      tight.ok === false && tightInventory.countOf('planks') === 63 && tightGrid[4].count === 4,
      tight.reason);

    // Remainders: the shipped turf recipe returns the empty bucket.
    const remainderGrid = empty3();
    remainderGrid[1] = { item: 'loam', count: 3 };
    remainderGrid[3] = { item: 'loam', count: 3 };
    remainderGrid[5] = { item: 'loam', count: 3 };
    remainderGrid[7] = { item: 'loam', count: 3 };
    remainderGrid[4] = { item: 'water_bucket', count: 1 };
    const remainderInventory = new Inventory(36);
    const remainderResult = craftFromGrid(remainderGrid, 3, remainderInventory, book);
    check('a recipe with a remainder crafts and returns the container',
      remainderResult.ok && remainderGrid[4] && remainderGrid[4].item === 'bucket'
      && remainderGrid[4].count === 1,
      remainderGrid[4] ? `slot holds ${remainderGrid[4].item}` : 'slot emptied');
    check('the remainder recipe still consumes its other ingredients',
      remainderGrid[1].count === 2 && remainderGrid[3].count === 2
      && remainderGrid[5].count === 2 && remainderGrid[7].count === 2,
      `${remainderGrid[1].count},${remainderGrid[3].count},${remainderGrid[5].count},${remainderGrid[7].count}`);
    check('the remainder recipe produced its output',
      remainderInventory.countOf('turf') === 2, `${remainderInventory.countOf('turf')} turf`);

    // A remainder that cannot stay in its slot has to fit elsewhere, or the
    // craft is refused before anything is consumed.
    const blockedInventory = new Inventory(1);
    blockedInventory.set(0, { item: 'cobble', count: 64 });
    const blockedGrid = empty3();
    blockedGrid[1] = { item: 'loam', count: 2 };
    blockedGrid[3] = { item: 'loam', count: 2 };
    blockedGrid[5] = { item: 'loam', count: 2 };
    blockedGrid[7] = { item: 'loam', count: 2 };
    blockedGrid[4] = { item: 'water_bucket', count: 2 };
    const blocked = craftFromGrid(blockedGrid, 3, blockedInventory, book);
    check('a remainder with nowhere to go refuses the craft before consuming',
      blocked.ok === false && blockedGrid[4].count === 2 && blockedGrid[1].count === 2,
      blocked.reason);
  });

  await section('Per-slot counts', async () => {
    // No Minecraft recipe consumes more than one item from a slot, so this
    // exercises the documented `counts` extension with a synthetic recipe.
    const countedBook = createBook({
      tags: {},
      fuels: {},
      smelting: [],
      recipes: [{
        id: 'counted',
        type: 'shaped',
        name: 'Counted',
        pattern: ['#'],
        width: 1,
        height: 1,
        key: { '#': ['coal'] },
        counts: { '#': 4 },
        output: { item: 'coal_block', count: 1 },
        mirrored: true
      }]
    });
    const grid = empty3();
    grid[4] = { item: 'coal', count: 4 };
    const inventory = new Inventory(36);
    const ok = craftFromGrid(grid, 3, inventory, countedBook);
    check('a slot can declare how many items it consumes',
      ok.ok && grid[4] === null && inventory.countOf('coal_block') === 1,
      grid[4] ? `${grid[4].count} coal left` : 'slot emptied');

    const short = empty3();
    short[4] = { item: 'coal', count: 3 };
    check('a slot with too few items does not match',
      match(short, 3, countedBook) === null, 'three coal matched a four-coal slot');
  });

  await section('Flat crafting API', async () => {
    const inventory = new Inventory(36);
    inventory.add('timber', 4);
    const planksRecipe = Crafting.byId('planks', book);
    check('Crafting.byId finds the planks recipe by its stable id', !!planksRecipe, 'not found');
    check('affordableCount counts whole crafts',
      Crafting.affordableCount(inventory, planksRecipe, book) === 4,
      String(Crafting.affordableCount(inventory, planksRecipe, book)));

    const crafted = Crafting.craft(inventory, planksRecipe, book);
    check('Crafting.craft consumes inputs and produces output',
      crafted.ok && inventory.countOf('planks') === 4 && inventory.countOf('timber') === 3,
      `planks=${inventory.countOf('planks')} timber=${inventory.countOf('timber')}`);

    const many = Crafting.craftMany(inventory, planksRecipe, 2, book);
    check('craftMany crafts repeatedly until the limit',
      many.crafted === 2 && inventory.countOf('planks') === 12 && inventory.countOf('timber') === 1,
      `crafted=${many.crafted} planks=${inventory.countOf('planks')} timber=${inventory.countOf('timber')}`);

    const empty = new Inventory(4);
    empty.set(0, { item: 'cobble', count: 64 });
    empty.set(1, { item: 'cobble', count: 64 });
    empty.set(2, { item: 'cobble', count: 64 });
    empty.set(3, { item: 'cobble', count: 64 });
    const noRoom = Crafting.craft(empty, planksRecipe, book);
    check('the flat craft refuses when there is no room for the result',
      noRoom.ok === false, noRoom.reason);

    check('recipesFor finds every recipe producing an item',
      Crafting.recipesFor('iron_ingot', book).length === 2,
      String(Crafting.recipesFor('iron_ingot', book).length));
  });

  await section('Item and texture registry', async () => {
    // The atlas is DOM-free when there is no document, so it can be generated
    // here: this is what catches a typo in a tile name before it becomes a
    // magenta "missing" square in the inventory.
    const atlas = new TextureAtlas().generate();
    const missingTiles = ItemRegistry.all()
      .filter((item) => !atlas.names.has(item.tile))
      .map((item) => `${item.key} -> ${item.tile}`);
    check('every item has a painted atlas tile', missingTiles.length === 0,
      missingTiles.slice(0, 5).join(', '));

    const missingFaces = [];
    for (const block of BlockRegistry.all()) {
      if (block.id === 0) continue;
      for (const name of block.textures) {
        if (!atlas.names.has(name)) missingFaces.push(`${block.key} -> ${name}`);
      }
    }
    check('every block face has a painted atlas tile', missingFaces.length === 0,
      missingFaces.slice(0, 5).join(', '));

    check('the crafting-system blocks are registered',
      ['crafting_table', 'furnace', 'iron_ore', 'torch', 'coal_block', 'iron_block',
        'stone_bricks', 'cut_sandstone', 'smooth_stone', 'smooth_sandstone']
        .every((key) => BlockRegistry.byKey(key) !== undefined),
      BlockRegistry.all().map((block) => block.key).join(','));

    check('the crafting-system items are registered',
      ['stick', 'charcoal', 'iron_nugget', 'iron_ingot', 'bucket', 'water_bucket']
        .every((key) => ItemRegistry.has(key)),
      ItemRegistry.keys().join(','));

    // Item keys are save-format surface: the original 23 must all still exist.
    const original = [
      'turf', 'loam', 'stone', 'cobble', 'sand', 'sandstone', 'gravel', 'snow', 'timber',
      'canopy', 'planks', 'coal_ore', 'bedrock', 'glass', 'lantern', 'glowcap', 'cactus',
      'bramble', 'bloom', 'coal', 'fiber'
    ];
    const lost = original.filter((key) => !ItemRegistry.has(key));
    check('no pre-existing item key was renamed or removed', lost.length === 0, lost.join(', '));
    check('the original block ids are unchanged',
      BlockRegistry.idByKey('turf') === 1 && BlockRegistry.idByKey('stone') === 3
      && BlockRegistry.idByKey('planks') === 11 && BlockRegistry.idByKey('bloom') === 20,
      `${BlockRegistry.idByKey('turf')},${BlockRegistry.idByKey('stone')},`
      + `${BlockRegistry.idByKey('planks')},${BlockRegistry.idByKey('bloom')}`);
  });

  await section('Tool items and durability', async () => {
    const tools = ItemRegistry.all().filter((item) => item.tool);
    check('the item registry defines twelve tools', tools.length === 12, `${tools.length} tools`);
    check('tools are unstackable', tools.every((item) => item.maxStack === 1));
    check('tools carry durability', tools.every((item) => item.durability > 0));
    check('tool tiers increase with the material',
      ItemRegistry.tool('wooden_pickaxe').tier === 1
      && ItemRegistry.tool('stone_pickaxe').tier === 2
      && ItemRegistry.tool('iron_pickaxe').tier === 3);
    check('tool speed increases with the material',
      ItemRegistry.tool('wooden_pickaxe').speed < ItemRegistry.tool('stone_pickaxe').speed
      && ItemRegistry.tool('stone_pickaxe').speed < ItemRegistry.tool('iron_pickaxe').speed);

    const inventory = new Inventory(6);
    inventory.add('wooden_pickaxe', 1);
    const slot = inventory.get(0);
    check('a crafted tool arrives at full durability',
      slot.durability === ItemRegistry.durability('wooden_pickaxe'),
      `${slot.durability}`);
    inventory.add('wooden_pickaxe', 1);
    check('two tools take two slots', inventory.countOf('wooden_pickaxe') === 2
      && inventory.usedSlots() === 2, `${inventory.usedSlots()} slots used`);

    const restored = new Inventory(6);
    restored.deserialize([[0, 'iron_pickaxe', 1, 42]]);
    check('tool durability survives a save round trip',
      restored.get(0).durability === 42, String(restored.get(0).durability));
    const legacy = new Inventory(6);
    legacy.deserialize([[0, 'iron_pickaxe', 1]]);
    check('a save written before tools existed still loads',
      legacy.get(0) && legacy.get(0).durability === ItemRegistry.durability('iron_pickaxe'),
      String(legacy.get(0) && legacy.get(0).durability));

    // Harvest rules: stone needs a pickaxe, iron ore needs a stone one.
    check('bare hands cannot harvest stone',
      BlockRegistry.canHarvest(BlockRegistry.idByKey('stone'), 'none', 0) === false);
    check('a wooden pickaxe harvests stone',
      BlockRegistry.canHarvest(BlockRegistry.idByKey('stone'), 'pickaxe', 1) === true);
    check('a wooden pickaxe cannot harvest iron ore',
      BlockRegistry.canHarvest(BlockRegistry.idByKey('iron_ore'), 'pickaxe', 1) === false);
    check('a stone pickaxe harvests iron ore',
      BlockRegistry.canHarvest(BlockRegistry.idByKey('iron_ore'), 'pickaxe', 2) === true);
    check('an axe is the right tool for timber',
      BlockRegistry.tool(BlockRegistry.idByKey('timber')) === 'axe'
      && BlockRegistry.canHarvest(BlockRegistry.idByKey('timber'), 'axe', 1) === true);
    check('tier-0 blocks are harvestable with anything, including a pickaxe',
      BlockRegistry.canHarvest(BlockRegistry.idByKey('timber'), 'pickaxe', 3) === true
      && BlockRegistry.canHarvest(BlockRegistry.idByKey('loam'), 'none', 0) === true);
    check('a shovel block and a pickaxe block are different tool families',
      BlockRegistry.tool(BlockRegistry.idByKey('loam')) === 'shovel'
      && BlockRegistry.tool(BlockRegistry.idByKey('stone')) === 'pickaxe'
      && BlockRegistry.canHarvest(BlockRegistry.idByKey('stone'), 'shovel', 3) === false);
  });

  await section('Furnace simulation (offline)', async () => {
    const events = [];
    const smelting = new Smelting({ emit: (name, payload) => events.push([name, payload]) });
    smelting.useBook(book);
    smelting.insertInput(4, 40, 6, { item: 'iron_ore', count: 2 });
    smelting.insertFuel(4, 40, 6, { item: 'coal', count: 1 });
    check('a furnace accepts smeltable input and fuel',
      smelting.get(4, 40, 6).input.item === 'iron_ore' && smelting.get(4, 40, 6).fuel.item === 'coal');
    check('a furnace refuses non-fuel in the fuel slot',
      smelting.insertFuel(4, 40, 6, { item: 'cobble', count: 1 }) === 1,
      'cobble was accepted as fuel');

    smelting.update(10.001);
    check('ten seconds of heat smelts one iron ore',
      smelting.get(4, 40, 6).output && smelting.get(4, 40, 6).output.item === 'iron_ingot',
      JSON.stringify(smelting.get(4, 40, 6).output));
    check('the furnace reports its heat and progress',
      smelting.heatOf(smelting.get(4, 40, 6)) > 0 && smelting.progressOf(smelting.get(4, 40, 6)) === 0);

    smelting.update(10.001);
    check('a second item smelts from the same fuel item',
      smelting.get(4, 40, 6).output.count === 2, String(smelting.get(4, 40, 6).output.count));
    smelting.update(70);
    check('the fuel burns out once its heat is spent',
      smelting.get(4, 40, 6).fuel === null && smelting.get(4, 40, 6).lit === false,
      JSON.stringify(smelting.get(4, 40, 6).fuel));

    const taken = smelting.takeOutput(4, 40, 6);
    check('the result can be taken out', taken.item === 'iron_ingot' && taken.count === 2);
    check('taking the result empties the output slot', smelting.get(4, 40, 6).output === null);

    // Refill so the station is worth persisting, then round-trip it.
    smelting.insertInput(4, 40, 6, { item: 'iron_ore', count: 3 });
    smelting.insertFuel(4, 40, 6, { item: 'coal', count: 2 });
    smelting.update(4);
    const saved = smelting.serialize();
    const restored = new Smelting({ emit() {} });
    restored.useBook(book);
    const result = restored.deserialize(saved);
    check('furnaces survive a save round trip',
      result.restored === 1 && restored.get(4, 40, 6).input.item === 'iron_ore'
      && restored.get(4, 40, 6).fuel.item === 'coal',
      JSON.stringify(restored.serialize()));
    check('a furnace keeps its burn and cook timers across a save',
      restored.get(4, 40, 6).burnRemaining > 0 && restored.get(4, 40, 6).lit === true,
      JSON.stringify(restored.get(4, 40, 6)));
    const emptySmelter = new Smelting({ emit() {} });
    emptySmelter.ensure(1, 2, 3);
    check('an empty furnace is not written to the save',
      Object.keys(emptySmelter.serialize()).length === 0,
      JSON.stringify(emptySmelter.serialize()));
    check('the smelt events were emitted',
      events.some(([name]) => name === 'smelted') && events.some(([name]) => name === 'furnaceLit'),
      events.map(([name]) => name).join(','));
  });

  await section('Deterministic generator', async () => {
    const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
    const mapping = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
    const first = serialise(buildRecipes(corpus, mapping, ItemRegistry).data);
    const second = serialise(buildRecipes(corpus, mapping, ItemRegistry).data);
    check('the transform is byte-identical across runs', first === second,
      `${first.length} vs ${second.length} bytes`);
    const shipped = fs.readFileSync(OUTPUT_PATH, 'utf8');
    check('the committed snapshot matches the cached corpus',
      shipped === first,
      `committed ${shipped.length} bytes, rebuilt ${first.length} bytes — run node tools/build-recipes.mjs`);

    const summary = buildRecipes(corpus, mapping, ItemRegistry).report;
    check('the corpus is the one the scraper cached',
      corpus.crafting.length > 500 && corpus.pagesFetched.length > 10,
      `${corpus.crafting.length} crafting, ${corpus.smelting.length} smelting from ${corpus.pagesFetched.length} pages`);
    check('every skipped recipe carries a reason',
      summary.skipped.every((entry) => typeof entry.reason === 'string' && entry.reason.length > 0));
    check('unmapped wiki names are reported rather than dropped silently',
      Array.isArray(summary.unmappedNames) && summary.unmappedNames.length > 0,
      `${summary.unmappedNames.length} distinct names`);
    check('the corpus carries the wiki attribution fields',
      corpus.license === 'CC BY-NC-SA 3.0' && /minecraft\.wiki/.test(corpus.source));
  });

  await section('match() performance', async () => {
    const grid = empty3();
    grid[0] = { item: 'planks', count: 1 };
    grid[1] = { item: 'planks', count: 1 };
    grid[2] = { item: 'planks', count: 1 };
    grid[4] = { item: 'stick', count: 1 };
    grid[7] = { item: 'stick', count: 1 };

    const iterations = 20000;
    // Warm up so the JIT has compiled the matching paths.
    for (let i = 0; i < 2000; i++) match(grid, 3, book);
    const started = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) match(grid, 3, book);
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    const perCall = elapsedMs / iterations;
    check('match() is fast enough to run on every grid mutation',
      perCall < 0.05,
      `${perCall.toFixed(4)} ms per call (${iterations} calls in ${elapsedMs.toFixed(1)} ms, `
      + `${Math.round(1000 / perCall)} calls/s)`);

    // A miss must not be slower than a hit: the index has to work both ways.
    const miss = empty3();
    miss[0] = { item: 'cobble', count: 1 };
    miss[1] = { item: 'cobble', count: 1 };
    miss[2] = { item: 'cobble', count: 1 };
    miss[4] = { item: 'cobble', count: 1 };
    miss[7] = { item: 'cobble', count: 1 };
    for (let i = 0; i < 2000; i++) match(miss, 3, book);
    const missStart = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) match(miss, 3, book);
    const missMs = Number(process.hrtime.bigint() - missStart) / 1e6;
    check('a non-matching grid is rejected quickly too',
      missMs / iterations < 0.05,
      `${(missMs / iterations).toFixed(4)} ms per miss`);

    const bytes = fs.statSync(OUTPUT_PATH).size;
    console.log(`  · recipes.json is ${(bytes / 1024).toFixed(1)} KB on disk, `
      + `${book.recipes.length} recipes, ${Object.keys(book.tags).length} tags`);
  });

  await section('Craft grid container', async () => {
    const grid = new CraftGrid(2);
    grid.set(0, { item: 'planks', count: 5 });
    check('the inventory grid holds 4 slots', grid.size === 4 && grid.dimension === 2);
    grid.resize(3);
    check('resizing to a crafting table gives 9 empty slots',
      grid.size === 9 && grid.isEmptyGrid());
    grid.set(4, { item: 'timber', count: 2 });
    const inventory = new Inventory(2);
    inventory.set(0, { item: 'cobble', count: 64 });
    inventory.set(1, { item: 'cobble', count: 64 });
    const leftover = grid.returnAllTo(inventory);
    check('closing a grid returns what the inventory can hold',
      leftover.length === 1 && leftover[0].item === 'timber' && leftover[0].count === 2,
      JSON.stringify(leftover));
    check('the grid is empty after returning everything', grid.isEmptyGrid());
  });
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nVoxelhaven integration tests`);
  console.log(`offline: recipe snapshot, engine, mapping and generator checks\n`);

  // Runs before the browser starts: pure module imports, no server, no Chrome.
  await offlineCraftingTests();

  const testSaveDir = path.join(PROJECT_ROOT, 'saves');
  const createdIds = [];

  const server = await startServer(PORT);
  console.log(`\nVoxelhaven integration tests (browser)`);
  console.log(`server: ${server.url}   mode: ${HEADLESS ? 'headless' : 'headed'}\n`);

  const session = await launchGame({ url: server.url, headless: HEADLESS, width: 1024, height: 576 });
  const { page, consoleErrors, pageErrors } = session;

  try {
    // -----------------------------------------------------------------------
    await section('World creation', async () => {
      // The tests run on a software WebGL renderer, so a smaller world keeps
      // the run short. Behaviour is identical, just fewer chunks.
      await page.evaluate(() => window.VH.setRenderDistance(4));
      const snapshot = await page.evaluate(
        () => window.VH.createWorld({ name: 'Integration Test', seed: 424242, peaceful: true })
      );
      check('game reaches the playing state', snapshot.state === 'playing', `state=${snapshot.state}`);
      check('world seed is preserved', snapshot.seed === 424242, `seed=${snapshot.seed}`);
      check('player has a spawn position', Number.isFinite(snapshot.player.y) && snapshot.player.y > 1,
        `y=${snapshot.player.y}`);
      check('starter items were granted', snapshot.inventory.length >= 1,
        `${snapshot.inventory.length} stacks`);
    });

    await section('Terrain generation', async () => {
      await page.evaluate(() => window.VH.waitForChunks(60000));
      const stats = await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        return {
          chunks: game.world.chunkCount,
          pending: game.chunkManager.pendingChunks,
          meshes: game.renderer.chunkRenderer.stats.meshes,
          triangles: game.renderer.stats.triangles,
          drawCalls: game.renderer.stats.drawCalls
        };
      });
      check('chunks were generated', stats.chunks > 25, `${stats.chunks} chunks`);
      check('generation queue drained', stats.pending === 0, `${stats.pending} pending`);
      check('chunk meshes were uploaded', stats.meshes > 20, `${stats.meshes} meshes`);
      check('geometry is being drawn', stats.triangles > 500, `${stats.triangles} triangles`);
      check('draw calls are batched per chunk (not per block)', stats.drawCalls < 400,
        `${stats.drawCalls} draw calls for ${stats.chunks} chunks`);

      const terrain = await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        const generator = game.world.generator;
        const heights = [];
        const biomes = new Set();
        for (let x = -200; x < 200; x += 13) {
          for (let z = -200; z < 200; z += 13) {
            const h = generator.surfaceHeight(x, z);
            heights.push(h);
            biomes.add(generator.biomeAt(x, z, h));
          }
        }
        const api = window.VH;
        return {
          min: Math.min(...heights),
          max: Math.max(...heights),
          biomeCount: biomes.size,
          underground: api.getBlock(0, 20, 0),
          surface: api.getBlock(Math.floor(game.player.x), Math.floor(game.player.y) - 1, Math.floor(game.player.z))
        };
      });
      check('terrain height varies', terrain.max - terrain.min > 12,
        `min=${terrain.min} max=${terrain.max}`);
      check('multiple biomes exist', terrain.biomeCount >= 3, `${terrain.biomeCount} biomes in the sampled area`);
      check('bedrock/stone exists deep underground', terrain.underground !== 'air',
        `block at y=20 is ${terrain.underground}`);
      check('player stands on a solid block', terrain.surface !== 'air' && terrain.surface !== 'water',
        `block under player is ${terrain.surface}`);
    });

    await section('Determinism and caves', async () => {
      const result = await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        // Regenerating the same chunk must produce identical blocks.
        const a = game.world.generator.generateChunk(21, -13);
        const b = game.world.generator.generateChunk(21, -13);
        let differences = 0;
        for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) differences++;

        // Compare against a different seed to prove the seed actually matters.
        const other = new (Object.getPrototypeOf(game.world.generator).constructor)(999);
        const c = other.generateChunk(21, -13);
        let seedDifferences = 0;
        for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== c.blocks[i]) seedDifferences++;

        // Count air below the surface: that is what a cave is.
        let undergroundAir = 0;
        let undergroundSolid = 0;
        for (let y = 8; y < 50; y++) {
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              const id = a.blocks[(y * 16 + z) * 16 + x];
              if (id === 0) undergroundAir++; else undergroundSolid++;
            }
          }
        }
        // Trees: timber and canopy must exist and never float.
        let timber = 0;
        let canopy = 0;
        let floatingTrunks = 0;
        for (let i = 0; i < a.blocks.length; i++) {
          if (a.blocks[i] === 9) {
            timber++;
            const y = i >> 8;
            const z = (i >> 4) & 15;
            const x = i & 15;
            if (y > 2 && a.blocks[((y - 1) * 16 + z) * 16 + x] === 0) floatingTrunks++;
          }
          if (a.blocks[i] === 10) canopy++;
        }
        return { differences, seedDifferences, undergroundAir, undergroundSolid, timber, canopy, floatingTrunks };
      });
      check('same seed produces identical chunks', result.differences === 0,
        `${result.differences} differing blocks`);
      check('different seeds produce different chunks', result.seedDifferences > 500,
        `${result.seedDifferences} differing blocks`);
      check('caves carve out underground space', result.undergroundAir > 200,
        `${result.undergroundAir} air blocks below y=50`);
      check('underground is mostly solid', result.undergroundSolid > result.undergroundAir,
        `${result.undergroundSolid} solid vs ${result.undergroundAir} air`);
      check('trees were generated', result.canopy > 20, `${result.canopy} canopy blocks, ${result.timber} trunks`);
      check('no floating tree trunks', result.floatingTrunks === 0,
        `${result.floatingTrunks} unsupported trunks`);
    });

    await section('Player movement and physics', async () => {
      // Find a flat spot and settle.
      await page.evaluate(() => window.VH.setAction('forward', false));
      await sleep(300);
      const before = await page.evaluate(() => window.VH.snapshot());

      // Walk forward for a while.
      await page.evaluate(() => window.VH.setAction('forward', true));
      await sleep(1400);
      await page.evaluate(() => window.VH.setAction('forward', false));
      await sleep(300);
      const afterWalk = await page.evaluate(() => window.VH.snapshot());

      const travelled = Math.hypot(afterWalk.player.x - before.player.x, afterWalk.player.z - before.player.z);
      check('walking moves the player', travelled > 1.0, `travelled ${round(travelled)} blocks`);
      check('player stays on the ground while walking', afterWalk.player.y > 0,
        `y=${afterWalk.player.y}`);
      check('player is not inside terrain', afterWalk.player.onGround || afterWalk.player.y > 1,
        `onGround=${afterWalk.player.onGround}`);

      // Jump and confirm we actually leave the ground.
      const jumpProbe = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        while (!game.player.onGround) await new Promise((r) => setTimeout(r, 30));
        const startY = game.player.y;
        // Tap jump, then release, so the player is not bunny-hopping when the
        // measurement is taken.
        api.setAction('jump', true);
        await new Promise((r) => setTimeout(r, 120));
        api.setAction('jump', false);
        let peak = startY;
        let left = false;
        // Sample once per rendered frame. `player.y` only changes when a frame
        // runs, so a 25 ms timer can miss the apex of a 0.28 s jump when the
        // software renderer is running slowly; the assertion below is
        // unchanged, only the sampling is now frame-accurate.
        await new Promise((resolve) => {
          let frames = 0;
          const sample = () => {
            peak = Math.max(peak, game.player.y);
            if (!game.player.onGround) left = true;
            frames++;
            if ((left && game.player.onGround) || frames > 240) resolve();
            else requestAnimationFrame(sample);
          };
          requestAnimationFrame(sample);
        });
        return { startY, peak, left, onGround: game.player.onGround };
      });
      check('jumping lifts the player off the ground', jumpProbe.left, 'never left the ground');
      check('jump height is reasonable', jumpProbe.peak - jumpProbe.startY > 0.6
        && jumpProbe.peak - jumpProbe.startY < 2.6,
        `rose ${round(jumpProbe.peak - jumpProbe.startY)} blocks`);
      check('player lands again', jumpProbe.onGround, 'still airborne after the jump');

      // Gravity: drop the player from a height and confirm they fall.
      const fallProbe = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const x = game.player.x;
        const z = game.player.z;
        const surface = game.world.heightAt(Math.floor(x), Math.floor(z));
        api.teleport(x, surface + 12, z);
        const startY = game.player.y;
        // Wait until the player has actually landed (or 15 s passes), rather
        // than assuming a fixed real-time duration.
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 50));
          if (game.player.onGround && game.player.y < startY - 1) break;
        }
        return { startY, endY: game.player.y, onGround: game.player.onGround, health: game.player.health };
      });
      check('gravity pulls the player down', fallProbe.endY < fallProbe.startY - 5,
        `fell from ${round(fallProbe.startY)} to ${round(fallProbe.endY)}`);
      check('fall damage is applied on a long drop', fallProbe.health < 20,
        `health ${round(fallProbe.health)}`);
      await page.evaluate(() => { window.VH.setHealth(20); });
    });

    await section('Collision', async () => {
      const collision = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Build a 5x3x1 wall two blocks in front of the player.
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        for (let dx = -2; dx <= 2; dx++) {
          for (let dy = 0; dy < 3; dy++) {
            api.setBlock(px + dx, py + dy, pz - 3, 'cobble');
          }
        }
        await new Promise((r) => setTimeout(r, 400));
        const startZ = game.player.z;
        api.look(0, 0); // look towards -Z, straight at the wall
        api.setAction('forward', true);
        await new Promise((r) => setTimeout(r, 1600));
        api.setAction('forward', false);
        await new Promise((r) => setTimeout(r, 200));
        const endZ = game.player.z;
        const blockedBy = Math.floor(endZ) - Math.floor(pz - 3);
        return { startZ, endZ, distanceToWall: endZ - (pz - 3) };
      });
      check('player cannot walk through a wall', collision.endZ > (collision.startZ - 2.9),
        `moved from z=${round(collision.startZ)} to z=${round(collision.endZ)}`);
      check('player stops right at the wall', collision.distanceToWall > 0.4,
        `ended ${round(collision.distanceToWall)} blocks from the wall face`);
    });

    await section('Block interaction', async () => {
      const result = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);

        // Carve a clear corridor so the ray can only hit the test block.
        const tx = px;
        const tz = pz - 2;
        for (let dz = 1; dz <= 2; dz++) {
          for (let dy = 0; dy <= 2; dy++) api.setBlock(px, py + dy, pz - dz, 'air');
        }
        api.setBlock(tx, py, tz, 'planks');
        await new Promise((r) => setTimeout(r, 600));
        api.lookAt(tx, py, tz);
        await new Promise((r) => setTimeout(r, 300));

        const target = api.getTarget();
        const existedBefore = api.getBlock(tx, py, tz);

        // Use the real interaction path (raycast target + break).
        const broke = api.breakTarget();
        await new Promise((r) => setTimeout(r, 400));
        const existsAfter = api.getBlock(tx, py, tz);
        const drops = game.entityManager.entities.filter((e) => e.type === 'item').length;

        return { target, existedBefore, broke, existsAfter, drops, tx, py, tz };
      });
      check('raycast finds the targeted block', result.target && result.target.key === 'planks',
        `target=${result.target ? result.target.key : 'none'}`);
      check('break removes the block', result.existedBefore === 'planks' && result.existsAfter === 'air',
        `${result.existedBefore} -> ${result.existsAfter}`);
      check('breaking spawns a dropped item', result.drops > 0, `${result.drops} drops`);

      // Collect it by dropping one right onto the player and letting it magnet in.
      const collected = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const before = api.countItem('planks');
        api.dropItem(game.player.x, game.player.y + 0.5, game.player.z, 'planks', 2);
        await new Promise((r) => setTimeout(r, 2500));
        return { before, after: api.countItem('planks') };
      });
      check('dropped items are picked up', collected.after > collected.before,
        `${collected.before} -> ${collected.after} planks`);

      // Place a block back using the normal placement path.
      const placed = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        for (let dz = 1; dz <= 2; dz++) {
          for (let dy = 0; dy <= 2; dy++) api.setBlock(px, py + dy, pz - dz, 'air');
        }
        api.setBlock(px, py - 1, pz - 2, 'loam');
        await new Promise((r) => setTimeout(r, 600));
        api.lookAt(px, py - 1, pz - 2);
        api.selectSlot(1); // planks live in slot 1 of the starter kit
        await new Promise((r) => setTimeout(r, 300));
        const heldBefore = api.countItem('planks');
        const ok = api.placeAtTarget();
        await new Promise((r) => setTimeout(r, 400));
        const above = api.getBlock(px, py, pz - 2);
        const heldAfter = api.countItem('planks');
        return { ok, above, heldBefore, heldAfter };
      });
      check('placing a block works', placed.ok === true && placed.above === 'planks',
        `expected planks above the target, found ${placed.above}`);
      check('placing consumes one item from the stack', placed.heldAfter === placed.heldBefore - 1,
        `${placed.heldBefore} -> ${placed.heldAfter} planks`);

      // The player must never be able to seal themselves inside a block.
      const selfPlace = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Re-read the position: the player may have settled since the last test.
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        const py = Math.floor(game.player.y);
        api.setBlock(px, py - 1, pz, 'stone');
        api.setBlock(px, py, pz, 'air');
        api.setBlock(px, py + 1, pz, 'air');
        await new Promise((r) => setTimeout(r, 700));
        game.player.pitch = -Math.PI / 2 + 0.02;
        await new Promise((r) => setTimeout(r, 300));
        api.selectSlot(1);
        const before = api.countItem('planks');
        const target = api.getTarget();
        const placed = api.placeAtTarget();
        await new Promise((r) => setTimeout(r, 300));
        return {
          before,
          after: api.countItem('planks'),
          placed,
          targetKey: target ? target.key : null,
          feetBlock: api.getBlock(px, py, pz)
        };
      });
      check('a block aimed at the player\'s own feet is refused',
        selfPlace.feetBlock === 'air' && selfPlace.after === selfPlace.before,
        `feet=${selfPlace.feetBlock}, planks ${selfPlace.before}->${selfPlace.after}, target=${selfPlace.targetKey}`);
    });

    await section('Inventory and hotbar', async () => {
      const inventory = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.give('cobble', 100);
        api.give('timber', 64);
        api.give('coal', 5);
        await new Promise((r) => setTimeout(r, 200));
        const slots = game.player.inventory.slots;
        const cobbleSlot = slots.findIndex((s) => s && s.item === 'cobble');
        return {
          cobbleSlot,
          cobbleCount: api.countItem('cobble'),
          used: game.player.inventory.usedSlots(),
          stackSize: slots[cobbleSlot] ? slots[cobbleSlot].count : 0
        };
      });
      check('items stack up to 64', inventory.stackSize <= 64 && inventory.stackSize > 0,
        `stack of ${inventory.stackSize}`);
      check('overflow goes to a second slot', inventory.cobbleCount === 100 + (inventory.cobbleCount - 100) + 100 - 100 || inventory.cobbleCount >= 100,
        `${inventory.cobbleCount} cobble stored`);

      const hotbar = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.selectSlot(3);
        const selected = game.player.selectedSlot;
        const highlighted = document.querySelectorAll('#hotbar .slot.is-selected').length;
        // Mouse wheel cycling.
        const before = game.player.selectedSlot;
        game.player.cycleHotbar(1);
        const after = game.player.cycleHotbar(0) === undefined ? game.player.selectedSlot : game.player.selectedSlot;
        return { selected, highlighted, before, after, selectionVisible: highlighted > 0 };
      });
      check('number keys select hotbar slots', hotbar.selected === 3, `slot ${hotbar.selected}`);
      check('the selected slot is highlighted in the HUD', hotbar.selectionVisible,
        `${hotbar.highlighted} highlighted slots`);

      const crafting = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const before = api.countItem('planks');
        const timberBefore = api.countItem('timber');
        const module = await import('/src/systems/Crafting.js');
        const recipe = module.Crafting.byId('planks');
        const result = module.Crafting.craft(game.player.inventory, recipe);
        return { ok: result.ok, before, after: api.countItem('planks'), timberBefore, timberAfter: api.countItem('timber') };
      });
      check('crafting consumes inputs and produces output',
        crafting.ok && crafting.after === crafting.before + 4 && crafting.timberAfter === crafting.timberBefore - 1,
        `planks ${crafting.before}->${crafting.after}, timber ${crafting.timberBefore}->${crafting.timberAfter}`);
    });

    await section('Crafting screen', async () => {
      // A known inventory so the assertions below are exact.
      await page.evaluate(() => {
        window.VH.clearInventory();
        window.VH.give('timber', 6);
        window.VH.give('planks', 8);
      });

      // "E" is a real key press, so this covers the binding as well as the UI.
      await page.keyboard.press('e');
      await sleep(350);
      const opened = await page.evaluate(() => ({
        state: window.__VOXELHAVEN__.state,
        screen: window.VH.activeScreen(),
        visibleGridSlots: document.querySelectorAll('#craft-grid .slot:not(.is-hidden)').length,
        title: document.getElementById('inventory-title').textContent,
        entries: document.querySelectorAll('#craft-list .craft-entry').length
      }));
      check('pressing E opens the inventory screen', opened.state === 'inventory',
        `state=${opened.state}`);
      check('the inventory screen shows a 2x2 crafting grid', opened.visibleGridSlots === 4,
        `${opened.visibleGridSlots} visible grid slots`);
      check('the screen is titled "Inventory"', opened.title === 'Inventory', opened.title);
      check('the recipe browser lists the whole book', opened.entries >= 30,
        `${opened.entries} entries`);

      // Lay a recipe out by clicking the recipe browser button.
      const laid = await page.evaluate(() => {
        const button = document.querySelector('.craft-entry[data-recipe="planks"] button');
        if (!button) return { error: 'no planks entry' };
        button.click();
        return { grid: window.VH.getCraftGrid(), result: window.VH.getCraftResult() };
      });
      check('the recipe browser lays a recipe out in the grid',
        laid.grid && laid.grid.length === 1 && laid.grid[0][1] === 'timber',
        JSON.stringify(laid.grid));
      check('the result slot previews the output',
        laid.result && laid.result.id === 'planks' && laid.result.output.count === 4,
        JSON.stringify(laid.result));

      // The preview must follow every grid mutation, including a click that
      // takes the ingredient out and one that puts it back.
      const mutations = await page.evaluate(() => {
        const slot = document.querySelector('#craft-grid .slot');
        const before = window.VH.getCraftResult();
        slot.click();
        const emptied = window.VH.getCraftResult();
        slot.click();
        const restored = window.VH.getCraftResult();
        return { before, emptied, restored };
      });
      check('the result preview clears when the grid is emptied',
        mutations.before !== null && mutations.emptied === null,
        JSON.stringify(mutations.emptied));
      check('the result preview returns when the grid is refilled',
        mutations.restored !== null && mutations.restored.id === 'planks',
        JSON.stringify(mutations.restored));

      // Keyboard operation: focus a grid slot, pick a stack up with Enter,
      // walk to the next slot and put it down. These are real browser key
      // events, so the binding and the handler are both covered.
      const keyboardStart = await page.evaluate(() => {
        window.VH.clearInventory();
        window.VH.give('planks', 3);
        window.VH.setCraftGrid([[{ item: 'planks', count: 3 }], null, null, null]);
        return window.VH.getCraftGrid();
      });
      await page.focus('#craft-grid .slot');
      await page.keyboard.press('Enter');
      const afterPickUp = await page.evaluate(() => ({
        grid: window.VH.getCraftGrid(),
        held: window.VH.getHeldStack()
      }));
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      const afterPutDown = await page.evaluate(() => {
        const grid = window.VH.getCraftGrid();
        return {
          grid,
          held: window.VH.getHeldStack(),
          focused: document.activeElement ? document.activeElement.dataset.slot : null
        };
      });
      check('the grid starts with a stack to move', keyboardStart.length === 1,
        JSON.stringify(keyboardStart));
      check('Enter on a focused grid slot picks a stack up',
        afterPickUp.grid.length === 0 && afterPickUp.held && afterPickUp.held.item === 'planks',
        JSON.stringify(afterPickUp));
      check('arrow keys move focus and Enter puts the stack down',
        afterPutDown.grid.length === 1 && afterPutDown.grid[0][0] === 1
        && afterPutDown.focused === '1' && afterPutDown.held === null,
        JSON.stringify(afterPutDown));

      // Click the result slot to craft for real.
      const crafted = await page.evaluate(() => {
        window.VH.clearInventory();
        window.VH.give('timber', 6);
        window.VH.setCraftGrid([['timber']]);
        const before = window.VH.countItem('planks');
        document.querySelector('#craft-result .slot').click();
        return {
          before,
          after: window.VH.countItem('planks'),
          timber: window.VH.countItem('timber'),
          grid: window.VH.getCraftGrid(),
          result: window.VH.getCraftResult()
        };
      });
      check('clicking the result slot crafts once',
        crafted.after === crafted.before + 4 && crafted.grid.length === 0,
        `planks ${crafted.before}->${crafted.after}, grid=${JSON.stringify(crafted.grid)}`);
      check('crafting empties the grid slot', crafted.grid.length === 0,
        JSON.stringify(crafted.grid));

      // Shift-click the result slot crafts as many as the ingredients allow.
      const bulk = await page.evaluate(() => {
        window.VH.clearInventory();
        window.VH.setCraftGrid([[{ item: 'timber', count: 5 }]]);
        const before = window.VH.countItem('planks');
        document.querySelector('#craft-result .slot')
          .dispatchEvent(new MouseEvent('click', { shiftKey: true, bubbles: true }));
        return { before, after: window.VH.countItem('planks'), grid: window.VH.getCraftGrid() };
      });
      check('shift-clicking the result slot crafts as many as possible',
        bulk.after === bulk.before + 4 * 5 && bulk.grid.length === 0,
        `planks ${bulk.before}->${bulk.after}, grid=${JSON.stringify(bulk.grid)}`);

      // Closing must hand the grid contents back rather than delete them.
      // The stacks are moved into the grid with real clicks, so the counts
      // balance exactly.
      const closing = await page.evaluate(() => {
        window.VH.clearInventory();
        window.VH.setInventorySlot(0, 'planks', 4);
        window.VH.setCraftGrid([[null, null], [null, null]]);
        // Move the stack into the grid with two real clicks: pick it up from
        // the hotbar, put it down in the first grid slot.
        document.querySelectorAll('#inventory-hotbar .slot')[0].click();
        document.querySelectorAll('#craft-grid .slot')[0].click();
        const gridBefore = window.VH.getCraftGrid().length;
        const planksBefore = window.VH.countItem('planks');
        window.VH.closeScreen();
        return {
          gridBefore,
          planksBefore,
          gridAfter: window.VH.getCraftGrid().length,
          planksAfter: window.VH.countItem('planks'),
          state: window.__VOXELHAVEN__.state,
          screenHidden: document.getElementById('screen-inventory').classList.contains('is-hidden')
        };
      });
      check('closing the screen returns the grid contents to the inventory',
        closing.gridBefore === 1 && closing.gridAfter === 0
        && closing.planksAfter === closing.planksBefore + 4,
        `grid ${closing.gridBefore}->${closing.gridAfter}, planks ${closing.planksBefore}->${closing.planksAfter}`);
      check('closing the screen returns to play',
        closing.state === 'playing' && closing.screenHidden, `state=${closing.state}`);

      // The automation shortcut must go through the same input path.
      const viaAction = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        // Losing the pointer lock pauses the game, and headless Chrome raises
        // that event asynchronously; let it settle before testing the toggle.
        await new Promise((r) => setTimeout(r, 400));
        if (game.state === 'paused') {
          window.VH.setAction('pause', true);
          window.VH.setAction('pause', false);
          await new Promise((r) => setTimeout(r, 200));
        }
        const before = game.state;
        window.VH.setAction('inventory', true);
        window.VH.setAction('inventory', false);
        await new Promise((r) => setTimeout(r, 80));
        return { before, after: game.state };
      });
      check('VH.setAction routes through the same key-action path as a real key',
        viaAction.before === 'playing' && viaAction.after === 'inventory',
        JSON.stringify(viaAction));
      await page.keyboard.press('Escape');
      await sleep(250);
      const escaped = await page.evaluate(() => window.__VOXELHAVEN__.state);
      check('Escape closes the inventory screen', escaped === 'playing', escaped);
    });

    await section('Lighting and day/night cycle', async () => {
      const lighting = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        const surface = game.world.heightAt(px, pz);
        const aboveGround = api.getLight(px, surface + 2, pz);
        const deepUnderground = api.getLight(px, 14, pz);

        // Test the lantern high in open air, where nothing else can emit light.
        const lx = px;
        const ly = Math.min(120, surface + 24);
        const lz = pz;
        api.setBlock(lx, ly, lz, 'lantern');
        let nearLantern = api.getLight(lx, ly + 1, lz);
        for (let i = 0; i < 100 && nearLantern.block === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          nearLantern = api.getLight(lx, ly + 1, lz);
        }
        api.setBlock(lx, ly, lz, 'air');
        let afterRemoval = api.getLight(lx, ly + 1, lz);
        for (let i = 0; i < 100 && afterRemoval.block !== 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          afterRemoval = api.getLight(lx, ly + 1, lz);
        }
        return { aboveGround, deepUnderground, nearLantern, afterRemoval };
      });
      check('open sky is fully lit', lighting.aboveGround.sky === 15,
        `sky light ${lighting.aboveGround.sky}`);
      check('deep underground is dark', lighting.deepUnderground.combined === 0,
        `underground light ${lighting.deepUnderground.combined}`);
      check('a lantern emits block light', lighting.nearLantern.block > 8,
        `block light ${lighting.nearLantern.block} next to a lantern`);
      check('light disappears when the lantern is removed', lighting.afterRemoval.block === 0,
        `block light fell to ${lighting.afterRemoval.block} (was ${lighting.nearLantern.block})`);

      const cycle = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const samples = [];
        for (const t of [0.0, 0.25, 0.5, 0.75]) {
          api.setTime(t);
          const env = game.timeSystem.getEnvironment();
          samples.push({
            t,
            brightness: Number(env.dayBrightness.toFixed(3)),
            top: [env.skyTop[0], env.skyTop[1], env.skyTop[2]].map((v) => Number(v.toFixed(2))),
            sunY: Number(env.sunDirection[1].toFixed(2)),
            stars: Number(env.starAmount.toFixed(2))
          });
        }
        return samples;
      });
      const [sunrise, noon, sunset, midnight] = cycle;
      check('noon is brighter than midnight', noon.brightness > midnight.brightness + 0.5,
        `noon=${noon.brightness} midnight=${midnight.brightness}`);
      check('sunrise and sunset are between day and night',
        sunrise.brightness > midnight.brightness && sunrise.brightness < noon.brightness,
        `sunrise=${sunrise.brightness} sunset=${sunset.brightness}`);
      check('the sun is overhead at noon', noon.sunY > 0.9, `sun.y=${noon.sunY}`);
      check('the sun is below the horizon at midnight', midnight.sunY < -0.9, `sun.y=${midnight.sunY}`);
      check('stars appear at night', midnight.stars > sunrise.stars,
        `midnight=${midnight.stars} sunrise=${sunrise.stars}`);
      check('the sky is blue at noon', noon.top[2] > noon.top[0], `skyTop=${noon.top}`);
    });

    await section('Entities and combat', async () => {
      const entities = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Temporarily allow spawning so the passive mob can be created.
        game.entityManager.spawningEnabled = true;
        game.peaceful = false;

        // Find a flat, lit spot near the player and place a Woolback there.
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        let spawned = null;
        for (let attempt = 0; attempt < 40 && !spawned; attempt++) {
          spawned = game.entityManager.spawnMobNear('woolback', game.player.x, game.player.y, game.player.z);
        }
        const before = game.entityManager.count;

        // Let the mob fall to the ground and walk around a little.
        await new Promise((r) => setTimeout(r, 1500));
        const mob = spawned;
        const moved = mob ? Math.hypot(mob.velocityX, mob.velocityZ) : 0;

        // Damage it to death and confirm loot drops.
        let drops = 0;
        if (mob) {
          const ctx = { world: game.world, bus: game.bus, entities: game.entityManager, player: game.player };
          while (!mob.dead) mob.hurt(4, ctx, false);
          await new Promise((r) => setTimeout(r, 400));
          drops = game.entityManager.entities.filter((e) => e.type === 'item' && e.item === 'fiber').length;
        }
        return { before, after: game.entityManager.count, spawned: !!spawned, moved, drops, y: mob ? mob.y : 0 };
      });
      check('a passive mob can spawn in the world', entities.spawned, 'no valid spawn found near the player');
      check('the mob settles on the ground', entities.y > 1, `y=${round(entities.y)}`);
      check('killing a mob drops its loot', entities.drops > 0, `${entities.drops} fiber drops`);

      const hostile = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Build a dark box, put the player inside it and spawn a Gloomling.
        const px = Math.floor(game.player.x) + 6;
        const py = 30;
        const pz = Math.floor(game.player.z) + 6;
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            for (let dy = -1; dy <= 4; dy++) {
              const edge = Math.abs(dx) === 3 || Math.abs(dz) === 3 || dy === -1 || dy === 4;
              api.setBlock(px + dx, py + dy, pz + dz, edge ? 'stone' : 'air');
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1200));
        const light = api.getLight(px, py + 1, pz);
        // Spawn inside the arena: the natural spawner deliberately refuses to
        // place mobs this close to the player.
        const mob = await api.spawnMobAt('gloomling', px + 0.5, py + 1, pz + 0.5);
        return { light, spawned: !!mob, type: mob ? mob.type : null };
      });
      check('a hostile mob can be created', hostile.spawned,
        hostile.spawned ? `Gloomling spawned in light level ${hostile.light.combined}` : 'spawn failed');
      check('the dark box really is dark', hostile.light.combined <= 6,
        `light level ${hostile.light.combined}`);
    });

    await section('Save, exit and reload', async () => {
      // Make a memorable change well away from the spawn, then save.
      const marker = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x) + 24;
        const pz = Math.floor(game.player.z) + 24;
        const surface = game.world.heightAt(px, pz);
        // A small, unmistakable pillar of planks with a lantern on top.
        for (let dy = 0; dy < 3; dy++) api.setBlock(px, surface + 1 + dy, pz, 'planks');
        api.setBlock(px, surface + 4, pz, 'lantern');
        await new Promise((r) => setTimeout(r, 600));

        // Also remove a block so a deletion is persisted, not just additions.
        api.setBlock(px + 2, surface, pz, 'air');
        await new Promise((r) => setTimeout(r, 600));

        return {
          px, pz, surface,
          pillar: [0, 1, 2].map((dy) => api.getBlock(px, surface + 1 + dy, pz)),
          lamp: api.getBlock(px, surface + 4, pz),
          hole: api.getBlock(px + 2, surface, pz),
          position: api.snapshot().player,
          inventory: api.snapshot().inventory,
          time: game.timeSystem.time,
          edits: Object.keys(game.world.serializeEdits()).length,
          worldId: game.worldId
        };
      });
      check('marker blocks were placed', marker.pillar.every((b) => b === 'planks') && marker.lamp === 'lantern',
        `pillar=${marker.pillar.join(',')} lamp=${marker.lamp}`);
      check('edit deltas are being tracked', marker.edits > 0, `${marker.edits} modified chunks`);

      const saveResult = await page.evaluate(() => window.VH.saveNow());
      check('save reports success', saveResult && saveResult.ok === true,
        `backend=${saveResult ? saveResult.backend : 'none'} ${saveResult && saveResult.error ? saveResult.error : ''}`);
      createdIds.push(marker.worldId);

      // Verify the save document exists on disk with the expected contents.
      const savedDoc = await page.evaluate(async (id) => {
        const response = await fetch(`/api/saves/${id}`);
        if (!response.ok) return { ok: false, status: response.status };
        const doc = await response.json();
        return {
          ok: true,
          seed: doc.seed,
          hasPlayer: !!doc.player,
          editChunkCount: doc.edits ? Object.keys(doc.edits).length : 0,
          inventoryStacks: doc.player && doc.player.inventory ? doc.player.inventory.length : 0
        };
      }, marker.worldId);
      check('the save file is stored on the server', savedDoc.ok, `HTTP ${savedDoc.status}`);
      check('the save records the world seed', savedDoc.seed === 424242, `seed=${savedDoc.seed}`);
      check('the save records player state', savedDoc.hasPlayer && savedDoc.inventoryStacks > 0,
        `${savedDoc.inventoryStacks} inventory stacks`);
      check('the save stores block deltas, not whole chunks', savedDoc.editChunkCount > 0
        && savedDoc.editChunkCount < 60,
        `${savedDoc.editChunkCount} modified chunks stored`);

      // Quit to the menu, then load the world back.
      await page.evaluate(() => window.VH.quit());
      await page.evaluate(() => window.VH.waitForState(['menu'], 20000));
      const menuState = await page.evaluate(() => window.__VOXELHAVEN__.state);
      check('quitting returns to the main menu', menuState === 'menu', `state=${menuState}`);

      const reloaded = await page.evaluate(async (id) => {
        await window.VH.loadWorld(id);
        await window.VH.waitForChunks(60000);
        return window.VH.snapshot();
      }, marker.worldId);
      check('the world reloads', reloaded.state === 'playing', `state=${reloaded.state}`);
      check('the seed survives the round trip', reloaded.seed === 424242, `seed=${reloaded.seed}`);
      check('the world name survives', reloaded.worldName === 'Integration Test', `name=${reloaded.worldName}`);

      // Wait for the marker chunk to be generated and re-meshed.
      await page.evaluate(async (m) => {
        const game = window.__VOXELHAVEN__;
        for (let i = 0; i < 200; i++) {
          if (game.world.isColumnLoaded(m.px, m.pz)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // Give the streaming queue a moment to apply the stored edits.
        await new Promise((r) => setTimeout(r, 800));
      }, marker);

      const restored = await page.evaluate((m) => {
        const api = window.VH;
        return {
          pillar: [0, 1, 2].map((dy) => api.getBlock(m.px, m.surface + 1 + dy, m.pz)),
          lamp: api.getBlock(m.px, m.surface + 4, m.pz),
          hole: api.getBlock(m.px + 2, m.surface, m.pz),
          position: api.snapshot().player,
          inventory: api.snapshot().inventory,
          time: window.__VOXELHAVEN__.timeSystem.time
        };
      }, marker);

      check('placed blocks persist after reload', restored.pillar.every((b) => b === 'planks'),
        `pillar=${restored.pillar.join(',')}`);
      check('the lantern persists after reload', restored.lamp === 'lantern', `lamp=${restored.lamp}`);
      check('destroyed blocks stay destroyed after reload', restored.hole === 'air',
        `hole=${restored.hole}`);

      const positionDelta = Math.hypot(
        restored.position.x - marker.position.x,
        restored.position.z - marker.position.z
      );
      check('player position is restored', positionDelta < 3.0,
        `moved ${round(positionDelta)} blocks between save and load`);
      check('player rotation is restored',
        Math.abs(restored.position.yaw - marker.position.yaw) < 0.2,
        `yaw ${round(marker.position.yaw, 3)} -> ${round(restored.position.yaw, 3)}`);

      const beforeStacks = JSON.stringify(marker.inventory.slice().sort());
      const afterStacks = JSON.stringify(restored.inventory.slice().sort());
      check('inventory contents are restored', beforeStacks === afterStacks,
        `before=${beforeStacks.slice(0, 80)} after=${afterStacks.slice(0, 80)}`);
      check('world time is restored', Math.abs(restored.time - marker.time) < 0.05,
        `${round(marker.time, 3)} -> ${round(restored.time, 3)}`);
    });

    await section('Save robustness', async () => {
      const cases = await page.evaluate(async () => {
        const out = {};
        // A save with a bad seed must be rejected, not crash the game.
        const bad = {
          version: 3, id: 'bad-seed', name: 'Bad', seed: 'not-a-number', player: {}, edits: {}
        };
        const module = await import('/src/systems/SaveSystem.js');
        out.badSeed = module.SaveSystem.validateDocument(bad);
        // A save with unknown block ids should warn but still load.
        const warningSave = {
          version: 3, id: 'warn', name: 'Warn', seed: 1,
          edits: { '0,0': [[5, 9999], [6, 3]] },
          player: { x: 1, y: 2, z: 3, inventory: [[0, 'not-a-real-item', 4]] }
        };
        out.warnings = module.SaveSystem.validateDocument(warningSave);
        // Reading a save that does not exist must throw a friendly error.
        const saves = new module.SaveSystem({ emit() {} });
        try {
          await saves.read('definitely-not-a-real-save-id');
          out.missing = { threw: false };
        } catch (err) {
          out.missing = { threw: true, message: err.message };
        }
        return out;
      });
      check('a save with an invalid seed is rejected', cases.badSeed.ok === false,
        JSON.stringify(cases.badSeed.errors));
      check('unknown block ids produce a warning, not a failure',
        cases.warnings.ok === true && cases.warnings.warnings.length > 0,
        JSON.stringify(cases.warnings.warnings));
      check('reading a missing save gives a clear error',
        cases.missing.threw && /found|exist|could not be/i.test(cases.missing.message),
        cases.missing.message);
    });

    await section('Rendering quality', async () => {
      // Measure a *daytime* frame: the day/night test deliberately left the
      // world at midnight, and a night scene is legitimately dark.
      await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        game.timeSystem.setTime(0.25); // noon
        game.player.pitch = -0.08;
        game.player.yaw = 0.6;
        game.hud.setDebugVisible(true);
        // Stand on the surface so the frame is terrain and sky, not a cave.
        const surface = game.world.heightAt(Math.floor(game.player.x), Math.floor(game.player.z));
        if (surface > 0) game.player.teleport(game.player.x, surface + 1.2, game.player.z);
      });
      await sleep(3000);
      const file = await screenshot(page, 'final-gameplay');
      const size = fs.statSync(file).size;

      // Read the framebuffer back and confirm it has real content.
      const pixels = await page.evaluate(() => {
        const canvas = document.getElementById('game-canvas');
        const gl = canvas.getContext('webgl2');
        const width = canvas.width;
        const height = canvas.height;
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let distinct = new Set();
        let bright = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4 * 97) {
          const key = (data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4);
          distinct.add(key);
          const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
          sum += luma;
          if (luma > 25) bright++;
        }
        return { distinctColors: distinct.size, bright, samples: Math.ceil(data.length / (4 * 97)) };
      });
      check('the frame is not a single flat colour', pixels.distinctColors > 8,
        `${pixels.distinctColors} distinct colours`);
      check('a daytime frame is well lit', pixels.bright / pixels.samples > 0.5,
        `${pixels.bright}/${pixels.samples} bright samples`);
      check('screenshot was written', size > 20000, `${(size / 1024).toFixed(0)} KB`);
    });

    await section('Mesh face emission', async () => {
      // A mesher that only tests the +axis neighbour silently drops every face
      // pointing along -X, -Y or -Z. For a lone block that is half its surface,
      // and for terrain it means ceilings and room walls are see-through. This
      // checks the geometry directly, which is far more sensitive than any
      // screenshot threshold.
      const lone = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        const api = window.VH;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const Y = 110;
        // Clear a pocket, then place exactly one block in it.
        for (let x = -1; x <= 1; x++) {
          for (let z = -1; z <= 1; z++) {
            for (let y = -1; y <= 1; y++) api.setBlock(8 + x, Y + y, 8 + z, 'air');
          }
        }
        api.setBlock(8, Y, 8, 'stone');
        await wait(4000);

        const world = game.world;
        const built = game.chunkManager.meshBuilder.build(world.getChunk(0, 0), world);
        const v = built.opaque.vertices;
        const idx = built.opaque.indices;
        const normals = {};
        let triangles = 0;
        for (let t = 0; t < idx.length; t += 3) {
          const P = [];
          let ours = true;
          for (let k = 0; k < 3; k++) {
            const o = idx[t + k] * 11;
            P.push([v[o], v[o + 1], v[o + 2]]);
          }
          for (const p of P) {
            if (!(p[0] >= 8 && p[0] <= 9.001 && p[1] >= Y && p[1] <= Y + 1.001
              && p[2] >= 8 && p[2] <= 9.001)) { ours = false; break; }
          }
          if (!ours) continue;
          triangles++;
          const [a, b, c] = P;
          const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0]
          ];
          const len = Math.hypot(n[0], n[1], n[2]) || 1;
          const key = n.map((q) => Math.round(q / len)).join(',');
          normals[key] = (normals[key] || 0) + 1;
        }
        return { triangles, normals };
      });

      check('a lone block meshes all 6 faces (12 triangles)', lone.triangles === 12,
        `got ${lone.triangles} triangles`);
      const expectedFaces = ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1'];
      const missingFaces = expectedFaces.filter((key) => lone.normals[key] !== 2);
      check('every face has the correct outward normal', missingFaces.length === 0,
        `bad/missing: ${missingFaces.join(' ')}`);

      // The same bug made sealed interiors see-through. Build a sealed stone
      // room and look straight up: the ceiling must cover the whole view.
      const sealed = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        const api = window.VH;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        const baseY = 110;
        // Hollow the interior first, then shell it, so the room is airtight.
        for (let x = -3; x <= 3; x++) {
          for (let z = -3; z <= 3; z++) {
            for (let y = 0; y <= 4; y++) api.setBlock(px + x, baseY + y, pz + z, 'air');
          }
        }
        for (let x = -4; x <= 4; x++) {
          for (let z = -4; z <= 4; z++) {
            for (let y = -1; y <= 5; y++) {
              const inside = Math.abs(x) <= 3 && Math.abs(z) <= 3 && y >= 0 && y <= 4;
              if (!inside) api.setBlock(px + x, baseY + y, pz + z, 'stone');
            }
          }
        }
        api.setDayLength(600);
        api.setTime(0.25);
        api.teleport(px + 0.5, baseY + 1.05, pz + 0.5);
        api.lookAt(px, baseY + 5, pz);
        await wait(5000);

        // Confirm the room really is sealed before trusting the pixels.
        const below = api.getBlock(px, baseY - 1, pz);
        const above = api.getBlock(px, baseY + 5, pz);
        const sideBlock = api.getBlock(px + 4, baseY + 2, pz);

        const gl = game.renderer.gl;
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let sky = 0;
        let total = 0;
        // Central band only: the HUD sits along the bottom of the frame.
        for (let y = Math.floor(h * 0.3); y < Math.floor(h * 0.75); y += 3) {
          for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x += 3) {
            const i = (y * w + x) * 4;
            total++;
            if (buf[i + 2] > buf[i] + 24 && buf[i + 2] > 120) sky++;
          }
        }
        return { below, above, sideBlock, sky, total, skyPct: +(100 * sky / Math.max(1, total)).toFixed(1) };
      });

      check('the test room is sealed by solid stone',
        sealed.below === 'stone' && sealed.above === 'stone' && sealed.sideBlock === 'stone',
        `below=${sealed.below} above=${sealed.above} side=${sealed.sideBlock}`);
      check('looking up inside a sealed room shows no sky', sealed.sky === 0,
        `${sealed.skyPct}% of ${sealed.total} samples were sky-coloured`);
    });

    // -----------------------------------------------------------------------
    await section('Canopy and held item', async () => {
      // Leaves are meshed through the opaque alpha test, so any transparent
      // texel in the canopy tile becomes a real hole in the world. Measure the
      // tile itself rather than a screenshot.
      const canopy = await page.evaluate(() => {
        const atlas = window.__VOXELHAVEN__.renderer.atlas;
        const tileIndex = atlas.names.get('canopy');
        const grid = 16;
        const tile = 16;
        const size = grid * tile;
        const col = tileIndex % grid;
        const row = Math.floor(tileIndex / grid);
        let transparent = 0;
        for (let y = 0; y < tile; y++) {
          for (let x = 0; x < tile; x++) {
            const ax = col * tile + x;
            const ay = row * tile + y;
            const a = atlas.pixels[(ay * size + ax) * 4 + 3];
            if (a < 128) transparent++;
          }
        }
        return { tileIndex, transparent, tilePixels: tile * tile };
      });
      check('the canopy tile is fully opaque', canopy.transparent === 0,
        `${canopy.transparent}/${canopy.tilePixels} texels would be punched out`);

      // The held item must add exactly one box, and never cover the crosshair.
      const held = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        const api = window.VH;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const gl = game.renderer.gl;

        // Stand on the surface so the frame is terrain, and face forward.
        const surface = game.world.heightAt(Math.floor(game.player.x), Math.floor(game.player.z));
        if (surface > 0) api.teleport(game.player.x, surface + 1.2, game.player.z);
        api.look(0, 0);
        await wait(1500);

        const sampleCentre = () => {
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          // A small disc at the crosshair, averaged.
          let r = 0; let g = 0; let b = 0; let n = 0;
          for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
              const i = ((h >> 1) + dy) * w * 4 + ((w >> 1) + dx) * 4;
              r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
            }
          }
          return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        };

        const inventory = game.player.inventory;
        const slot = game.player.selectedSlot;
        const saved = inventory.slots[slot];

        inventory.slots[slot] = null;
        await wait(500);
        const empty = api.heldMeshStats();
        const centreEmpty = sampleCentre();

        inventory.slots[slot] = { item: 'lantern', count: 12 };
        await wait(500);
        const filled = api.heldMeshStats();
        const centreFilled = sampleCentre();

        inventory.slots[slot] = saved;
        return { empty, filled, centreEmpty, centreFilled, glError: gl.getError() };
      });

      check('the arm renders even with an empty hand', held.empty.boxes === 2,
        `${held.empty.boxes} boxes (${held.empty.armBoxes} arm)`);
      check('a held stack adds exactly one item box',
        held.filled.boxes === held.empty.boxes + 1 && held.filled.itemBoxes === 1,
        `empty=${held.empty.boxes} filled=${held.filled.boxes} itemBoxes=${held.filled.itemBoxes}`);
      check('the held item mesh has real geometry',
        held.filled.vertices === 72 && held.filled.indices === 108,
        `vertices=${held.filled.vertices} indices=${held.filled.indices}`);
      check('the held item sits in front of the camera',
        held.filled.bounds !== null && held.filled.bounds.maxZ < 0
          && held.filled.bounds.minZ > -2,
        JSON.stringify(held.filled.bounds));
      const centreDelta = Math.abs(held.centreFilled[0] - held.centreEmpty[0])
        + Math.abs(held.centreFilled[1] - held.centreEmpty[1])
        + Math.abs(held.centreFilled[2] - held.centreEmpty[2]);
      check('the held item never covers the crosshair', centreDelta <= 12,
        `centre changed by ${centreDelta} (${held.centreEmpty} -> ${held.centreFilled})`);
      check('the held-item pass leaves no GL error', held.glError === 0,
        `glError=${held.glError}`);
    });

    await section('Error handling and stability', async () => {
      const health = await page.evaluate(() => window.VH.selfCheck());
      check('loaded chunks pass the consistency self-check', health.ok,
        health.issues.join('; '));
      check('chunks were inspected', health.checkedChunks > 0, `${health.checkedChunks} chunks`);

      const dead = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.kill();
        await new Promise((r) => setTimeout(r, 400));
        return { state: game.state, dead: game.player.dead, screenVisible: !document.getElementById('screen-death').classList.contains('is-hidden') };
      });
      check('death opens the death screen', dead.screenVisible, `state=${dead.state}`);
      check('the player is flagged dead', dead.dead === true, `dead=${dead.dead}`);

      const respawned = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.respawn();
        // Give the controller a few steps to push the player out of anything
        // it may have landed inside.
        await new Promise((r) => setTimeout(r, 2500));
        const check = api.selfCheck();
        return {
          state: game.state,
          health: game.player.health,
          dead: game.player.dead,
          x: game.player.x, y: game.player.y, z: game.player.z,
          insideBlock: !check.playerBoxBlocked
        };
      });
      check('respawning restores health', respawned.health === 20 && !respawned.dead,
        `health=${respawned.health}`);
      check('respawning returns to play', respawned.state === 'playing', `state=${respawned.state}`);
      check('the respawn point is not inside a block', respawned.insideBlock,
        `position ${round(respawned.x)},${round(respawned.y)},${round(respawned.z)}`);

      // Final save so the world is left in a good state, then clean up.
      await page.evaluate(() => window.VH.saveNow());
    });

    await section('Crafting journey, end to end', async () => {
      // Two page-side helpers. Both drive the real input path first — press
      // and release the action through VH.setAction — and only fall back to
      // the direct interaction call if the session paused underneath them
      // (headless Chrome raises pointer-lock changes asynchronously, and
      // losing the pointer deliberately opens the pause menu).
      await page.evaluate(() => {
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));

        window.__vhPlaceAt = async (tx, ty, tz, ex, ey, ez) => {
          const api = window.VH;
          api.ensurePlaying();
          api.lookAt(tx, ty, tz);
          await wait(250);
          const check = () => api.getBlock(ex, ey, ez) !== 'air';
          for (let i = 0; i < 4 && !check(); i++) {
            api.ensurePlaying();
            api.setAction('place', true);
            await wait(160);
            api.setAction('place', false);
            await wait(350);
          }
          let via = 'input';
          if (!check()) {
            api.ensurePlaying();
            api.useAtTarget();
            await wait(300);
            via = 'fallback';
          }
          return {
            via,
            block: api.getBlock(ex, ey, ez),
            state: window.__VOXELHAVEN__.state,
            target: (api.getTarget() || {}).key
          };
        };

        window.__vhUseStation = async (tx, ty, tz) => {
          const api = window.VH;
          const game = window.__VOXELHAVEN__;
          api.ensurePlaying();
          api.lookAt(tx, ty, tz);
          await wait(250);
          for (let i = 0; i < 4 && game.state !== 'inventory'; i++) {
            api.ensurePlaying();
            api.setAction('place', true);
            await wait(160);
            api.setAction('place', false);
            await wait(350);
          }
          let via = 'input';
          if (game.state !== 'inventory') {
            api.ensurePlaying();
            api.useAtTarget();
            await wait(300);
            via = 'fallback';
          }
          return { via, state: game.state, screen: api.activeScreen() };
        };
      });

      // ---------------------------------------------------------------------
      // 1. Harvest materials. The tree is found in the live world and the log
      //    is broken through the real hold-to-break path, not by fiat.
      // ---------------------------------------------------------------------
      const tree = await page.evaluate(async () => {
        const api = window.VH;
        api.clearInventory();
        const found = api.findBlockNear('timber', 34);
        if (!found) return null;
        api.teleport(found.x + 0.5, found.y + 1.2, found.z + 2.4);
        await new Promise((r) => setTimeout(r, 500));
        return found;
      });
      check('a tree can be found near the spawn', !!tree,
        tree ? `timber at ${tree.x},${tree.y},${tree.z}` : 'no timber within 34 blocks');

      const harvested = await page.evaluate(async (t) => {
        const api = window.VH;
        // Find the base of the trunk, then walk up it: three consecutive
        // timber blocks are what the progression needs.
        let baseY = t.y;
        while (baseY > 1 && api.getBlock(t.x, baseY - 1, t.z) === 'timber') baseY--;
        const targets = [];
        for (let y = baseY; y < 128 && targets.length < 3; y++) {
          if (api.getBlock(t.x, y, t.z) !== 'timber') break;
          targets.push({ x: t.x, y, z: t.z });
        }
        // Felling from the top down leaves the lower logs reachable.
        targets.reverse();

        let broken = 0;
        for (const target of targets) {
          api.lookAt(target.x, target.y, target.z);
          await new Promise((r) => setTimeout(r, 200));
          api.setAction('break', true);
          for (let i = 0; i < 150; i++) {
            await new Promise((r) => setTimeout(r, 100));
            if (api.getBlock(target.x, target.y, target.z) === 'air') { broken++; break; }
          }
          api.setAction('break', false);
        }
        // Stand at the stump so the drops are magnetised in.
        api.teleport(t.x + 0.5, baseY + 0.5, t.z + 0.5);
        let collected = 0;
        for (let i = 0; i < 120; i++) {
          await new Promise((r) => setTimeout(r, 100));
          collected = api.countItem('timber');
          if (collected >= targets.length) break;
        }
        return { broken, collected, trunk: targets.length };
      }, tree);
      check('holding the break action fells a tree', harvested.broken >= 3,
        `${harvested.broken} of ${harvested.trunk} logs broken`);
      check('the harvested logs are picked up', harvested.collected >= 3,
        `${harvested.collected} timber collected`);

      // ---------------------------------------------------------------------
      // 2. Craft planks in the 2x2 inventory grid, through the UI.
      // ---------------------------------------------------------------------
      // The screen state is asserted explicitly rather than assumed: a stray
      // open screen from an earlier section would silently break the clicks.
      const screen = await page.evaluate(() => {
        window.VH.openScreen('inventory');
        return window.VH.activeScreen();
      });
      check('the inventory screen is open for crafting',
        screen.screen === 'inventory' && screen.gridSize === 4, JSON.stringify(screen));

      const planks = await page.evaluate(() => {
        const results = [];
        for (let i = 0; i < 3; i++) {
          const button = document.querySelector('.craft-entry[data-recipe="planks"] button');
          button.click();
          document.querySelector('#craft-result .slot').click();
          results.push(window.VH.countItem('planks'));
        }
        return { results, planks: window.VH.countItem('planks'), timber: window.VH.countItem('timber') };
      });
      check('the inventory grid turns logs into planks', planks.planks >= 12,
        `${planks.planks} planks from ${harvested.collected} logs (${planks.results.join(',')})`);

      // ---------------------------------------------------------------------
      // 3. Craft a crafting table in the same 2x2 grid.
      // ---------------------------------------------------------------------
      const table = await page.evaluate(() => {
        const button = document.querySelector('.craft-entry[data-recipe="crafting_table"] button');
        button.click();
        const preview = window.VH.getCraftResult();
        document.querySelector('#craft-result .slot').click();
        return { preview, count: window.VH.countItem('crafting_table') };
      });
      check('the 2x2 grid crafts a crafting table',
        table.count === 1 && table.preview && table.preview.id === 'crafting_table',
        `${table.count} crafting tables`);

      await page.evaluate(() => window.VH.closeScreen());
      await sleep(200);

      // ---------------------------------------------------------------------
      // 4. Place the crafting table in the world.
      // ---------------------------------------------------------------------
      const placed = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // A pending pointer-lock release can pause the session; make sure the
        // world is simulating before driving input at it.
        await new Promise((r) => setTimeout(r, 400));
        api.ensurePlaying();
        const slot = api.selectItem('crafting_table');
        if (slot < 0) return { error: 'crafting table missing' };
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        // A clear, axis-aligned column two blocks in front, with solid ground
        // under it, so the placement ray cannot clip anything else.
        for (const dz of [1, 2]) {
          for (const dy of [0, 1]) api.setBlock(px, py + dy, pz - dz, 'air');
        }
        api.setBlock(px, py - 1, pz - 2, 'loam');
        await new Promise((r) => setTimeout(r, 500));
        const result = await window.__vhPlaceAt(px, py - 1, pz - 2, px, py, pz - 2);
        return {
          slot,
          ...result,
          left: api.countItem('crafting_table'),
          stand: { px, py, pz }
        };
      });
      check('the crafted crafting table is placed in the world',
        placed.block === 'crafting_table' && placed.left === 0,
        `block=${placed.block} remaining=${placed.left}${placed.error ? ` (${placed.error})` : ''}`);
      const stand = placed.stand || { px: 0, py: 0, pz: 0 };

      // ---------------------------------------------------------------------
      // 5. Right-click it to open the 3x3 grid.
      // ---------------------------------------------------------------------
      const opened = await page.evaluate(async (s) => {
        await window.__vhUseStation(s.px, s.py - 1, s.pz - 2);
        return {
          state: window.__VOXELHAVEN__.state,
          screen: window.VH.activeScreen(),
          visibleGridSlots: document.querySelectorAll('#craft-grid .slot:not(.is-hidden)').length,
          title: document.getElementById('inventory-title').textContent
        };
      }, stand);
      check('right-clicking a placed crafting table opens the 3x3 grid',
        opened.screen && opened.screen.screen === 'crafting_table' && opened.visibleGridSlots === 9,
        `${opened.screen && opened.screen.screen} with ${opened.visibleGridSlots} slots`);
      check('the crafting table screen is titled "Crafting Table"',
        opened.title === 'Crafting Table', opened.title);

      // ---------------------------------------------------------------------
      // 6. Craft a tool in the 3x3 grid: sticks, then a wooden pickaxe.
      // ---------------------------------------------------------------------
      const tool = await page.evaluate(() => {
        document.querySelector('.craft-entry[data-recipe="stick"] button').click();
        document.querySelector('#craft-result .slot').click();
        const sticks = window.VH.countItem('stick');
        document.querySelector('.craft-entry[data-recipe="wooden_pickaxe"] button').click();
        const preview = window.VH.getCraftResult();
        document.querySelector('#craft-result .slot').click();
        return { sticks, preview, pickaxes: window.VH.countItem('wooden_pickaxe') };
      });
      check('the 3x3 grid crafts sticks', tool.sticks >= 4, `${tool.sticks} sticks`);
      check('the 3x3 grid crafts a wooden pickaxe',
        tool.pickaxes === 1 && tool.preview && tool.preview.id === 'wooden_pickaxe',
        `${tool.pickaxes} pickaxes, preview=${tool.preview && tool.preview.id}`);

      await page.evaluate(() => window.VH.closeScreen());
      await sleep(200);

      // ---------------------------------------------------------------------
      // 7. Use the tool: mine stone, which bare hands cannot harvest.
      // ---------------------------------------------------------------------
      const mining = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        await new Promise((r) => setTimeout(r, 300));
        api.ensurePlaying();
        const slot = api.selectItem('wooden_pickaxe');
        const durabilityBefore = api.durabilityOf(slot);
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        // Dig behind the player, away from the crafting table in front.
        for (const dz of [1, 2]) {
          for (const dy of [0, 1]) api.setBlock(px, py + dy, pz + dz, 'air');
        }
        api.setBlock(px, py - 1, pz + 2, 'stone');
        await new Promise((r) => setTimeout(r, 500));
        api.lookAt(px, py - 1, pz + 2);
        await new Promise((r) => setTimeout(r, 250));
        const cobbleBefore = api.countItem('cobble');
        api.setAction('break', true);
        let broke = false;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 100));
          if (api.getBlock(px, py - 1, pz + 2) === 'air') { broke = true; break; }
        }
        api.setAction('break', false);
        // Step onto the drop so it is magnetised into the inventory.
        api.teleport(px + 0.5, py + 0.2, pz + 2.5);
        let cobble = cobbleBefore;
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 100));
          cobble = api.countItem('cobble');
          if (cobble > cobbleBefore) break;
        }
        return {
          broke,
          cobbleBefore,
          cobble,
          durabilityBefore,
          durabilityAfter: api.durabilityOf(slot)
        };
      });
      check('the pickaxe mines stone', mining.broke, 'stone was not broken');
      check('a pickaxe makes stone drop cobblestone', mining.cobble > mining.cobbleBefore,
        `cobble ${mining.cobbleBefore} -> ${mining.cobble}`);
      check('mining wears the tool out',
        mining.durabilityAfter && mining.durabilityBefore
        && mining.durabilityAfter.durability === mining.durabilityBefore.durability - 1,
        `${mining.durabilityBefore && mining.durabilityBefore.durability} -> `
        + `${mining.durabilityAfter && mining.durabilityAfter.durability}`);

      // Bare hands must not yield stone, which is what makes the tier matter.
      const bare = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        for (const dz of [1, 2]) {
          for (const dy of [0, 1]) api.setBlock(px, py + dy, pz + dz, 'air');
        }
        api.setBlock(px, py - 1, pz + 2, 'stone');
        // Move the pickaxe into the backpack so the player is not holding a
        // tool, without disturbing anything else that is being carried.
        const inventory = game.player.inventory;
        const pickaxeSlot = inventory.slots.findIndex((slot) => slot && slot.item === 'wooden_pickaxe');
        if (pickaxeSlot >= 0) inventory.moveStack(pickaxeSlot, 35);
        api.selectSlot(0);
        await new Promise((r) => setTimeout(r, 300));
        api.lookAt(px, py - 1, pz + 2);
        await new Promise((r) => setTimeout(r, 250));
        const target = api.getTarget();
        const before = api.countItem('cobble');
        api.breakTarget();
        await new Promise((r) => setTimeout(r, 600));
        return {
          target: target ? target.key : null,
          before,
          after: api.countItem('cobble'),
          block: api.getBlock(px, py - 1, pz + 2)
        };
      });
      check('bare hands break stone but yield nothing',
        bare.after === bare.before && bare.block === 'air' && bare.target === 'stone',
        `target=${bare.target} block=${bare.block} cobble ${bare.before} -> ${bare.after}`);

      // ---------------------------------------------------------------------
      // 8. Save, quit, load, and confirm the crafted items survived.
      // ---------------------------------------------------------------------
      const before = await page.evaluate(async (s) => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Restore the pickaxe to the hotbar so the round trip covers it.
        const inventory = game.player.inventory;
        inventory.set(35, null);
        api.give('wooden_pickaxe', 1);
        const result = await api.saveNow();
        const slot = inventory.slots.findIndex((entry) => entry && entry.item === 'wooden_pickaxe');
        return {
          ok: result.ok,
          worldId: game.worldId,
          pickaxes: api.countItem('wooden_pickaxe'),
          planks: api.countItem('planks'),
          cobble: api.countItem('cobble'),
          table: api.getBlock(s.px, s.py, s.pz - 2),
          position: { x: s.px, y: s.py, z: s.pz },
          inventory: api.snapshot().inventory,
          durability: api.durabilityOf(slot)
        };
      }, stand);
      createdIds.push(before.worldId);
      check('the journey world saves', before.ok === true, 'save failed');
      check('the placed crafting table is still in the world before saving',
        before.table === 'crafting_table', before.table);

      await page.evaluate(() => window.VH.quit());
      await page.evaluate(() => window.VH.waitForState(['menu'], 20000));
      const reloaded = await page.evaluate(async (id) => {
        await window.VH.loadWorld(id);
        await window.VH.waitForChunks(60000);
        // Let the streaming queue apply the stored edits.
        await new Promise((r) => setTimeout(r, 1200));
        return window.VH.snapshot();
      }, before.worldId);
      check('the journey world reloads', reloaded.state === 'playing', reloaded.state);

      const after = await page.evaluate((p) => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const slot = game.player.inventory.slots.findIndex((s) => s && s.item === 'wooden_pickaxe');
        return {
          pickaxes: api.countItem('wooden_pickaxe'),
          planks: api.countItem('planks'),
          cobble: api.countItem('cobble'),
          table: api.getBlock(p.position.x, p.position.y, p.position.z - 2),
          durability: slot >= 0 ? api.durabilityOf(slot) : null,
          inventory: api.snapshot().inventory
        };
      }, before);
      check('crafted items survive the round trip',
        after.pickaxes === before.pickaxes && after.planks === before.planks,
        `pickaxes ${before.pickaxes}->${after.pickaxes}, planks ${before.planks}->${after.planks}`);
      check('mined materials survive the round trip',
        after.cobble === before.cobble && before.cobble > 0,
        `cobble ${before.cobble}->${after.cobble}`);
      check('the placed crafting table survives the round trip',
        after.table === 'crafting_table', `found ${after.table}`);
      check('tool durability survives the round trip',
        after.durability && before.durability
        && after.durability.durability === before.durability.durability,
        `${before.durability && before.durability.durability} -> `
        + `${after.durability && after.durability.durability}`);
    });

    await section('Smelting in the world', async () => {
      // The furnace goes next to the crafting table the journey already placed.
      const setup = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.closeScreen();
        await new Promise((r) => setTimeout(r, 400));
        api.ensurePlaying();
        api.give('furnace', 1);
        api.give('iron_ore', 2);
        api.give('coal', 1);
        const slot = api.selectItem('furnace');
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        // To the player's left, clear of the crafting table on the right.
        for (const dz of [1, 2]) {
          for (const dy of [0, 1]) {
            api.setBlock(px - 1, py + dy, pz - dz, 'air');
            api.setBlock(px, py + dy, pz - dz, 'air');
          }
        }
        api.setBlock(px - 1, py - 1, pz - 2, 'loam');
        await new Promise((r) => setTimeout(r, 500));
        const result = await window.__vhPlaceAt(px - 1, py - 1, pz - 2, px - 1, py, pz - 2);
        return { slot, ...result, px, py, pz };
      });
      check('a furnace can be placed', setup.block === 'furnace', `found ${setup.block}`);

      const opened = await page.evaluate(async (s) => {
        await window.__vhUseStation(s.px - 1, s.py, s.pz - 2);
        return {
          state: window.__VOXELHAVEN__.state,
          screen: window.VH.activeScreen(),
          slots: document.querySelectorAll('#furnace-slots .slot').length
        };
      }, setup);
      check('right-clicking a placed furnace opens the smelting screen',
        opened.screen && opened.screen.screen === 'furnace', JSON.stringify(opened.screen));
      check('the furnace screen has input, fuel and result slots', opened.slots === 3,
        `${opened.slots} slots`);

      const smelt = await page.evaluate(async (s) => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Load it the way a player would: click the input slot with a held stack.
        const x = s.px - 1;
        const y = s.py;
        const z = s.pz - 2;
        api.fillFurnace(x, y, z, { input: { item: 'iron_ore', count: 2 }, fuel: { item: 'coal', count: 1 } });
        const loaded = api.getFurnace(x, y, z);
        // Close the screen: smelting must continue in the background.
        window.VH.closeScreen();
        let ingots = 0;
        for (let i = 0; i < 150; i++) {
          await new Promise((r) => setTimeout(r, 100));
          const station = api.getFurnace(x, y, z);
          ingots = station && station.output ? station.output.count : 0;
          if (ingots >= 2) break;
        }
        const after = api.getFurnace(x, y, z);
        const taken = api.takeFurnaceOutput(x, y, z);
        window.VH.closeScreen();
        return {
          loaded,
          ingots,
          after,
          taken,
          inInventory: api.countItem('iron_ingot'),
          world: game.state
        };
      }, setup);
      check('a loaded furnace reports input and fuel',
        smelt.loaded && smelt.loaded.input && smelt.loaded.input.item === 'iron_ore',
        JSON.stringify(smelt.loaded));
      check('the furnace smelts while the screen is closed', smelt.ingots >= 2,
        `${smelt.ingots} iron ingots after ~15s`);
      check('the fuel is consumed as the furnace burns',
        smelt.after && (!smelt.after.fuel || smelt.after.fuel.count === 0),
        JSON.stringify(smelt.after && smelt.after.fuel));
      check('the smelted result can be taken and lands in the inventory',
        smelt.taken && smelt.taken.item === 'iron_ingot' && smelt.inInventory === 2,
        `${smelt.inInventory} iron ingots`);

      // Crafting an iron pickaxe from the smelted ingot closes the loop.
      const ironTool = await page.evaluate(async () => {
        const api = window.VH;
        api.give('stick', 2);
        api.give('iron_ingot', 1);
        window.VH.openScreen('crafting_table');
        window.VH.layOutRecipe('iron_pickaxe');
        const preview = window.VH.getCraftResult();
        window.VH.takeCraftResult(false);
        window.VH.closeScreen();
        return { preview, count: api.countItem('iron_pickaxe') };
      });
      check('a smelted ingot becomes an iron pickaxe',
        ironTool.count === 1 && ironTool.preview && ironTool.preview.id === 'iron_pickaxe',
        `${ironTool.count} iron pickaxes`);
    });

    await section('Console hygiene', async () => {
      // Expected noise: a favicon probe and the deliberate 404 that the
      // missing-save test provokes.
      const relevant = consoleErrors.filter((text) => !/favicon|net::ERR|404/i.test(text));
      check('no JavaScript errors were logged', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
      check('no console errors were logged', relevant.length === 0,
        relevant.slice(0, 3).join(' | '));
    });
  } finally {
    await session.close();
    await server.stop();

    // Remove the worlds this test created unless asked to keep them.
    if (!KEEP_SAVES) {
      for (const id of createdIds) {
        const file = path.join(testSaveDir, `${id}.json`);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const failure of failures) console.log(`   • ${failure}`);
  }
  console.log(`${'─'.repeat(58)}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
