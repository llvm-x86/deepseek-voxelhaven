/**
 * RecipeBook.js — loads and indexes the vendored recipe snapshot.
 *
 * The game never touches the network: `src/data/recipes.json` is generated
 * offline by `tools/build-recipes.mjs` from a cached wiki corpus and committed
 * with the source. It is fetched once at boot, over the same static file
 * server that serves the rest of the game.
 *
 * The book pre-computes the indexes `Crafting.match()` needs, so matching a
 * grid is a couple of map lookups plus a handful of comparisons rather than a
 * scan over every recipe in the corpus.
 *
 * This module is DOM-free and importable from plain Node (the test suite does
 * exactly that), so it must never touch `fetch` at import time.
 */

/** Where the snapshot lives, relative to index.html. */
export const RECIPES_URL = 'src/data/recipes.json';

/**
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {'shaped'|'shapeless'} type
 * @property {string} name
 * @property {string[]} [pattern]      shaped: rows top to bottom, ' ' = empty
 * @property {number} [width]
 * @property {number} [height]
 * @property {Record<string,string[]>} [key] shaped: symbol -> accepted names
 * @property {string[][]} [ingredients] shapeless: accepted names per ingredient
 * @property {{item:string,count:number}} output
 * @property {boolean} [mirrored]
 * @property {boolean} [matching]
 * @property {Record<string,{item:string,count:number}>} [remainder] per symbol
 * @property {Record<string,number>} [counts] per symbol, default 1
 * @property {'inventory'|'crafting_table'} [station]
 */

/**
 * @typedef {Object} SmeltingRecipe
 * @property {string} id
 * @property {string[]} inputs
 * @property {{item:string,count:number}} output
 * @property {number} seconds
 * @property {number} experience
 */

/**
 * Build a book (with its indexes) from parsed recipe data.
 *
 * @param {object} data parsed contents of src/data/recipes.json
 * @returns {object} the book
 */
