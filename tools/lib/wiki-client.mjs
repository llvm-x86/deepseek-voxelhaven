/**
 * wiki-client.mjs — a polite, caching HTTP client for minecraft.wiki.
 *
 * This is a **development tool**. Nothing here is ever imported by the game;
 * the runtime reads the vendored `src/data/recipes.json` snapshot instead.
 *
 * Behaviour that matters:
 *  - Parses `robots.txt` and refuses to touch a disallowed path. On
 *    minecraft.wiki that rules out `/*api.php`, `/*rest.php/`, `/*rest_v1/`
 *    **and every URL carrying `action=`** — so neither the Semantic MediaWiki
 *    ask API nor `index.php?action=raw` may be used. The only permitted read
 *    route is an ordinary page view, `GET /w/<Title>`.
 *  - At most one request per second across the whole process.
 *  - Exponential backoff on 429/5xx, honouring `Retry-After`.
 *  - Every response is cached on disk under `tools/cache/wiki/`, so a second
 *    run is completely offline and byte-for-byte identical.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Host serving the wiki. Kept in one place so the tool is easy to retarget. */
export const WIKI_HOST = 'https://minecraft.wiki';

/** Contact string embedded in the User-Agent, as the wiki's policy asks. */
const CONTACT = 'voxelhaven-dev@example.invalid';

/** Descriptive User-Agent identifying the project, its purpose and a contact. */
export const USER_AGENT =
  `VoxelhavenRecipeScraper/1.0 (+https://example.invalid/voxelhaven; ` +
  `development recipe-format scraper; contact: ${CONTACT})`;

/** Minimum milliseconds between two outbound requests. */
const MIN_REQUEST_INTERVAL_MS = 1000;

/** Retry policy for transient failures. */
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

/** @type {number} epoch ms of the last request actually sent */
let lastRequestAt = 0;

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} RobotsRules
 * @property {string[]} disallow
 * @property {string[]} allow
 * @property {number|null} crawlDelay seconds
 * @property {string} raw
 */

/**
 * Parse the `User-agent: *` group of a robots.txt document.
 *
 * Only the wildcard group is considered: the wiki's rules for named bots do
 * not apply to us, and treating every group as one union would be far stricter
 * than the standard requires.
 *
 * @param {string} text
 * @returns {RobotsRules}
 */
export function parseRobots(text) {
  const lines = String(text || '').split(/\r?\n/);
  const disallow = [];
  const allow = [];
  let crawlDelay = null;
  let inWildcardGroup = false;
  let sawGroup = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'user-agent') {
      // A new group starts; only the `*` group applies to this tool.
      inWildcardGroup = value === '*';
      sawGroup = true;
      continue;
    }
    if (!sawGroup || !inWildcardGroup) continue;
    if (field === 'disallow' && value) disallow.push(value);
    else if (field === 'allow' && value) allow.push(value);
    else if (field === 'crawl-delay') {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) crawlDelay = seconds;
    }
  }
  return { disallow, allow, crawlDelay, raw: String(text || '') };
}

/**
 * Translate one robots.txt path pattern into a regular expression.
 * Supports `*` (any run of characters) and a trailing `$` (end anchor).
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
export function robotsPatternToRegExp(pattern) {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchored ? '$' : ''}`);
}

/**
 * Decide whether a path (including its query string) may be requested.
 * Longest-match wins, with `Allow` beating `Disallow` on a tie, per the
 * de-facto robots.txt standard.
 *
 * @param {RobotsRules} rules
 * @param {string} pathAndQuery
 * @returns {{allowed:boolean, rule:string|null}}
 */
export function robotsAllows(rules, pathAndQuery) {
  let best = null;
  const consider = (patterns, allowed) => {
    for (const pattern of patterns) {
      const regex = robotsPatternToRegExp(pattern);
      if (!regex.test(pathAndQuery)) continue;
      const length = pattern.replace(/\$$/, '').length;
      if (!best || length > best.length || (length === best.length && allowed && !best.allowed)) {
        best = { length, allowed, rule: pattern };
      }
    }
  };
  consider(rules.disallow, false);
  consider(rules.allow, true);
  return best ? { allowed: best.allowed, rule: best.rule } : { allowed: true, rule: null };
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** Directory holding raw cached responses. */
export const CACHE_DIR = path.join(PROJECT_ROOT, 'tools', 'cache', 'wiki');

/** Turn a page title into a stable, filesystem-safe cache file name. */
export function cacheFileName(title, extension = 'html') {
  const safe = String(title).replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 120);
  return `${safe}.${extension}`;
}

/** Full cache path for a page title. */
export function cachePath(title, extension = 'html') {
  return path.join(CACHE_DIR, cacheFileName(title, extension));
}

