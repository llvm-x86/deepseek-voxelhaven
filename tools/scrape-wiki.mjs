/**
 * scrape-wiki.mjs — build Voxelhaven's recipe corpus from the Minecraft Wiki.
 *
 * Development tool. Run it by hand; the game never touches the network.
 *
 *   node tools/scrape-wiki.mjs                 # fetch what is missing, then stop
 *   node tools/scrape-wiki.mjs --refresh       # ignore the cache and re-fetch
 *   node tools/scrape-wiki.mjs --max-pages 20  # smaller bounded run
 *
 * Output: tools/cache/crafting-corpus.json — every crafting and smelting
 * recipe found, in a normalised shape. Turning that corpus into
 * `src/data/recipes.json` is a separate, offline step
 * (`tools/build-recipes.mjs`) so the mapping table can be iterated on without
 * re-fetching anything.
 *
 * Acquisition strategy, and why it is not the one first suggested:
 *  1. The Semantic MediaWiki `ask` API described by the wiki's data
 *     architecture page is **not enabled** on minecraft.wiki — `action=ask`
 *     answers `badvalue: Unrecognized value for parameter "action"`.
 *  2. `robots.txt` additionally disallows `/*api.php`, `/*rest.php/`,
 *     `/*rest_v1/` and *every* URL containing `action=`. Both the SMW bulk
 *     query and `index.php?action=raw` are therefore off limits. The scraper
 *     verifies this at start-up and refuses to use those routes.
 *  3. The permitted route is an ordinary page view, `GET /w/<Title>`. The
 *     crafting index (`/w/Crafting`) and its per-category subpages render
 *     **every** recipe with its complete, alias-expanded grid, and item pages
 *     render their smelting recipes. A dozen requests therefore covers the
 *     whole corpus — far less crawling than fetching several hundred item
 *     pages would need.
 *  4. Everything is cached under tools/cache/wiki/ and re-runs are offline.
 */

import fs from 'node:fs';
import path from 'node:path';
import { WikiClient, PROJECT_ROOT, WIKI_HOST } from './lib/wiki-client.mjs';
import { extractPage, extractIndexSubpages, extractRecipeGrids } from './lib/recipe-extract.mjs';

/** The crafting index; its subpages carry the complete recipe tables. */
const CRAFTING_INDEX = 'Crafting';

/** Fallback subpage list, used only if the index page cannot be read. */
const FALLBACK_INDEX_PAGES = [
  'Crafting/Building blocks',
  'Crafting/Decoration blocks',
  'Crafting/Redstone',
  'Crafting/Transportation',
  'Crafting/Foodstuffs',
  'Crafting/Tools',
  'Crafting/Utilities',
  'Crafting/Combat',
  'Crafting/Brewing',
  'Crafting/Materials',
  'Crafting/Miscellaneous'
];

/**
 * Pages holding smelting recipes. Smelting is not part of the crafting index,
 * so the handful of outputs Voxelhaven can actually use are read from their
 * own pages. Kept deliberately short: this is bounded scope, not a crawl.
 */
const SMELTING_PAGES = [
  'Iron Ingot',
  'Glass',
  'Charcoal',
  'Stone',
  'Cobblestone',
  'Sand',
  'Iron Ore',
  'Sandstone',
  'Cactus'
];

/** Where the normalised corpus is written. */
const CORPUS_PATH = path.join(PROJECT_ROOT, 'tools', 'cache', 'crafting-corpus.json');

/** Parse `--flag value` style arguments. */
function parseArgs(argv) {
  const out = { refresh: false, maxPages: 40, verbose: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--refresh') out.refresh = true;
    else if (arg === '--quiet') out.verbose = false;
    else if (arg === '--max-pages') out.maxPages = Number(argv[++i]);
    else if (arg.startsWith('--max-pages=')) out.maxPages = Number(arg.split('=')[1]);
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: node tools/scrape-wiki.mjs [--refresh] [--max-pages N] [--quiet]');
      process.exit(0);
    }
  }
  if (!Number.isFinite(out.maxPages) || out.maxPages < 1) out.maxPages = 40;
  return out;
}

