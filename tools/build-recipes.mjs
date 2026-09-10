/**
 * build-recipes.mjs — turn the cached wiki corpus into `src/data/recipes.json`.
 *
 * This step is completely offline and pure: given the same corpus and the same
 * mapping table it always writes byte-identical output. That is what makes the
 * shipped snapshot reproducible, and it is asserted by the test suite.
 *
 *   node tools/build-recipes.mjs            # rebuild src/data/recipes.json
 *   node tools/build-recipes.mjs --report   # also print every skipped recipe
 *
 * The transform:
 *   1. resolves each wiki ingredient name to Voxelhaven item keys through
 *      tools/mappings/item-map.json (exact names, then patterns, then tags);
 *   2. drops any recipe that names something Voxelhaven does not have — the
 *      reason is logged, never silently ignored;
 *   3. normalises shaped patterns (strip empty borders, assign slot symbols,
 *      compute the bounding box);
 *   4. validates every emitted item key against the real ItemRegistry, so a
 *      recipe can never reference an item that does not exist;
 *   5. sorts everything by a stable key before serialising.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ItemRegistry } from '../src/world/Items.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..');

export const CORPUS_PATH = path.join(PROJECT_ROOT, 'tools', 'cache', 'crafting-corpus.json');
export const MAP_PATH = path.join(PROJECT_ROOT, 'tools', 'mappings', 'item-map.json');
export const OUTPUT_PATH = path.join(PROJECT_ROOT, 'src', 'data', 'recipes.json');

/** Slot symbols, in assignment order. '#' first, as the data model documents. */
const SYMBOLS = ['#', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L'];

/**
 * Resolve one wiki ingredient name to Voxelhaven item keys.
 *
 * @param {string} name
 * @param {object} mapping parsed item-map.json
 * @returns {{keys:string[], via:'item'|'pattern'|'tag', detail:string}|null}
 */
export function resolveName(name, mapping) {
  const cleaned = String(name || '').trim();
  if (!cleaned) return null;

  const exact = mapping.items[cleaned];
  if (typeof exact === 'string') return { keys: [exact], via: 'item', detail: cleaned };

  for (const pattern of mapping.patterns || []) {
    if (new RegExp(pattern.match).test(cleaned)) {
      return { keys: [pattern.item], via: 'pattern', detail: pattern.match };
    }
  }

  // `Any <alias>` / `Matching <alias>` are already expanded into concrete item
  // names by the wiki renderer, but the alias names themselves still appear in
  // a few places (the furnace's "Any stone-tier block"), so accept them too.
  for (const prefix of ['Any ', 'Matching ']) {
    if (!cleaned.startsWith(prefix)) continue;
    const rest = cleaned.slice(prefix.length).trim();
    for (const [tagName, tag] of Object.entries(mapping.tags || {})) {
      if (!tag.wikiAliases.some((alias) => alias.toLowerCase() === rest.toLowerCase())) continue;
      return { keys: tag.members.slice(), via: 'tag', detail: tagName };
    }
  }
  for (const [tagName, tag] of Object.entries(mapping.tags || {})) {
    if (!tag.wikiAliases.some((alias) => alias.toLowerCase() === cleaned.toLowerCase())) continue;
    return { keys: tag.members.slice(), via: 'tag', detail: tagName };
  }

  return null;
}

/**
 * Resolve a list of alternative wiki names (one grid slot, or one output) to a
 * deduplicated list of Voxelhaven item keys.
 *
 * @param {string[]} names
 * @param {object} mapping
 * @param {(name:string)=>void} [onUnmapped]
 * @returns {string[]}
 */
export function resolveList(names, mapping, onUnmapped) {
  const keys = [];
  for (const name of names) {
    const resolved = resolveName(name, mapping);
    if (!resolved) {
      if (onUnmapped) onUnmapped(name);
      continue;
    }
    for (const key of resolved.keys) if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

/**
 * Collapse a resolved key list onto a tag name when it is exactly that tag's
 * member set. This keeps `key` entries readable and, more importantly, keeps
 * the wiki's alias semantics visible in the shipped data instead of flattening
 * them into an anonymous list.
 *
 * @param {string[]} keys
 * @param {object} mapping
 * @returns {string[]} the key list, or `[tagName]`
 */
export function collapseToTag(keys, mapping) {
  for (const [tagName, tag] of Object.entries(mapping.tags || {})) {
    if (tag.members.length !== keys.length) continue;
    const same = tag.members.every((member) => keys.includes(member));
    if (same) return [tagName];
  }
  return keys.slice();
}

/** Assign slot symbols to a resolved 9-slot grid. */
function assignSymbols(resolvedSlots) {
  /** @type {Map<string,string>} */
  const bySignature = new Map();
  let next = 0;
  const symbols = resolvedSlots.map((keys) => {
    if (!keys || keys.length === 0) return ' ';
    const signature = keys.join('\u0000');
    if (!bySignature.has(signature)) {
      bySignature.set(signature, SYMBOLS[next++]);
    }
    return bySignature.get(signature);
  });
  return { symbols, bySignature };
}

/** Strip empty border rows and columns from a 3x3 symbol grid. */
function trimPattern(symbols) {
  const rows = [0, 1, 2].map((r) => symbols.slice(r * 3, r * 3 + 3));
  let top = 0;
  let bottom = 2;
  while (top <= bottom && rows[top].every((c) => c === ' ')) top++;
  while (bottom >= top && rows[bottom].every((c) => c === ' ')) bottom--;
  if (top > bottom) return { pattern: [], width: 0, height: 0 };

  let left = 0;
  let right = 2;
  const occupiedColumn = (c) => rows.slice(top, bottom + 1).some((row) => row[c] !== ' ');
  while (left <= right && !occupiedColumn(left)) left++;
  while (right >= left && !occupiedColumn(right)) right--;

  const pattern = rows.slice(top, bottom + 1).map((row) => row.slice(left, right + 1).join(''));
  return { pattern, width: right - left + 1, height: bottom - top + 1 };
}

/**
 * Build a stable recipe id.
 *
 * A recipe whose output has exactly one recipe is simply named after that
 * output ("planks", "stick"), which is the natural handle for the UI and the
 * tests. When an item has several recipes the ingredient list is appended, so
 * "iron_ingot_from_iron_block" and "iron_ingot_from_iron_nugget" stay distinct.
 *
 * @param {string} outputItem
 * @param {string[]} ingredientLists flattened item keys
 * @param {Set<string>} taken
 */
function makeId(outputItem, ingredientLists, taken, uniqueOutput) {
  const base = uniqueOutput
    ? outputItem
    : `${outputItem}_from_${[...new Set(ingredientLists.flat())].sort().join('_')}`;
  let id = base;
  let counter = 2;
  while (taken.has(id)) id = `${base}_${counter++}`;
  taken.add(id);
  return id;
}

/**
 * Transform the corpus into the shipped data file.
 *
 * @param {object} corpus
 * @param {object} mapping
 * @param {{has:(key:string)=>boolean, name:(key:string)=>string}} registry
 * @returns {{data:object, report:object}}
 */
export function buildRecipes(corpus, mapping, registry) {
  const report = {
    craftingRead: corpus.crafting.length,
    smeltingRead: corpus.smelting.length,
    craftingKept: 0,
    smeltingKept: 0,
    skipped: [],
    unmappedNames: new Map(),
    patternHits: new Map(),
    tagUsage: new Map(),
    keyErrors: []
  };

  const noteUnmapped = (name) => {
    const key = String(name || '').trim();
    if (!key) return;
    report.unmappedNames.set(key, (report.unmappedNames.get(key) || 0) + 1);
  };

  const resolveSlot = (names) => {
    const keys = resolveList(names, mapping, noteUnmapped);
    return keys;
  };

  /** @type {object[]} */
  const recipes = [];
  const takenIds = new Set();
  /** Recipes that are byte-identical after the item mapping collapsed them. */
  const seenSignatures = new Set();

  for (const record of corpus.crafting) {
    // ---- Outputs ---------------------------------------------------------
    const outputKeys = [];
    for (const output of record.outputs) {
      const resolved = resolveName(output.name, mapping);
      if (!resolved) { noteUnmapped(output.name); continue; }
      if (resolved.via === 'pattern') report.patternHits.set(output.name, resolved.detail);
      if (resolved.keys.length !== 1) {
        report.skipped.push({ page: record.page, index: record.index, reason: `output "${output.name}" maps to ${resolved.keys.length} items` });
        continue;
      }
      outputKeys.push({ item: resolved.keys[0], count: output.count });
    }
    if (outputKeys.length === 0) {
      report.skipped.push({ page: record.page, index: record.index, reason: `no supported output (${record.outputs.map((o) => o.name).join(', ')})` });
      continue;
    }

    // ---- Ingredients -----------------------------------------------------
    const slots = record.variants.map((names) => {
      for (const name of names) {
        const resolved = resolveName(name, mapping);
        if (resolved && resolved.via === 'pattern') report.patternHits.set(name, resolved.detail);
      }
      return resolveSlot(names);
    });
    const emptySlots = slots.filter((keys) => keys.length === 0).length;
    if (!record.shapeless && emptySlots === 9) {
      report.skipped.push({ page: record.page, index: record.index, reason: 'no supported ingredients' });
      continue;
    }

    // A slot that names items but resolves to nothing means the recipe needs
    // something Voxelhaven does not have; the whole recipe is dropped rather
    // than shipped in a half-usable state.
    const unusable = record.variants.some((names, i) => names.length > 0 && slots[i].length === 0);
    if (unusable) {
      const missing = record.variants
        .filter((names, i) => names.length > 0 && slots[i].length === 0)
        .map((names) => names.slice(0, 3).join('/'))
        .join(', ');
      report.skipped.push({ page: record.page, index: record.index, reason: `unsupported ingredient(s): ${missing}` });
      continue;
    }

    // Mapping several wiki items onto one Voxelhaven item can collapse a real
    // vanilla recipe into a self-referential one — "Oak Wood from 4 Oak Logs"
    // becomes "Timber from 4 Timber" once logs and bark blocks are the same
    // item. Shipping that would be a lossy no-op, so it is dropped.
    const ingredientKeys = new Set(slots.flat());
    if (record.outputs.some((output) => ingredientKeys.has(resolveName(output.name, mapping)?.keys[0]))) {
      report.skipped.push({
        page: record.page,
        index: record.index,
        reason: `collapses to a self-referential recipe after mapping (${record.outputs.map((o) => o.name).join(', ')})`
      });
      continue;
    }

    // ---- Which output does this recipe make? -----------------------------
    // The wiki animates recipes that produce a different variant per
    // ingredient (every plank species). When all of those variants collapse
    // onto the same Voxelhaven item the recipe is emitted once, with the
    // aliases kept as alternatives.
    const distinctOutputs = [...new Set(outputKeys.map((o) => o.item))];
    const outputGroups = distinctOutputs.length === 1
      ? [outputKeys]
      : outputKeys.filter((output, i) => outputKeys.findIndex((o) => o.item === output.item) === i).map((output) => [output]);

    for (const group of outputGroups) {
      const output = group[0];
      if (emptySlots === 9) {
        report.skipped.push({ page: record.page, index: record.index, reason: 'shapeless recipe with no supported ingredients' });
        continue;
      }
      const ingredientLists = slots.filter((keys) => keys.length > 0);

      let entry;
      if (record.shapeless) {
        entry = {
          id: '',
          type: 'shapeless',
          name: registry.name(output.item),
          ingredients: ingredientLists.map((keys) => collapseToTag(keys, mapping)),
          output: { item: output.item, count: output.count }
        };
      } else {
        const { symbols, bySignature } = assignSymbols(slots);
        const trimmed = trimPattern(symbols);
        if (trimmed.pattern.length === 0) {
          report.skipped.push({ page: record.page, index: record.index, reason: 'empty pattern after normalisation' });
          continue;
        }
        /** @type {Record<string,string[]>} */
        const key = {};
        for (const [signature, symbol] of bySignature) {
          key[symbol] = collapseToTag(signature.split('\u0000'), mapping);
        }
        entry = {
          id: '',
          type: 'shaped',
          name: registry.name(output.item),
          pattern: trimmed.pattern,
          width: trimmed.width,
          height: trimmed.height,
          key,
          output: { item: output.item, count: output.count },
          mirrored: !record.fixed,
          matching: record.matching === true
        };
        if (trimmed.width > 2 || trimmed.height > 2) entry.station = 'crafting_table';
      }

      // Remaining grid slot count: the inventory screen only offers 2x2.
      if (!entry.station) entry.station = 'inventory';
      entry.origin = 'minecraft-wiki';
      entry.source = { page: record.page, category: record.category || null };

      // Two different wiki invocations can collapse onto the same Voxelhaven
      // recipe once the item mapping is applied; keep the first and say so.
      const signature = JSON.stringify([
        entry.type, entry.pattern || null, entry.key || null, entry.ingredients || null,
        entry.output, entry.matching, entry.remainder || null, entry.counts || null
      ]);
      if (seenSignatures.has(signature)) {
        report.skipped.push({ page: record.page, index: record.index, reason: 'duplicate of an earlier recipe after mapping' });
        continue;
      }
      seenSignatures.add(signature);
      // Ids are assigned in a second pass, once every recipe is known: whether
      // an output needs disambiguating depends on the whole corpus.
      entry.id = null;
      entry.ingredientKeys = [...new Set(ingredientLists.flat())].sort();

      for (const list of ingredientLists) {
        for (const name of list) {
          if (mapping.tags && mapping.tags[name]) report.tagUsage.set(name, (report.tagUsage.get(name) || 0) + 1);
        }
      }
      recipes.push(entry);
      report.craftingKept++;
    }
  }

  // ---- Hand-written Voxelhaven recipes ------------------------------------
  for (const extra of mapping.voxelhavenRecipes || []) {
    let entry;
    let ingredientLists;

    if (extra.type === 'shapeless') {
      ingredientLists = extra.ingredients.map((names) => names.flatMap((name) => (
        mapping.tags && mapping.tags[name] ? mapping.tags[name].members : [name]
      )));
      entry = {
        id: extra.id,
        type: 'shapeless',
        name: registry.name(extra.output.item),
        ingredients: ingredientLists.map((keys) => collapseToTag(keys, mapping)),
        output: { item: extra.output.item, count: extra.output.count },
        station: extra.ingredients.length > 4 ? 'crafting_table' : 'inventory'
      };
    } else {
      const flatPattern = extra.pattern.join('').split('');
      const cellLists = flatPattern.map((symbol) => {
        if (symbol === ' ') return [];
        const accepted = extra.key[symbol];
        if (!accepted) return [];
        return accepted.flatMap((name) => (mapping.tags && mapping.tags[name] ? mapping.tags[name].members : [name]));
      });
      const { symbols, bySignature } = assignSymbols(cellLists);
      const trimmed = trimPattern(symbols);
      if (trimmed.pattern.length === 0) {
        throw new Error(`[build-recipes] Voxelhaven recipe "${extra.id}" has an empty pattern`);
      }
      const key = {};
      for (const [signature, symbol] of bySignature) {
        key[symbol] = collapseToTag(signature.split('\u0000'), mapping);
      }

      // Remainders are declared against the hand-written symbols, so they have
      // to be re-keyed onto the symbols the compiler assigned.
      const symbolMap = new Map();
      for (let i = 0; i < flatPattern.length; i++) {
        if (flatPattern[i] !== ' ') symbolMap.set(flatPattern[i], symbols[i]);
      }
      let remainder;
      if (extra.remainder) {
        remainder = {};
        for (const [symbol, item] of Object.entries(extra.remainder)) {
          const assigned = symbolMap.get(symbol);
          if (!assigned) throw new Error(`[build-recipes] "${extra.id}" declares a remainder for unused symbol "${symbol}"`);
          remainder[assigned] = { item: item.item, count: item.count };
        }
      }

      ingredientLists = Object.keys(key).map((symbol) => key[symbol]);
      entry = {
        id: extra.id,
        type: 'shaped',
        name: registry.name(extra.output.item),
        pattern: trimmed.pattern,
        width: trimmed.width,
        height: trimmed.height,
        key,
        output: { item: extra.output.item, count: extra.output.count },
        mirrored: extra.mirrored === true,
        matching: extra.matching === true,
        ...(remainder ? { remainder } : {}),
        station: trimmed.width > 2 || trimmed.height > 2 ? 'crafting_table' : 'inventory'
      };
    }

    entry.origin = 'voxelhaven';
    entry.source = { page: null, category: null, note: extra.why };

    // Id collision checks happen in the id-assignment pass below, once the
    // wiki recipes have their final names.
    const signature = JSON.stringify([
      entry.type, entry.pattern || null, entry.key || null, entry.ingredients || null,
      entry.output, entry.matching === true, entry.remainder || null, null
    ]);
    if (seenSignatures.has(signature)) {
      throw new Error(`[build-recipes] Voxelhaven recipe "${extra.id}" duplicates a wiki recipe after mapping`);
    }
    seenSignatures.add(signature);
    for (const list of ingredientLists) {
      for (const name of list) {
        if (mapping.tags && mapping.tags[name]) report.tagUsage.set(name, (report.tagUsage.get(name) || 0) + 1);
      }
    }
    recipes.push(entry);
    report.craftingKept++;
  }

  // ---- Assign ids now that the whole corpus is known -----------------------
  /** @type {Map<string, number>} how many recipes produce each item */
  const outputCounts = new Map();
  for (const recipe of recipes) {
    outputCounts.set(recipe.output.item, (outputCounts.get(recipe.output.item) || 0) + 1);
  }
  for (const recipe of recipes) {
    if (recipe.id) {
      // Hand-written recipes keep the id declared in the mapping table.
      if (takenIds.has(recipe.id)) throw new Error(`[build-recipes] duplicate recipe id "${recipe.id}"`);
      takenIds.add(recipe.id);
      continue;
    }
    recipe.id = makeId(recipe.output.item, recipe.ingredientKeys, takenIds, outputCounts.get(recipe.output.item) === 1);
    delete recipe.ingredientKeys;
  }

  // ---- Smelting ------------------------------------------------------------
  /** @type {object[]} */
  const smelting = [];
  const smeltingIds = new Set();
  for (const record of corpus.smelting) {
    const inputs = resolveList(record.inputs, mapping, noteUnmapped);
    if (inputs.length === 0) {
      report.skipped.push({ page: record.page, index: record.index, reason: `smelting input unsupported (${record.inputs.slice(0, 3).join(', ')})` });
      continue;
    }
    const outputResolved = resolveName(record.output.name, mapping);
    if (!outputResolved || outputResolved.keys.length !== 1) {
      noteUnmapped(record.output.name);
      report.skipped.push({ page: record.page, index: record.index, reason: `smelting output unsupported (${record.output.name})` });
      continue;
    }
    const outputItem = outputResolved.keys[0];
    const id = `${outputItem}_from_${[...inputs].sort().join('_')}`;
    if (smeltingIds.has(id)) continue;
    smeltingIds.add(id);
    smelting.push({
      id,
      inputs: inputs.slice().sort(),
      output: { item: outputItem, count: record.output.count },
      seconds: record.timeSeconds || mapping.smeltingTimes.default,
      experience: record.experience,
      source: { page: record.page }
    });
    report.smeltingKept++;
  }

  // ---- Tags ----------------------------------------------------------------
  const tags = {};
  for (const tagName of Object.keys(mapping.tags || {}).sort()) {
    tags[tagName] = mapping.tags[tagName].members.slice().sort();
  }

  // ---- Validation ----------------------------------------------------------
  const checkKey = (key, where) => {
    if (!registry.has(key)) report.keyErrors.push(`${where}: unknown item key "${key}"`);
  };
  for (const recipe of recipes) {
    for (const symbol of Object.keys(recipe.key || {})) {
      for (const name of recipe.key[symbol]) {
        if (tags[name]) for (const member of tags[name]) checkKey(member, recipe.id);
        else checkKey(name, recipe.id);
      }
    }
    for (const list of recipe.ingredients || []) {
      for (const name of list) {
        if (tags[name]) for (const member of tags[name]) checkKey(member, recipe.id);
        else checkKey(name, recipe.id);
      }
    }
    checkKey(recipe.output.item, recipe.id);
    for (const symbol of Object.keys(recipe.remainder || {})) {
      checkKey(recipe.remainder[symbol].item, `${recipe.id} remainder`);
    }
    if (!recipe.output.item || !(recipe.output.count > 0)) {
      report.keyErrors.push(`${recipe.id}: empty output`);
    }
  }
  for (const entry of smelting) {
    for (const name of entry.inputs) checkKey(name, entry.id);
    checkKey(entry.output.item, entry.id);
  }
  for (const [tagName, members] of Object.entries(tags)) {
    for (const member of members) checkKey(member, `tag ${tagName}`);
  }
  for (const fuel of Object.keys(mapping.fuels || {})) checkKey(fuel, 'fuels');

  if (report.keyErrors.length > 0) {
    throw new Error(`[build-recipes] recipes reference items that do not exist:\n  ${report.keyErrors.join('\n  ')}`);
  }

  // ---- Serialise (sorted, stable) -----------------------------------------
  recipes.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  smelting.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const data = {
    source: 'Minecraft Wiki (minecraft.wiki), Crafting recipe data',
    license: 'CC BY-NC-SA 3.0',
    retrieved: corpus.retrieved,
    attribution: [
      'Recipe structure derived from the Minecraft Wiki (https://minecraft.wiki),',
      `retrieved ${corpus.retrieved}, licensed CC BY-NC-SA 3.0`,
      '(https://meta.weirdgloop.org/w/Licensing). Only recipe structure — which item',
      'goes in which slot, in what quantity — is reproduced; no wiki prose, images or',
      'sprites are included. This data is used non-commercially. Voxelhaven item names,',
      'textures and code are original.'
    ].join(' '),
    sourceUrl: corpus.sourceUrl,
    generator: 'tools/build-recipes.mjs from tools/cache/crafting-corpus.json',
    tags,
    fuels: Object.fromEntries(Object.entries(mapping.fuels || {}).sort(([a], [b]) => (a < b ? -1 : 1))),
    recipes,
    smelting
  };

  report.unmappedNames = [...report.unmappedNames.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  report.patternHits = [...report.patternHits.entries()].sort();
  report.tagUsage = [...report.tagUsage.entries()].sort();
  return { data, report };
}

/** Machine-readable JSON with a trailing newline and two-space indent. */
export function serialise(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** CLI entry point. */
function main() {
  const argv = process.argv.slice(2);
  const verbose = argv.includes('--report');
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const mapping = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  const { data, report } = buildRecipes(corpus, mapping, ItemRegistry);
  const text = serialise(data);
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, text, 'utf8');

  const craftable = data.recipes.length;
  console.log('──────────────── build summary ──────────────────');
  console.log(`  corpus                  ${CORPUS_PATH.replace(`${PROJECT_ROOT}/`, '')}`);
  console.log(`  crafting recipes read   ${report.craftingRead}`);
  console.log(`  crafting recipes kept   ${craftable}`);
  console.log(`  smelting recipes read   ${report.smeltingRead}`);
  console.log(`  smelting recipes kept   ${data.smelting.length}`);
  console.log(`  recipes skipped         ${report.skipped.length}`);
  console.log(`  distinct unmapped names ${report.unmappedNames.length}`);
  console.log(`  tags emitted            ${Object.keys(data.tags).join(', ')}`);
  console.log(`  output                  ${OUTPUT_PATH.replace(`${PROJECT_ROOT}/`, '')} (${(Buffer.byteLength(text) / 1024).toFixed(1)} KB)`);
  console.log('─────────────────────────────────────────────────');

  if (verbose) {
    console.log('\nskipped crafts:');
    for (const skip of report.skipped) console.log(`  - ${skip.page}#${skip.index}: ${skip.reason}`);
  }
  console.log('\ntop unmapped wiki names (extend tools/mappings/item-map.json to support more):');
  for (const [name, count] of report.unmappedNames.slice(0, 30)) console.log(`  ${String(count).padStart(4)}  ${name}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
