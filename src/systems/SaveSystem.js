/**
 * SaveSystem.js — world persistence.
 *
 * Storage strategy
 *  - A world is stored as its **seed** plus a **delta** of player edits, never
 *    as a full dump of every block. Generating 289 chunks takes a couple of
 *    seconds; storing them would take tens of megabytes.
 *  - The primary backend is the small JSON API exposed by server.js, which
 *    writes `saves/<id>.json` on disk so worlds survive a browser cache clear.
 *  - If that API is unreachable (for example when the page is opened from a
 *    plain static server) the system transparently falls back to localStorage.
 *
 * Every read is validated: a corrupt or truncated save produces a clear error
 * the UI can show instead of a half-loaded world.
 */

import { SAVE, GAME_VERSION } from '../core/Config.js';
import { BlockRegistry } from '../world/Blocks.js';

/** Root path of the save API. */
const API_ROOT = '/api/saves';

export class SaveSystem {
  /** @param {import('../core/EventBus.js').EventBus} bus */
  constructor(bus) {
    this.bus = bus;
    /** null = not probed yet, true/false once known. */
    this.apiAvailable = null;
    /** Last transport error, shown in the UI. */
    this.lastError = null;
    /** Which backend was used for the most recent operation. */
    this.backend = 'unknown';
  }

  /** True when localStorage can be used as a fallback. */
  static hasLocalStorage() {
    try {
      const probe = '__voxelhaven_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch {
      return false;
    }
  }