/** Today's date as YYYY-MM-DD, in UTC so runs are reproducible. */
function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Main entry point. */
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const client = new WikiClient({ refresh: options.refresh, verbose: options.verbose });

  await client.loadRobots();

  // Prove, in the open, which routes robots.txt permits. The two routes the
  // task description suggested are both disallowed here, so the scraper uses
  // the page-view route instead and says so.
  const apiVerdict = client.checkRobots('/api.php?action=ask&format=json');
  const rawVerdict = client.checkRobots('/index.php?title=Crafting_Table&action=raw');
  const pageVerdict = client.checkRobots('/w/Crafting_Table');
  console.log(`[robots] /api.php?action=ask      ${apiVerdict.allowed ? 'allowed' : `DISALLOWED (${apiVerdict.rule})`}`);
  console.log(`[robots] /index.php?...&action=raw ${rawVerdict.allowed ? 'allowed' : `DISALLOWED (${rawVerdict.rule})`}`);
  console.log(`[robots] /w/Crafting_Table         ${pageVerdict.allowed ? 'allowed' : `DISALLOWED (${pageVerdict.rule})`}`);
  if (!pageVerdict.allowed) {
    console.error('[wiki] robots.txt forbids even plain page views; stopping without fetching.');
    process.exit(2);
  }

  // -------------------------------------------------------------------------
  // 1. Discover the crafting index subpages.
  // -------------------------------------------------------------------------
  let indexPages = FALLBACK_INDEX_PAGES.slice();
  try {
    const indexHtml = await client.page(CRAFTING_INDEX);
    const discovered = extractIndexSubpages(indexHtml);
    if (discovered.length > 0) indexPages = discovered;
    console.log(`[index] ${CRAFTING_INDEX}: ${discovered.length} subpages discovered`);
  } catch (err) {
    console.warn(`[index] falling back to the built-in subpage list: ${err.message}`);
  }

  // -------------------------------------------------------------------------
  // 2. Read every crafting recipe from the index subpages.
  // -------------------------------------------------------------------------
  const budget = Math.min(indexPages.length, options.maxPages);
  const crafting = [];
  const smelting = [];
  const other = [];
  const pagesFetched = [];
  /** @type {Record<string, number>} */
  const perCategory = {};

  for (let i = 0; i < budget; i++) {
    const title = indexPages[i];
    let html;
    try {
      html = await client.page(title);
    } catch (err) {
      console.warn(`[page] ${title}: ${err.message}`);
      continue;
    }
    pagesFetched.push(title);
    const result = extractPage(html, title, title);
    crafting.push(...result.crafting);
    smelting.push(...result.smelting);
    other.push(...result.other);
    perCategory[title] = result.crafting.length;
    if (options.verbose) {
      console.log(`[page] ${title}: ${result.crafting.length} crafting grids (${extractRecipeGrids(html)} seen)`);
    }
  }

  // -------------------------------------------------------------------------
  // 3. Read smelting recipes from the pages that define them.
  // -------------------------------------------------------------------------
  for (const title of SMELTING_PAGES) {
    let html;
    try {
      html = await client.page(title);
    } catch (err) {
      console.warn(`[smelt] ${title}: ${err.message}`);
      continue;
    }
    pagesFetched.push(title);
    const result = extractPage(html, title, 'Smelting');
    smelting.push(...result.smelting);
    other.push(...result.other);
    if (options.verbose) console.log(`[smelt] ${title}: ${result.smelting.length} smelting recipes`);
  }

  // -------------------------------------------------------------------------
  // 4. De-duplicate. The same recipe appears on an index page and again in the
  //    "crafting usage" tables of the pages that consume it, so identity is
  //    the recipe itself, not the page it was read from.
  // -------------------------------------------------------------------------
  const uniqueCrafting = dedupeCrafting(crafting);
  const uniqueSmelting = dedupeSmelting(smelting);

  const corpus = {
    source: 'Minecraft Wiki (minecraft.wiki), Crafting recipe data',
    sourceUrl: `${WIKI_HOST}/w/${CRAFTING_INDEX}`,
    license: 'CC BY-NC-SA 3.0',
    retrieved: today(),
    userAgent: 'VoxelhavenRecipeScraper/1.0',
    indexPages,
    indexSubpagesUsed: pagesFetched.slice(0, budget),
    smeltingPages: SMELTING_PAGES.slice(),
    pagesFetched: [...new Set(pagesFetched)].sort(),
    categories: perCategory,
    crafting: uniqueCrafting,
    smelting: uniqueSmelting,
    outOfScopeStations: [...new Set(other)].sort()
  };

  fs.mkdirSync(path.dirname(CORPUS_PATH), { recursive: true });
  fs.writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  const bytes = fs.statSync(CORPUS_PATH).size;

  console.log('');
  console.log('──────────────── scraper summary ────────────────');
  console.log(`  retrieval date          ${corpus.retrieved}`);
  console.log(`  index subpages used     ${Math.min(budget, indexPages.length)} of ${indexPages.length}`);
  console.log(`  pages fetched           ${corpus.pagesFetched.length} (${client.cacheHits} cache hits, ${client.networkRequests} network requests)`);
  console.log(`  crafting recipes        ${uniqueCrafting.length} unique (${crafting.length} raw)`);
  console.log(`  smelting recipes        ${uniqueSmelting.length} unique (${smelting.length} raw)`);
  console.log(`  out-of-scope stations   ${corpus.outOfScopeStations.length ? corpus.outOfScopeStations.join(', ') : 'none seen'}`);
  console.log(`  corpus written to       ${path.relative(PROJECT_ROOT, CORPUS_PATH)} (${(bytes / 1024).toFixed(0)} KB)`);
  console.log('─────────────────────────────────────────────────');
}

/**
 * Collapse duplicate crafting grids, keeping the first occurrence in
 * deterministic (page, index) order.
 * @param {object[]} records
 */
export function dedupeCrafting(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const key = JSON.stringify([
      record.variants, record.outputs, record.shapeless, record.matching
    ]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

/** Collapse duplicate smelting recipes. */
export function dedupeSmelting(records) {
  const seen = new Set();
  const out = [];
  for (const record of records) {
    const key = JSON.stringify([record.inputs, record.output]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(record);
  }
  return out;
}

main().catch((err) => {
  console.error('[scrape-wiki] failed:', err);
  process.exit(1);
});
