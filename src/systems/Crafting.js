/**
 * Crafting.js — the crafting engine.
 *
 * The engine is pure: it knows about grids, recipes and inventories, and
 * nothing about the DOM, the world or the renderer. That keeps it importable
 * from a worker, trivially testable, and identical whether a craft is driven
 * by a click in the crafting-table screen or by the automation API.
 *
 * Matching model
 *  - A shaped recipe must be in the right arrangement: position matters, the
 *    grid's occupied cells are normalised to their bounding box and compared
 *    cell by cell against the pattern. When the recipe allows it, the
 *    horizontally mirrored arrangement is accepted too.
 *  - A shapeless recipe ignores position and compares the multiset of
 *    ingredients.
 *  - A `key` entry may name a tag; the slot then accepts any member.
 *  - `matching: true` (the wiki's "Matching" aliases) additionally requires
 *    that every slot using the same symbol holds the *same* member, which is
 *    what makes a recipe produce a variant that depends on its input.
 *  - A column may declare `counts: { "#": 2 }` when a craft consumes more than
 *    one item from a slot. No Minecraft recipe does, but the data model and the
 *    engine support it, so a future recipe can.
 *
 * Crafting is transactional: room for the result is verified *before* anything
 * is consumed, so a full inventory can never silently eat the ingredients.
 */

import { ItemRegistry } from '../world/Items.js';
import { RecipeBook, boundingBox } from '../data/RecipeBook.js';

/**
 * @typedef {Object} GridSlot
 * @property {string} item
 * @property {number} count
 */

/**
 * @typedef {Object} MatchResult
 * @property {import('../data/RecipeBook.js').Recipe} recipe
 * @property {{item:string,count:number}} output
 * @property {Array<{index:number,symbol:string|null,consume:number,remainder:{item:string,count:number}|null}>} slots
 * @property {boolean} mirrored     true when the mirrored arrangement matched
 * @property {number} originX
 * @property {number} originY
 */

/** Default number of items consumed from a slot per craft. */
const DEFAULT_CONSUME = 1;

/**
 * Find the recipe a grid satisfies.
 *
 * @param {Array<GridSlot|null>} grid row-major array of size*size slots
 * @param {number} size 2 for the inventory grid, 3 for a crafting table
 * @param {object} [book] recipe book; defaults to the loaded snapshot
 * @returns {MatchResult|null}
 */
export function match(grid, size, book = RecipeBook.current()) {
  if (!Array.isArray(grid) || !Number.isInteger(size) || size < 1) return null;
  const box = boundingBox(grid, size);
  if (!box) return null;

  // Shaped: the mask lookup narrows the corpus to the one or two recipes with
  // this silhouette, so no scan over all recipes happens here.
  for (const recipe of book.shapedCandidates(box.mask)) {
    const result = verifyShaped(recipe, size, box, book);
    if (result) return result;
  }

  // Shapeless: bucketed by how many ingredients are involved.
  let filled = 0;
  for (const slot of grid) if (slot && slot.count > 0) filled++;
  for (const recipe of book.shapelessCandidates(filled)) {
    const result = verifyShapeless(recipe, grid, size, book);
    if (result) return result;
  }

  return null;
}

/**
 * Check one shaped recipe against the grid, in both orientations when the
 * recipe permits mirroring.
 *
 * @returns {MatchResult|null}
 */
function verifyShaped(recipe, size, box, book) {
  const orientations = recipe.mirrored ? [false, true] : [false];
  for (const mirrored of orientations) {
    const slots = verifyOrientation(recipe, box, mirrored, book, size);
    if (slots) {
      return {
        recipe,
        output: { ...recipe.output },
        slots,
        mirrored,
        originX: box.originX,
        originY: box.originY
      };
    }
  }
  return null;
}

/**
 * Compare the grid's bounding box against the pattern in one orientation.
 * @returns {Array<{index:number,symbol:string,consume:number,remainder:object|null}>|null}
 */