  /** Check whether the server save API responds. */
  async probe() {
    if (this.apiAvailable !== null) return this.apiAvailable;
    try {
      const response = await fetch(API_ROOT, { method: 'GET' });
      this.apiAvailable = response.ok;
      if (response.ok) this.backend = 'server';
    } catch {
      this.apiAvailable = false;
    }
    if (!this.apiAvailable) {
      this.backend = SaveSystem.hasLocalStorage() ? 'localStorage' : 'memory';
      console.warn('[SaveSystem] server save API unavailable; using', this.backend);
    }
    return this.apiAvailable;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * List every stored world.
   * @returns {Promise<Array<{id:string,name:string,seed:number|null,updatedAt:number|null,corrupt?:boolean}>>}
   */
  async list() {
    await this.probe();
    if (this.apiAvailable) {
      try {
        const response = await fetch(API_ROOT);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        return Array.isArray(payload.saves) ? payload.saves : [];
      } catch (err) {
        this.lastError = `Could not list worlds: ${err.message}`;
        this.apiAvailable = false;
      }
    }
    return this._listLocal();
  }

  /**
   * Read one world.
   * @param {string} id
   * @returns {Promise<object>} the save document
   * @throws {Error} when the save is missing or corrupt
   */
  async read(id) {
    await this.probe();
    let document;
    if (this.apiAvailable) {
      try {
        const response = await fetch(`${API_ROOT}/${encodeURIComponent(id)}`);
        if (response.status === 404) throw new Error('That world no longer exists.');
        if (!response.ok) throw new Error(`Server returned HTTP ${response.status}`);
        document = await response.json();
      } catch (err) {
        if (err.message === 'That world no longer exists.') throw err;
        this.lastError = err.message;
        this.apiAvailable = false;
      }
    }
    if (!document) {
      const raw = window.localStorage.getItem(SAVE.keyPrefix + id);
      if (!raw) throw new Error('That world could not be found in this browser.');
      try {
        document = JSON.parse(raw);
      } catch {
        throw new Error('That world is corrupt and could not be read.');
      }
    }
    const check = SaveSystem.validateDocument(document);
    if (!check.ok) {
      throw new Error(`That world is not usable: ${check.errors.join('; ')}`);
    }
    if (check.warnings.length > 0) {
      this.bus.emit('saveWarnings', check.warnings);
    }
    return document;
  }

  /**
   * Write one world.
   * @param {string} id
   * @param {object} document
   * @returns {Promise<{ok:boolean, backend:string, error?:string}>}
   */
  async write(id, document) {
    await this.probe();
    document.updatedAt = Date.now();
    document.version = SAVE.formatVersion;
    document.gameVersion = GAME_VERSION;
    const body = JSON.stringify(document);

    if (this.apiAvailable) {
      try {
        const response = await fetch(`${API_ROOT}/${encodeURIComponent(id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body
        });
        if (!response.ok) {
          const detail = await response.json().catch(() => ({}));
          throw new Error(detail.error || `HTTP ${response.status}`);
        }
        this.backend = 'server';
        return { ok: true, backend: 'server' };
      } catch (err) {
        this.lastError = err.message;
        this.apiAvailable = false;
        console.warn('[SaveSystem] server write failed, falling back to localStorage:', err.message);
      }
    }

    if (!SaveSystem.hasLocalStorage()) {
      return { ok: false, backend: 'none', error: 'No storage backend is available.' };
    }
    try {
      window.localStorage.setItem(SAVE.keyPrefix + id, body);
      this.backend = 'localStorage';
      return { ok: true, backend: 'localStorage' };
    } catch (err) {
      const message = err && err.name === 'QuotaExceededError'
        ? 'Browser storage is full. Delete an old world and try again.'
        : `Could not save: ${err.message}`;
      this.lastError = message;
      return { ok: false, backend: 'localStorage', error: message };
    }
  }

  /**
   * Delete a world.
   * @param {string} id
   */
  async remove(id) {
    await this.probe();
    let removed = false;
    if (this.apiAvailable) {
      try {
        const response = await fetch(`${API_ROOT}/${encodeURIComponent(id)}`, { method: 'DELETE' });
        removed = response.ok;
      } catch {
        this.apiAvailable = false;
      }
    }
    if (SaveSystem.hasLocalStorage()) {
      try {
        window.localStorage.removeItem(SAVE.keyPrefix + id);
        removed = true;
      } catch { /* ignore */ }
    }
    return removed;
  }

  // -------------------------------------------------------------------------
  // localStorage backend
  // -------------------------------------------------------------------------

  /** Enumerate worlds stored in localStorage. */
  _listLocal() {
    const out = [];
    if (!SaveSystem.hasLocalStorage()) return out;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key || !key.startsWith(SAVE.keyPrefix)) continue;
      const id = key.slice(SAVE.keyPrefix.length);
      try {
        const doc = JSON.parse(window.localStorage.getItem(key));
        out.push({
          id,
          name: typeof doc.name === 'string' ? doc.name : 'Unnamed World',
          seed: typeof doc.seed === 'number' ? doc.seed : null,
          createdAt: doc.createdAt || null,
          updatedAt: doc.updatedAt || null,
          version: doc.version || 1
        });
      } catch {
        out.push({ id, name: '⚠ Corrupt save', corrupt: true, updatedAt: null, seed: null });
      }
    }
    out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return out;
  }

  // -------------------------------------------------------------------------
  // Document construction and validation
  // -------------------------------------------------------------------------

  /**
   * Build a save document.
   * @param {object} state
   * @returns {object}
   */
  static createDocument(state) {
    return {
      version: SAVE.formatVersion,
      gameVersion: GAME_VERSION,
      id: state.id,
      name: state.name,
      seed: state.seed,
      createdAt: state.createdAt || Date.now(),
      updatedAt: Date.now(),
      time: {
        timeOfDay: state.timeOfDay,
        dayCount: state.dayCount,
        elapsedSeconds: state.elapsedSeconds
      },
      player: state.player,
      edits: state.edits,
      entities: state.entities,
      stats: state.stats
    };
  }

  /**
   * Validate a save document before it is used to build a world.
   * @param {any} doc
   * @returns {{ok:boolean, errors:string[], warnings:string[]}}
   */
  static validateDocument(doc) {
    const errors = [];
    const warnings = [];
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      return { ok: false, errors: ['save file is not a JSON object'], warnings };
    }
    if (typeof doc.seed !== 'number' || !Number.isFinite(doc.seed)) {
      errors.push('missing or invalid world seed');
    } else {
      doc.seed = doc.seed | 0;
    }
    if (typeof doc.version === 'number' && doc.version > SAVE.formatVersion) {
      errors.push(`save was written by a newer version (format ${doc.version}, this build reads ${SAVE.formatVersion})`);
    }
    if (!doc.player || typeof doc.player !== 'object') {
      warnings.push('no player data; spawning at the default location');
    }
    if (doc.edits !== undefined && (typeof doc.edits !== 'object' || doc.edits === null || Array.isArray(doc.edits))) {
      warnings.push('block changes were unreadable and have been discarded');
      doc.edits = {};
    }
    if (doc.time && typeof doc.time.timeOfDay === 'number') {
      doc.time.timeOfDay = ((doc.time.timeOfDay % 1) + 1) % 1;
    } else if (doc.time) {
      warnings.push('world time was invalid; starting at dawn');
      doc.time.timeOfDay = 0.05;
    }
    // Check that every edit references a real block.
    if (doc.edits) {
      let invalid = 0;
      for (const pairs of Object.values(doc.edits)) {
        if (!Array.isArray(pairs)) continue;
        for (const entry of pairs) {
          if (!Array.isArray(entry) || entry.length !== 2 || !BlockRegistry.isValid(entry[1] | 0)) invalid++;
        }
      }
      if (invalid > 0) warnings.push(`${invalid} block change(s) referenced unknown blocks and were skipped`);
    }
    return { ok: errors.length === 0, errors, warnings };
  }

  /**
   * Generate a save id that satisfies the server's filename rules.
   * @param {string} name
   * @returns {string}
   */
  static makeId(name) {
    const slug = String(name || 'world')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'world';
    const suffix = Date.now().toString(36).slice(-5) + Math.floor(Math.random() * 1296).toString(36);
    return `${slug}-${suffix}`;
  }

  /** Human readable byte size of a save document. */
  static documentSize(doc) {
    try {
      return JSON.stringify(doc).length;
    } catch {
      return 0;
    }
  }
}