/** Read a cached response, or null. */
export function readCache(title, extension = 'html') {
  try {
    return fs.readFileSync(cachePath(title, extension), 'utf8');
  } catch {
    return null;
  }
}

/** Write a response into the cache. */
export function writeCache(title, text, extension = 'html') {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(cachePath(title, extension), text, 'utf8');
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class WikiClient {
  /**
   * @param {{refresh?:boolean, verbose?:boolean, minIntervalMs?:number}} [options]
   */
  constructor(options = {}) {
    /** When true, ignore the cache and re-fetch everything. */
    this.refresh = options.refresh === true;
    this.verbose = options.verbose !== false;
    this.minIntervalMs = options.minIntervalMs === undefined
      ? MIN_REQUEST_INTERVAL_MS
      : Math.max(0, options.minIntervalMs);
    /** @type {RobotsRules|null} */
    this.robots = null;
    /** Number of network requests this client actually performed. */
    this.networkRequests = 0;
    /** Number of responses served from disk. */
    this.cacheHits = 0;
  }

  /** Load and cache robots.txt. Must be awaited before the first fetch. */
  async loadRobots() {
    if (this.robots) return this.robots;
    const text = await this._request('/robots.txt', { cache: false });
    this.robots = parseRobots(text);
    if (this.verbose) {
      console.log(`[wiki] robots.txt loaded: ${this.robots.disallow.length} disallow rules`
        + (this.robots.crawlDelay ? `, crawl-delay ${this.robots.crawlDelay}s` : ''));
    }
    return this.robots;
  }

  /**
   * Throw when robots.txt forbids a path. Used at start-up to prove we are
   * allowed to use the endpoints we are about to hit.
   *
   * @param {string} pathAndQuery
   * @returns {{allowed:boolean, rule:string|null}}
   */
  checkRobots(pathAndQuery) {
    if (!this.robots) throw new Error('[wiki] loadRobots() must run before checkRobots()');
    return robotsAllows(this.robots, pathAndQuery);
  }

  /**
   * Fetch a page's rendered HTML — the only read route robots.txt permits.
   * @param {string} title
   * @returns {Promise<string>}
   */
  async page(title) {
    const query = `/w/${encodeURIComponent(title.replace(/ /g, '_'))}`;
    const verdict = this.checkRobots(query);
    if (!verdict.allowed) {
      throw new Error(`[wiki] robots.txt disallows ${query} (rule "${verdict.rule}")`);
    }
    return this._request(query, { cacheKey: title });
  }

  /**
   * Perform (or serve from cache) one GET request.
   *
   * @param {string} pathAndQuery
   * @param {{cache?:boolean, cacheKey?:string}} options
   * @returns {Promise<string>}
   */
  async _request(pathAndQuery, options = {}) {
    const useCache = options.cache !== false;
    const key = options.cacheKey || pathAndQuery;
    if (useCache && !this.refresh) {
      const cached = readCache(key);
      if (cached !== null) {
        this.cacheHits++;
        return cached;
      }
    }

    const url = `${WIKI_HOST}${pathAndQuery}`;
    let attempt = 0;
    for (;;) {
      attempt++;
      await this._throttle();
      this.networkRequests++;
      if (this.verbose) console.log(`[wiki] GET ${url}`);

      let response;
      try {
        response = await fetch(url, {
          headers: {
            'User-Agent': USER_AGENT,
            'Accept': 'text/x-wiki, text/html, text/plain;q=0.9, */*;q=0.5',
            'Accept-Language': 'en'
          },
          redirect: 'follow'
        });
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`[wiki] network error for ${url}: ${err.message}`);
        }
        const wait = backoffMs(attempt);
        console.warn(`[wiki] network error (${err.message}); retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }

      if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS) {
          throw new Error(`[wiki] ${url} kept returning HTTP ${response.status}`);
        }
        const retryAfter = Number(response.headers.get('retry-after'));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(MAX_BACKOFF_MS, retryAfter * 1000)
          : backoffMs(attempt);
        console.warn(`[wiki] HTTP ${response.status}; retrying in ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }

      if (!response.ok) {
        throw new Error(`[wiki] ${url} returned HTTP ${response.status}`);
      }

      const text = await response.text();
      if (useCache) writeCache(key, text);
      return text;
    }
  }

  /** Enforce the minimum interval between requests. */
  async _throttle() {
    const now = Date.now();
    const wait = lastRequestAt + this.minIntervalMs - now;
    if (wait > 0) await sleep(wait);
    lastRequestAt = Date.now();
  }
}

/** Exponential backoff with a small deterministic jitter. */
function backoffMs(attempt) {
  const base = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
  return base + (attempt * 137) % 500;
}