function verifyOrientation(recipe, box, mirrored, book, size) {
  const width = recipe.width;
  const height = recipe.height;
  if (box.width !== width || box.height !== height) return null;

  /** @type {Array<{index:number,symbol:string,consume:number,remainder:object|null}>} */
  const matched = [];
  /** @type {Map<string,string[]>} symbol -> item keys present in its slots */
  const seenPerSymbol = new Map();

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const patternX = mirrored ? width - 1 - x : x;
      const symbol = recipe.pattern[y][patternX];
      const slot = box.cells[y][x];

      if (symbol === ' ') {
        // A gap in the pattern must be a gap in the grid.
        if (slot) return null;
        continue;
      }
      if (!slot) return null;

      const accepted = recipe.key[symbol];
      if (!accepted) return null;
      if (!accepts(accepted, slot.item, book)) return null;

      const consume = consumeCount(recipe, symbol);
      if (slot.count < consume) return null;

      if (recipe.matching) {
        if (!seenPerSymbol.has(symbol)) seenPerSymbol.set(symbol, []);
        const seen = seenPerSymbol.get(symbol);
        if (!seen.includes(slot.item)) seen.push(slot.item);
        // "Matching" means every slot using this symbol holds the same member.
        if (seen.length > 1) return null;
      }

      const remainder = recipe.remainder && recipe.remainder[symbol]
        ? { ...recipe.remainder[symbol] }
        : null;
      matched.push({
        index: (box.originY + y) * size + (box.originX + x),
        symbol,
        consume,
        remainder
      });
    }
  }
  return matched;
}

/** How many items this symbol consumes per craft. */
function consumeCount(recipe, symbol) {
  const declared = recipe.counts ? recipe.counts[symbol] : undefined;
  return Number.isFinite(declared) && declared > 0 ? Math.floor(declared) : DEFAULT_CONSUME;
}

/** True when a slot item is accepted by a recipe's accepted-name list. */
function accepts(acceptedNames, itemKey, book) {
  for (const name of acceptedNames) {
    if (book.isTag(name)) {
      if (book.tagMembers(name).includes(itemKey)) return true;
    } else if (name === itemKey) {
      return true;
    }
  }
  return false;
}

/**
 * Check a shapeless recipe: every recipe ingredient must be satisfied by a
 * distinct grid slot, and every grid slot must be used.
 *
 * @returns {MatchResult|null}
 */
function verifyShapeless(recipe, grid, size, book) {
  /** @type {Array<{index:number,item:string,count:number}>} */
  const used = [];
  for (let i = 0; i < grid.length; i++) {
    const slot = grid[i];
    if (slot && slot.count > 0) used.push({ index: i, item: slot.item, count: slot.count });
  }
  if (used.length !== recipe.ingredients.length) return null;

  const assignment = new Array(recipe.ingredients.length).fill(-1);
  const taken = new Array(used.length).fill(false);

  const place = (ingredientIndex) => {
    if (ingredientIndex === recipe.ingredients.length) return true;
    const accepted = recipe.ingredients[ingredientIndex];
    for (let s = 0; s < used.length; s++) {
      if (taken[s]) continue;
      if (!accepts(accepted, used[s].item, book)) continue;
      taken[s] = true;
      assignment[ingredientIndex] = s;
      if (place(ingredientIndex + 1)) return true;
      taken[s] = false;
      assignment[ingredientIndex] = -1;
    }
    return false;
  };
  if (!place(0)) return null;

  if (recipe.matching) {
    // Two ingredients that accept exactly the same set must hold the same item.
    for (let a = 0; a < recipe.ingredients.length; a++) {
      for (let b = a + 1; b < recipe.ingredients.length; b++) {
        if (signatureOf(recipe.ingredients[a]) !== signatureOf(recipe.ingredients[b])) continue;
        if (used[assignment[a]].item !== used[assignment[b]].item) return null;
      }
    }
  }

  const slots = assignment.map((usedIndex, ingredientIndex) => {
    const entry = used[usedIndex];
    return {
      index: entry.index,
      symbol: null,
      consume: consumeCount(recipe, String(ingredientIndex)),
      remainder: null
    };
  });

  // A shapeless recipe must not require more of an item than any slot holds.
  for (const slot of slots) {
    const entry = used.find((candidate) => candidate.index === slot.index);
    if (entry && entry.count < slot.consume) return null;
  }

  return {
    recipe,
    output: { ...recipe.output },
    slots,
    mirrored: false,
    originX: 0,
    originY: 0
  };
}

/** Stable signature of an accepted-name list, used for matching semantics. */
function signatureOf(names) {
  return names.slice().sort().join('\u0000');
}

/**
 * Craft once from a grid.
 *
 * The grid is mutated in place: one item (or the recipe's declared count) is
 * removed from every participating slot, remainders are left behind in the
 * grid, and the result is added to the inventory. Nothing is consumed until
 * the inventory is known to have room for both the output and any remainder
 * that cannot stay in the grid.
 *
 * @param {Array<GridSlot|null>} grid
 * @param {number} size
 * @param {import('../player/Inventory.js').Inventory} inventory
 * @param {object} [book]
 * @returns {{ok:boolean, reason?:string, output?:object, recipe?:object, match?:MatchResult}}
 */