export function createBook(data) {
  const tags = {};
  for (const [name, members] of Object.entries(data.tags || {})) {
    tags[name] = Array.isArray(members) ? members.slice() : [];
  }
  const recipes = (data.recipes || []).map(normaliseRecipe);
  const smelting = (data.smelting || []).map((entry) => ({ ...entry }));

  /** @type {Map<string, Recipe>} */
  const byId = new Map();
  /** @type {Map<string, Recipe[]>} */
  const byOutput = new Map();
  /** @type {Map<string, Recipe[]>} shaped recipes keyed by occupied-cell mask */
  const byMask = new Map();
  /** @type {Map<number, Recipe[]>} shapeless recipes keyed by ingredient count */
  const shapelessBySize = new Map();

  /**
   * Expand one accepted name (an item key or a tag name) into item keys.
   * @param {string} name
   * @returns {string[]}
   */
  const expand = (name) => (tags[name] ? tags[name] : [name]);

  for (const recipe of recipes) {
    if (byId.has(recipe.id)) throw new Error(`[RecipeBook] duplicate recipe id "${recipe.id}"`);
    byId.set(recipe.id, recipe);

    if (!byOutput.has(recipe.output.item)) byOutput.set(recipe.output.item, []);
    byOutput.get(recipe.output.item).push(recipe);

    if (recipe.type === 'shapeless') {
      const size = recipe.ingredients.length;
      if (!shapelessBySize.has(size)) shapelessBySize.set(size, []);
      shapelessBySize.get(size).push(recipe);
      continue;
    }

    // A shaped recipe is registered under every orientation it accepts, so a
    // lookup by the grid's own bounding-box mask finds it directly.
    const masks = new Set([maskOfPattern(recipe.pattern)]);
    if (recipe.mirrored) masks.add(maskOfPattern(mirrorPattern(recipe.pattern)));
    for (const mask of masks) {
      if (!byMask.has(mask)) byMask.set(mask, []);
      const bucket = byMask.get(mask);
      if (!bucket.includes(recipe)) bucket.push(recipe);
    }
  }

  /** @type {Map<string, SmeltingRecipe>} */
  const smeltingById = new Map();
  /** @type {Map<string, SmeltingRecipe[]>} */
  const smeltingByInput = new Map();
  for (const entry of smelting) {
    smeltingById.set(entry.id, entry);
    for (const input of entry.inputs) {
      if (!smeltingByInput.has(input)) smeltingByInput.set(input, []);
      smeltingByInput.get(input).push(entry);
    }
  }

  const fuels = { ...(data.fuels || {}) };

  return {
    source: data.source || '',
    license: data.license || '',
    retrieved: data.retrieved || '',
    attribution: data.attribution || '',
    tags,
    recipes,
    smelting,
    fuels,

    /** Item keys a tag accepts. */
    tagMembers(name) {
      return tags[name] ? tags[name].slice() : [name];
    },

    /** True when the name is a tag rather than an item key. */
    isTag(name) {
      return Object.prototype.hasOwnProperty.call(tags, name);
    },

    /** Look up a recipe by its stable id. */
    byId(id) {
      return byId.get(id) || null;
    },

    /** Recipes that produce an item, for the recipe browser. */
    byOutput(itemKey) {
      return (byOutput.get(itemKey) || []).slice();
    },

    /** Every recipe that produces anything at all, in stable id order. */
    outputs() {
      return [...byOutput.keys()].sort();
    },

    /** Shaped candidates whose bounding box has this mask. */
    shapedCandidates(mask) {
      return byMask.get(mask) || [];
    },

    /** Shapeless candidates with this many ingredients. */
    shapelessCandidates(size) {
      return shapelessBySize.get(size) || [];
    },

    /** The smelting recipe for an input item, or null. */
    smeltingFor(itemKey) {
      const list = smeltingByInput.get(itemKey);
      return list && list.length > 0 ? list[0] : null;
    },

    /** How many items one unit of this fuel smelts (0 when it is not a fuel). */
    fuelValue(itemKey) {
      return typeof fuels[itemKey] === 'number' ? fuels[itemKey] : 0;
    },

    /** Aggregate counts for diagnostics and the test suite. */
    stats() {
      return {
        recipes: recipes.length,
        shaped: recipes.filter((recipe) => recipe.type === 'shaped').length,
        shapeless: recipes.filter((recipe) => recipe.type === 'shapeless').length,
        smelting: smelting.length,
        tags: Object.keys(tags).length,
        outputs: byOutput.size
      };
    }
  };
}

/** Fill in the defaults a recipe is allowed to omit. */
function normaliseRecipe(recipe) {
  const copy = { ...recipe };
  copy.mirrored = copy.mirrored === true;
  copy.matching = copy.matching === true;
  if (copy.type === 'shaped') {
    // The generator already strips empty border rows and columns, but a
    // hand-written or third-party recipe may not have, and an untrimmed
    // pattern would never match a grid normalised to its own bounding box.
    const trimmed = trimPattern(copy.pattern || []);
    copy.pattern = trimmed.pattern;
    copy.width = trimmed.width;
    copy.height = trimmed.height;
  }
  return copy;
}

/**
 * Strip empty border rows and columns from a shaped pattern.
 * @param {string[]} pattern
 * @returns {{pattern:string[], width:number, height:number}}
 */
export function trimPattern(pattern) {
  const rows = pattern.filter((row) => typeof row === 'string');
  if (rows.length === 0) return { pattern: [], width: 0, height: 0 };
  const width = Math.max(...rows.map((row) => row.length), 0);
  const grid = rows.map((row) => row.padEnd(width, ' ').split(''));

  let top = 0;
  let bottom = grid.length - 1;
  while (top <= bottom && grid[top].every((cell) => cell === ' ')) top++;
  while (bottom >= top && grid[bottom].every((cell) => cell === ' ')) bottom--;
  if (top > bottom) return { pattern: [], width: 0, height: 0 };

  let left = 0;
  let right = width - 1;
  const columnUsed = (index) => grid.slice(top, bottom + 1).some((row) => row[index] !== ' ');
  while (left <= right && !columnUsed(left)) left++;
  while (right >= left && !columnUsed(right)) right--;

  return {
    pattern: grid.slice(top, bottom + 1).map((row) => row.slice(left, right + 1).join('')),
    width: right - left + 1,
    height: bottom - top + 1
  };
}

