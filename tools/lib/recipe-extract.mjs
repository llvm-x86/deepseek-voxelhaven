/**
 * recipe-extract.mjs — turn rendered wiki pages into normalised recipe records.
 *
 * Pure functions only: the same HTML always produces exactly the same records,
 * which is what makes the generated corpus reproducible and lets the test
 * suite assert byte-identical rebuilds without touching the network.
 *
 * Only recipe *structure* is read — which item goes in which slot, in what
 * quantity, and whether the wiki marks the recipe shapeless, fixed, or as
 * requiring matching ingredients. No prose or images are copied.
 */

import {
  parseHTML, findAll, findByClass, childrenByClass,
  hasClass, textOf, closest, itemTitle
} from './html-lite.mjs';

/** Grid slot names of the 3x3 crafting grid, row-major. */
export const SLOT_NAMES = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'];

/**
 * @typedef {Object} CraftingRecord
 * @property {string} page        page the recipe was read from
 * @property {number} index       position of the grid within that page
 * @property {string} category    index page it came from ('' for item pages)
 * @property {string[][]} variants nine entries, row-major; [] means empty,
 *                                 otherwise the accepted item names
 * @property {{name:string,count:number}[]} outputs
 * @property {boolean} shapeless
 * @property {boolean} fixed
 * @property {boolean} matching   the wiki's "Matching" alias semantics
 * @property {string} ingredients the recipe's ingredient cell, kept for auditing
 */

/**
 * @typedef {Object} SmeltingRecord
 * @property {string} page
 * @property {number} index
 * @property {string[]} inputs    accepted input item names
 * @property {{name:string,count:number}} output
 * @property {number} experience
 */

/**
 * Extract every crafting and smelting recipe rendered on one page.
 *
 * @param {string} html      rendered page HTML (`GET /w/<Title>`)
 * @param {string} pageTitle
 * @param {string} [category] index page the HTML came from
 * @returns {{crafting: CraftingRecord[], smelting: SmeltingRecord[], other: string[]}}
 */
export function extractPage(html, pageTitle, category = '') {
  const root = parseHTML(html);
  const crafting = [];
  const smelting = [];
  const other = [];

  const grids = findAll(root, (node) => hasClass(node, 'mcui'));
  for (const grid of grids) {
    if (hasClass(grid, 'mcui-Crafting_Table')) {
      const record = craftingRecord(grid, pageTitle, crafting.length, category);
      if (record) crafting.push(record);
      continue;
    }
    if (hasClass(grid, 'mcui-Furnace')) {
      const record = smeltingRecord(grid, pageTitle, smelting.length);
      if (record) smelting.push(record);
      continue;
    }
    // Smithing, stonecutting, brewing and campfire grids are recognised so the
    // scraper can report them as deliberately out of scope rather than
    // silently ignoring them.
    const kind = ['mcui-Smithing_Table', 'mcui-Stonecutter', 'mcui-Brewing_Stand', 'mcui-Campfire']
      .find((name) => hasClass(grid, name));
    if (kind) other.push(`${pageTitle}: ${kind.replace('mcui-', '')}`);
  }

  return { crafting, smelting, other };
}

/**
 * Convert one rendered crafting grid into a record.
 *
 * @param {import('./html-lite.mjs').HtmlNode} grid
 * @param {string} pageTitle
 * @param {number} index
 * @param {string} category
 * @returns {CraftingRecord|null}
 */
export function craftingRecord(grid, pageTitle, index, category) {
  const input = findByClass(grid, 'mcui-input')[0];
  if (!input) return null;

  /** @type {string[][]} */
  const variants = SLOT_NAMES.map(() => []);
  const rows = childrenByClass(input, 'mcui-row');
  for (let row = 0; row < rows.length && row < 3; row++) {
    const slots = childrenByClass(rows[row], 'invslot');
    for (let column = 0; column < slots.length && column < 3; column++) {
      const names = [];
      for (const item of findByClass(slots[column], 'invslot-item')) {
        const title = itemTitle(item);
        if (title && !names.includes(title)) names.push(title);
      }
      variants[row * 3 + column] = names;
    }
  }

  const outputCell = findByClass(grid, 'mcui-output')[0];
  if (!outputCell) return null;
  const outputNames = [];
  for (const item of findByClass(outputCell, 'invslot-item')) {
    const title = itemTitle(item);
    if (title && !outputNames.includes(title)) outputNames.push(title);
  }
  if (outputNames.length === 0) return null;

  const countNode = findByClass(outputCell, 'invslot-stacksize')[0];
  const parsedCount = countNode ? Number(textOf(countNode)) : 1;
  const count = Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1;

  const ingredients = ingredientsCellText(grid);
  return {
    page: pageTitle,
    index,
    category,
    variants,
    outputs: outputNames.map((name) => ({ name, count })),
    shapeless: findByClass(grid, 'mcui-shapeless').length > 0,
    fixed: findByClass(grid, 'mcui-fixed').length > 0,
    // "Matching" is an alias qualifier the wiki prints in the ingredient cell;
    // it means every slot using that alias must hold the same member.
    matching: /\bMatching\b/.test(ingredients),
    ingredients
  };
}