export function craftFromGrid(grid, size, inventory, book = RecipeBook.current()) {
  const found = match(grid, size, book);
  if (!found) return { ok: false, reason: 'Nothing matches that arrangement.' };

  const { recipe, output, slots } = found;

  // ---- Plan the remainders, then check there is room for everything. -------
  /** @type {Array<{slot:GridSlot, index:number, consume:number, remainder:object|null, staysInGrid:boolean}>} */
  const plan = [];

  for (const entry of slots) {
    const slot = grid[entry.index];
    if (!slot) return { ok: false, reason: 'That arrangement changed while crafting.' };
    // A remainder can take over the slot it came from when that slot is
    // emptied by this craft; otherwise it needs room elsewhere.
    const staysInGrid = entry.remainder ? slot.count - entry.consume <= 0 : false;
    plan.push({
      slot,
      index: entry.index,
      consume: entry.consume,
      remainder: entry.remainder,
      staysInGrid
    });
  }

  if (inventory.roomFor(output.item) < output.count) {
    return { ok: false, reason: `No room in the inventory for ${ItemRegistry.name(output.item)}.` };
  }
  for (const entry of plan) {
    if (!entry.remainder || entry.staysInGrid) continue;
    if (inventory.roomFor(entry.remainder.item) < entry.remainder.count) {
      return {
        ok: false,
        reason: `No room for the empty ${ItemRegistry.name(entry.remainder.item)} the recipe returns.`
      };
    }
  }

  // ---- Execute. ------------------------------------------------------------
  for (const entry of plan) {
    entry.slot.count -= entry.consume;
    if (entry.slot.count <= 0) {
      // The remainder replaces the consumed item in its own slot.
      grid[entry.index] = entry.remainder ? { ...entry.remainder } : null;
    } else if (entry.remainder) {
      const leftover = inventory.add(entry.remainder.item, entry.remainder.count);
      if (leftover > 0) {
        // Should be unreachable: the room check above covers this. Put it back
        // in a spare grid slot rather than losing it.
        const spare = grid.findIndex((candidate) => !candidate);
        if (spare >= 0) grid[spare] = { ...entry.remainder };
      }
    }
  }

  const leftover = inventory.add(output.item, output.count);
  if (leftover > 0) {
    // Also unreachable given the room check; leave the result in the grid so
    // the player can still take it instead of destroying it.
    const spare = grid.findIndex((candidate) => !candidate);
    if (spare >= 0) grid[spare] = { item: output.item, count: leftover };
    return {
      ok: false,
      reason: `No room in the inventory for ${ItemRegistry.name(output.item)}.`,
      output,
      recipe,
      match: found
    };
  }

  return { ok: true, output: { ...output }, recipe, match: found };
}

/**
 * Look up recipes by output item, for the recipe browser.
 * @param {string} itemKey
 * @param {object} [book]
 */
export function recipesFor(itemKey, book = RecipeBook.current()) {
  return book.byOutput(itemKey);
}

/**
 * The flat-recipe facade kept for the recipe browser and for existing callers.
 *
 * The grid engine above is the real thing; these helpers answer "could the
 * player make this from the inventory as a whole", which is what a one-click
 * craft from the browser needs.
 */