/** Flip a shaped pattern horizontally. */
export function mirrorPattern(pattern) {
  return pattern.map((row) => row.split('').reverse().join(''));
}

/**
 * Encode the occupied cells of a pattern as a lookup key. Slots that are
 * present contribute '1', gaps '0'; the size prefix keeps a 1x3 bar distinct
 * from a 3x1 bar.
 *
 * @param {string[]} pattern
 * @returns {string}
 */
export function maskOfPattern(pattern) {
  const height = pattern.length;
  const width = height > 0 ? pattern[0].length : 0;
  const rows = pattern.map((row) => row.split('').map((c) => (c === ' ' ? '0' : '1')).join(''));
  return `${width}x${height}|${rows.join('/')}`;
}

/**
 * The bounding box of the occupied cells of a grid, normalised so it can be
 * compared against a recipe pattern regardless of where it sits in the grid.
 *
 * @param {Array<{item:string,count:number}|null>} grid row-major, size*size
 * @param {number} size
 * @returns {{originX:number,originY:number,width:number,height:number,cells:(object|null)[][],mask:string}|null}
 */
export function boundingBox(grid, size) {
  let minX = size;
  let minY = size;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const slot = grid[y * size + x];
      if (!slot || slot.count <= 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return null;

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;
  const cells = [];
  const maskRows = [];
  for (let y = 0; y < height; y++) {
    const row = [];
    let maskRow = '';
    for (let x = 0; x < width; x++) {
      const slot = grid[(minY + y) * size + (minX + x)];
      const present = slot && slot.count > 0 ? slot : null;
      row.push(present);
      maskRow += present ? '1' : '0';
    }
    cells.push(row);
    maskRows.push(maskRow);
  }
  return { originX: minX, originY: minY, width, height, cells, mask: `${width}x${height}|${maskRows.join('/')}` };
}

/** The default, shared book, populated by `RecipeBook.load()`. */
const RecipeBook = {
  /** @type {object|null} */
  book: null,
  /** Populated when loading failed, so the UI can explain what happened. */
  error: null,
  /** True once a snapshot has been loaded. */
  loaded: false,

  /**
   * Fetch and index the snapshot. Safe to call more than once.
   * @param {string} [url]
   * @returns {Promise<object>} the loaded book
   */
  async load(url = RECIPES_URL) {
    if (this.loaded && this.book) return this.book;
    if (typeof fetch !== 'function') throw new Error('[RecipeBook] no fetch implementation is available');
    const response = await fetch(url);
    if (!response.ok) throw new Error(`[RecipeBook] could not load ${url}: HTTP ${response.status}`);
    const data = await response.json();
    this.book = createBook(data);
    this.loaded = true;
    this.error = null;
    return this.book;
  },

  /** Load from an already parsed object (used by the offline tests). */
  adopt(data) {
    this.book = createBook(data);
    this.loaded = true;
    this.error = null;
    return this.book;
  },

  /** Record a load failure without breaking the game. */
  fail(error) {
    this.error = error instanceof Error ? error.message : String(error);
    this.book = createBook({ tags: {}, recipes: [], smelting: [], fuels: {} });
    this.loaded = false;
    return this.book;
  },

  /**
   * The active book. Always returns something usable: before the snapshot has
   * loaded it is an empty book, so callers never have to null-check.
   * @returns {object}
   */
  current() {
    if (!this.book) this.book = createBook({ tags: {}, recipes: [], smelting: [], fuels: {} });
    return this.book;
  },

  /** True when the real snapshot (rather than the empty placeholder) is live. */
  get isReady() {
    return this.loaded && !!this.book;
  },

  /** Drop the loaded snapshot (used between test cases). */
  reset() {
    this.book = null;
    this.loaded = false;
    this.error = null;
  }
};

export { RecipeBook };
export default RecipeBook;