/**
 * Convert one rendered furnace grid into a smelting record.
 *
 * The furnace grid lists the smeltable input first and the fuel after an
 * `mcui-fuel` separator; Voxelhaven keeps its own fuel table, so only the
 * input and the result are read.
 *
 * @param {import('./html-lite.mjs').HtmlNode} grid
 * @param {string} pageTitle
 * @param {number} index
 * @returns {SmeltingRecord|null}
 */
export function smeltingRecord(grid, pageTitle, index) {
  const input = findByClass(grid, 'mcui-input')[0];
  const outputCell = findByClass(grid, 'mcui-output')[0];
  if (!input || !outputCell) return null;

  const inputs = [];
  for (const child of input.children) {
    if (hasClass(child, 'mcui-fuel')) break; // everything after this is fuel
    if (!hasClass(child, 'invslot')) continue;
    for (const item of findByClass(child, 'invslot-item')) {
      const title = itemTitle(item);
      if (title && !inputs.includes(title)) inputs.push(title);
    }
  }
  if (inputs.length === 0) return null;

  const outputItem = findByClass(outputCell, 'invslot-item')[0];
  const outputName = outputItem ? itemTitle(outputItem) : null;
  if (!outputName) return null;
  const countNode = findByClass(outputCell, 'invslot-stacksize')[0];
  const parsedCount = countNode ? Number(textOf(countNode)) : 1;

  const experienceNode = findByClass(grid, 'mcui-experience-text')[0];
  const parsedExperience = experienceNode ? Number(textOf(experienceNode)) : 0;

  return {
    page: pageTitle,
    index,
    inputs,
    output: { name: outputName, count: Number.isFinite(parsedCount) && parsedCount > 0 ? parsedCount : 1 },
    experience: Number.isFinite(parsedExperience) ? parsedExperience : 0
  };
}

/**
 * The "Ingredients" cell that precedes a recipe grid, used for auditing and for
 * detecting the wiki's `Matching` qualifier.
 *
 * @param {import('./html-lite.mjs').HtmlNode} grid
 * @returns {string}
 */
export function ingredientsCellText(grid) {
  const row = closest(grid, (node) => node.tag === 'tr');
  if (!row) return '';
  const cells = row.children.filter((child) => child.tag === 'td' || child.tag === 'th');
  let recipeIndex = -1;
  for (let i = 0; i < cells.length; i++) {
    if (closest(grid, (node) => node === cells[i])) { recipeIndex = i; break; }
  }
  if (recipeIndex === -1) return '';
  for (let i = recipeIndex - 1; i >= 0; i--) {
    if (cells[i].tag === 'td') return textOf(cells[i]);
  }
  return '';
}

/**
 * Pull the output item page titles out of a rendered crafting-index page.
 *
 * Used to report coverage (which items the index claims to contain) and to
 * build the smelting page list. Only the recipe result cells are read.
 *
 * @param {string} html
 * @returns {string[]} unique page titles in document order
 */
export function extractRecipeGrids(html) {
  const root = parseHTML(html);
  return findAll(root, (node) => hasClass(node, 'mcui') && hasClass(node, 'mcui-Crafting_Table')).length;
}

/**
 * Derive the crafting-index subpage titles linked from `/w/Crafting`.
 *
 * @param {string} html rendered index page
 * @returns {string[]} unique `Crafting/...` page titles, document order
 */
export function extractIndexSubpages(html) {
  const root = parseHTML(html);
  const titles = [];
  for (const anchor of findAll(root, (node) => node.tag === 'a')) {
    const href = anchor.attrs.href || '';
    const match = /^\/w\/(Crafting\/[^"#?]+)$/.exec(href);
    if (!match) continue;
    const title = decodeURIComponent(match[1]).replace(/_/g, ' ');
    if (!titles.includes(title)) titles.push(title);
  }
  return titles;
}