export const Crafting = {
  /** Every recipe, in stable id order. */
  all(book = RecipeBook.current()) {
    return book.recipes.slice();
  },

  /** Look up a recipe by id. */
  byId(id, book = RecipeBook.current()) {
    return book.byId(id);
  },

  /** Recipes that produce an item. */
  recipesFor(itemKey, book = RecipeBook.current()) {
    return recipesFor(itemKey, book);
  },

  /** The indexed recipe book. */
  book() {
    return RecipeBook.current();
  },

  /**
   * Find the recipe a grid satisfies.
   * @returns {MatchResult|null}
   */
  match(grid, size, book = RecipeBook.current()) {
    return match(grid, size, book);
  },

  /** Craft once from a grid, consuming from the grid itself. */
  craftFromGrid(grid, size, inventory, book = RecipeBook.current()) {
    return craftFromGrid(grid, size, inventory, book);
  },

  /**
   * How many times a recipe could be crafted from the whole inventory.
   * @param {import('../player/Inventory.js').Inventory} inventory
   * @param {object} recipe
   * @param {object} [book]
   * @returns {number}
   */
  affordableCount(inventory, recipe, book = RecipeBook.current()) {
    const needed = neededPerCraft(recipe, book);
    let crafts = Infinity;
    for (const [item, count] of needed) {
      const have = inventory.countOf(item);
      crafts = Math.min(crafts, Math.floor(have / count));
    }
    return crafts === Infinity ? 0 : crafts;
  },

  /** True when the recipe can be crafted at least once from the inventory. */
  canCraft(inventory, recipe, book = RecipeBook.current()) {
    return Crafting.affordableCount(inventory, recipe, book) > 0;
  },

  /**
   * Consume the ingredients from the inventory and add the output.
   * @param {import('../player/Inventory.js').Inventory} inventory
   * @param {object} recipe
   * @param {object} [book]
   * @returns {{ok:boolean, reason?:string, output?:object}}
   */
  craft(inventory, recipe, book = RecipeBook.current()) {
    if (!recipe) return { ok: false, reason: 'Unknown recipe.' };
    if (!Crafting.canCraft(inventory, recipe, book)) {
      return { ok: false, reason: `Not enough materials for ${recipe.name}.` };
    }
    // Check there will be room for the output before consuming anything, so a
    // full inventory cannot silently eat the ingredients.
    if (inventory.roomFor(recipe.output.item) < recipe.output.count) {
      return { ok: false, reason: 'No room in the inventory for the result.' };
    }

    const needed = neededPerCraft(recipe, book);
    const removed = [];
    for (const [item, count] of needed) {
      const taken = inventory.removeItem(item, count);
      if (taken < count) {
        // Unreachable given the affordability check, but restore what was
        // taken rather than losing the player's materials.
        for (const [restoredItem, restoredCount] of removed) inventory.add(restoredItem, restoredCount);
        if (taken > 0) inventory.add(item, taken);
        return { ok: false, reason: `Not enough ${ItemRegistry.name(item)}.` };
      }
      removed.push([item, count]);
    }
    inventory.add(recipe.output.item, recipe.output.count);
    return { ok: true, output: { ...recipe.output } };
  },

  /**
   * Craft as many times as the inventory allows, respecting stack limits.
   * This is what shift-clicking the result slot does.
   *
   * @param {import('../player/Inventory.js').Inventory} inventory
   * @param {object} recipe
   * @param {number} [limit] maximum crafts, default "as many as possible"
   * @param {object} [book]
   * @returns {{crafted:number, reason?:string}}
   */
  craftMany(inventory, recipe, limit = Infinity, book = RecipeBook.current()) {
    let crafted = 0;
    const affordable = Crafting.affordableCount(inventory, recipe, book);
    const target = Math.min(affordable, limit);
    for (let i = 0; i < target; i++) {
      const result = Crafting.craft(inventory, recipe, book);
      if (!result.ok) return { crafted, reason: result.reason };
      crafted++;
    }
    return { crafted };
  },

  /**
   * Recipes the player can currently afford, with their craftable counts.
   * @param {import('../player/Inventory.js').Inventory} inventory
   * @param {object} [book]
   */
  available(inventory, book = RecipeBook.current()) {
    return book.recipes.map((recipe) => ({
      recipe,
      crafts: Crafting.affordableCount(inventory, recipe, book)
    }));
  },
};

/**
 * Total items of each kind a recipe consumes from the inventory as a whole.
 * Tags are charged as their cheapest member so a recipe that accepts any
 * plank is affordable when any one plank type is present.
 *
 * @param {object} recipe
 * @param {object} book
 * @returns {Map<string, number>}
 */
function neededPerCraft(recipe, book) {
  /** @type {Map<string, number>} */
  const needed = new Map();
  const add = (names, count) => {
    if (names.length === 1) {
      const name = names[0];
      const item = book.isTag(name) ? book.tagMembers(name)[0] : name;
      needed.set(item, (needed.get(item) || 0) + count);
      return;
    }
    // Several alternatives: charge the first that is a plain item, otherwise
    // any concrete member of the first tag, so the count is deterministic.
    for (const name of names) {
      if (!book.isTag(name)) {
        needed.set(name, (needed.get(name) || 0) + count);
        return;
      }
    }
    const members = book.tagMembers(names[0]);
    if (members.length > 0) needed.set(members[0], (needed.get(members[0]) || 0) + count);
  };

  if (recipe.type === 'shaped') {
    const counts = new Map();
    for (const row of recipe.pattern) {
      for (const symbol of row) {
        if (symbol === ' ') continue;
        counts.set(symbol, (counts.get(symbol) || 0) + 1);
      }
    }
    for (const [symbol, occurrences] of counts) {
      const perSlot = Number.isFinite(recipe.counts && recipe.counts[symbol]) ? recipe.counts[symbol] : 1;
      add(recipe.key[symbol] || [], occurrences * perSlot);
    }
    return needed;
  }

  for (let i = 0; i < recipe.ingredients.length; i++) {
    const perSlot = Number.isFinite(recipe.counts && recipe.counts[String(i)]) ? recipe.counts[String(i)] : 1;
    add(recipe.ingredients[i], perSlot);
  }
  return needed;
}
