/**
 * Menus.js — every screen outside gameplay: main menu, controls, the world
 * list, world creation, pause, settings, death and the fatal error screen.
 *
 * The menus never touch the world directly. They translate clicks into calls on
 * the `handlers` object supplied by Game, which keeps the UI layer free of game
 * logic and makes the whole thing easy to reason about.
 */

import { GAME_VERSION, RENDER, TIME, AUDIO, RENDER_DISTANCE } from '../core/Config.js';

/** localStorage key for user settings. */
const SETTINGS_KEY = 'voxelhaven.settings.v1';

/** Default settings, merged with whatever is stored. */
const DEFAULT_SETTINGS = {
  renderDistance: RENDER_DISTANCE,
  sensitivity: 1.0,
  fov: RENDER.fov,
  dayLengthMinutes: TIME.dayLengthSeconds / 60,
  volume: AUDIO.masterVolume,
  muted: false,
  invertY: false
};

export class Menus {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {import('../systems/SaveSystem.js').SaveSystem} saveSystem
   * @param {object} handlers callbacks provided by Game
   */
  constructor(bus, saveSystem, handlers) {
    this.bus = bus;
    this.saveSystem = saveSystem;
    this.handlers = handlers;
    this.settings = loadSettings();

    /** @type {Array} cached world summaries */
    this.worlds = [];
    /** True while a save is being written, to prevent double submission. */
    this.busy = false;

    this.screens = {
      boot: document.getElementById('screen-boot'),
      menu: document.getElementById('screen-menu'),
      controls: document.getElementById('screen-controls'),
      worlds: document.getElementById('screen-worlds'),
      create: document.getElementById('screen-create'),
      loading: document.getElementById('screen-loading'),
      pause: document.getElementById('screen-pause'),
      settings: document.getElementById('screen-settings'),
      inventory: document.getElementById('screen-inventory'),
      death: document.getElementById('screen-death'),
      error: document.getElementById('screen-error')
    };

    this.elements = {
      bootProgress: document.getElementById('boot-progress'),
      bootMessage: document.getElementById('boot-message'),
      menuStorageNote: document.getElementById('menu-storage-note'),
      worldList: document.getElementById('world-list'),
      worldsStorageNote: document.getElementById('worlds-storage-note'),
      createForm: document.getElementById('create-form'),
      inputName: document.getElementById('input-world-name'),
      inputSeed: document.getElementById('input-world-seed'),
      inputPeaceful: document.getElementById('input-peaceful'),
      loadingTitle: document.getElementById('loading-title'),
      loadingProgress: document.getElementById('loading-progress'),
      loadingMessage: document.getElementById('loading-message'),
      pauseWorldMeta: document.getElementById('pause-world-meta'),
      pauseStatus: document.getElementById('pause-status'),
      deathCause: document.getElementById('death-cause'),
      errorMessage: document.getElementById('error-message'),
      errorDetail: document.getElementById('error-detail')
    };

    this._wireButtons();
    this._wireSettings();
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  /** Connect every button to its handler. */
  _wireButtons() {
    const on = (id, fn) => {
      const element = document.getElementById(id);
      if (element) element.addEventListener('click', fn);
    };

    on('btn-new-world', () => {
      this.bus.emit('menuSound');
      this.openCreateScreen();
    });
    on('btn-load-world', () => {
      this.bus.emit('menuSound');
      this.openWorldList();
    });
    on('btn-controls', () => {
      this.bus.emit('menuSound');
      this.show('controls');
    });
    on('btn-controls-back', () => this.show('menu'));
    on('btn-worlds-back', () => this.show('menu'));
    on('btn-create-back', () => this.show('menu'));

    this.elements.createForm.addEventListener('submit', (event) => {
      event.preventDefault();
      this.submitCreateForm();
    });

    on('btn-resume', () => this.handlers.onResume());
    on('btn-save', () => this.handlers.onSave());
    on('btn-settings', () => this.openSettings());
    on('btn-quit', () => this.handlers.onQuit());
    on('btn-settings-back', () => {
      this.handlers.onSettingsChanged(this.settings);
      this.handlers.onResume();
    });
    on('btn-respawn', () => this.handlers.onRespawn());
    on('btn-death-quit', () => this.handlers.onQuit());
    on('btn-error-reload', () => window.location.reload());
    on('btn-error-menu', () => {
      this.show('menu');
      this.handlers.onQuit({ skipSave: true });
    });
  }

  /** Bind the settings sliders to live preview. */
  _wireSettings() {
    const bindRange = (id, valueId, key, format, transform = (v) => v) => {
      const input = document.getElementById(id);
      const label = document.getElementById(valueId);
      if (!input || !label) return;
      input.value = String(this.settings[key]);
      label.textContent = format(this.settings[key]);
      input.addEventListener('input', () => {
        const value = transform(Number(input.value));
        this.settings[key] = value;
        label.textContent = format(value);
        saveSettings(this.settings);
        this.handlers.onSettingsChanged(this.settings);
      });
    };

    bindRange('setting-render-distance', 'setting-render-distance-value', 'renderDistance', (v) => String(v));
    bindRange('setting-sensitivity', 'setting-sensitivity-value', 'sensitivity', (v) => v.toFixed(1), (v) => v);
    bindRange('setting-fov', 'setting-fov-value', 'fov', (v) => String(Math.round(v)));
    bindRange('setting-day-length', 'setting-day-length-value', 'dayLengthMinutes', (v) => String(Math.round(v)));
    bindRange('setting-volume', 'setting-volume-value', 'volume', (v) => String(Math.round(v * 100)), (v) => v / 100);

    const muted = document.getElementById('setting-muted');
    muted.checked = this.settings.muted;
    muted.addEventListener('change', () => {
      this.settings.muted = muted.checked;
      saveSettings(this.settings);
      this.handlers.onSettingsChanged(this.settings);
    });

    const invert = document.getElementById('setting-invert-y');
    invert.checked = this.settings.invertY;
    invert.addEventListener('change', () => {
      this.settings.invertY = invert.checked;
      saveSettings(this.settings);
      this.handlers.onSettingsChanged(this.settings);
    });
  }

  /** Refresh the settings controls from the stored values. */
  syncSettingsControls() {
    const set = (id, value) => {
      const element = document.getElementById(id);
      if (element) element.value = String(value);
    };
    set('setting-render-distance', this.settings.renderDistance);
    set('setting-sensitivity', this.settings.sensitivity);
    set('setting-fov', this.settings.fov);
    set('setting-day-length', this.settings.dayLengthMinutes);
    set('setting-volume', Math.round(this.settings.volume * 100));
    document.getElementById('setting-render-distance-value').textContent = String(this.settings.renderDistance);
    document.getElementById('setting-sensitivity-value').textContent = this.settings.sensitivity.toFixed(1);
    document.getElementById('setting-fov-value').textContent = String(Math.round(this.settings.fov));
    document.getElementById('setting-day-length-value').textContent = String(Math.round(this.settings.dayLengthMinutes));
    document.getElementById('setting-volume-value').textContent = String(Math.round(this.settings.volume * 100));
    document.getElementById('setting-muted').checked = this.settings.muted;
    document.getElementById('setting-invert-y').checked = this.settings.invertY;
  }

  // -------------------------------------------------------------------------
  // Screen switching
  // -------------------------------------------------------------------------

  /**
   * Show exactly one screen (or none when `name` is null).
   * @param {string|null} name
   */
  show(name) {
    for (const [key, element] of Object.entries(this.screens)) {
      if (!element) continue;
      element.classList.toggle('is-hidden', key !== name);
    }
  }

  /** True when a modal screen is covering the world. */
  get anyOpen() {
    for (const element of Object.values(this.screens)) {
      if (element && !element.classList.contains('is-hidden')) return true;
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Boot and loading
  // -------------------------------------------------------------------------

  /** Update the boot progress bar. */
  setBootProgress(fraction, message) {
    this.elements.bootProgress.style.width = `${Math.round(fraction * 100)}%`;
    if (message) this.elements.bootMessage.textContent = message;
  }

  /**
   * Show the loading screen.
   * @param {string} title
   * @param {string} message
   */
  showLoading(title, message) {
    this.elements.loadingTitle.textContent = title;
    this.elements.loadingMessage.textContent = message;
    this.elements.loadingProgress.style.width = '0%';
    this.show('loading');
  }

  /**
   * Update the loading progress bar.
   * @param {number} fraction 0..1
   * @param {string} [message]
   */
  setLoadingProgress(fraction, message) {
    this.elements.loadingProgress.style.width = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`;
    if (message) this.elements.loadingMessage.textContent = message;
  }

  /** Note about where worlds are stored. */
  setStorageNote(text) {
    this.elements.menuStorageNote.textContent = text;
    this.elements.worldsStorageNote.textContent = text;
  }

  // -------------------------------------------------------------------------
  // World list
  // -------------------------------------------------------------------------

  /** Load the world list and display it. */
  async openWorldList() {
    this.show('worlds');
    this.elements.worldList.replaceChildren(makeNote('Loading worlds…'));
    let worlds = [];
    try {
      worlds = await this.saveSystem.list();
    } catch (err) {
      this.elements.worldList.replaceChildren(makeNote(`Could not read the world list: ${err.message}`, true));
      return;
    }
    this.worlds = worlds;
    this.renderWorldList();
  }

  /** Render the cached world list. */
  renderWorldList() {
    const list = this.elements.worldList;
    list.replaceChildren();
    if (this.worlds.length === 0) {
      list.appendChild(makeNote('No worlds yet. Create one to get started.'));
      return;
    }
    const fragment = document.createDocumentFragment();
    for (const world of this.worlds) {
      const entry = document.createElement('div');
      entry.className = `world-entry${world.corrupt ? ' corrupt' : ''}`;

      const info = document.createElement('div');
      info.className = 'world-entry-info';
      const name = document.createElement('div');
      name.className = 'world-entry-name';
      name.textContent = world.name || 'Unnamed World';
      const meta = document.createElement('div');
      meta.className = 'world-entry-meta';
      if (world.corrupt) {
        meta.textContent = 'This save could not be read. You can delete it.';
      } else {
        const when = world.updatedAt ? new Date(world.updatedAt).toLocaleString() : 'unknown date';
        meta.textContent = `seed ${world.seed} · ${when}`;
      }
      info.appendChild(name);
      info.appendChild(meta);

      const actions = document.createElement('div');
      actions.className = 'world-entry-actions';

      if (!world.corrupt) {
        const play = document.createElement('button');
        play.type = 'button';
        play.className = 'btn btn-small btn-primary';
        play.textContent = 'Play';
        play.addEventListener('click', () => this.handlers.onLoadWorld(world.id));
        actions.appendChild(play);
      }

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn btn-small btn-danger';
      remove.textContent = 'Delete';
      remove.addEventListener('click', async () => {
        // Deleting is destructive and immediate; ask first.
        const confirmed = window.confirm(`Delete "${world.name}"? This cannot be undone.`);
        if (!confirmed) return;
        await this.saveSystem.remove(world.id);
        this.worlds = this.worlds.filter((entry2) => entry2.id !== world.id);
        this.renderWorldList();
        this.bus.emit('worldDeleted', world.id);
      });
      actions.appendChild(remove);

      entry.appendChild(info);
      entry.appendChild(actions);
      fragment.appendChild(entry);
    }
    list.appendChild(fragment);
  }

  /** Prepare and reveal the world creation screen. */
  openCreateScreen() {
    const nameInput = this.elements.inputName;
    // Offer a default name that is unlikely to collide with an existing world.
    const adjectives = ['Quiet', 'Amber', 'Hollow', 'Bright', 'Wandering', 'Copper', 'Frozen', 'Verdant'];
    const nouns = ['Valley', 'Reach', 'Basin', 'Hollow', 'Expanse', 'Shore', 'Ridge', 'Meadow'];
    nameInput.value = `${adjectives[Math.floor(Math.random() * adjectives.length)]} ${nouns[Math.floor(Math.random() * nouns.length)]}`;
    this.elements.inputSeed.value = '';
    this.elements.inputPeaceful.checked = false;
    this.show('create');
    nameInput.focus();
    nameInput.select();
  }

  /** Read the create form and hand the values to the game. */
  submitCreateForm() {
    if (this.busy) return;
    const rawName = this.elements.inputName.value.trim() || 'New World';
    const rawSeed = this.elements.inputSeed.value.trim();
    // A seed may be any text; non-numeric seeds are hashed into an integer so
    // the field never rejects what the player types.
    let seed;
    if (rawSeed === '') seed = (Math.random() * 0xffffffff) >>> 0;
    else if (/^-?\d+$/.test(rawSeed)) seed = Number(rawSeed) | 0;
    else seed = hashString(rawSeed) | 0;

    this.handlers.onCreateWorld({
      name: rawName,
      seed,
      seedText: rawSeed,
      peaceful: this.elements.inputPeaceful.checked
    });
  }

  // -------------------------------------------------------------------------
  // Pause, death, settings, error
  // -------------------------------------------------------------------------

  /**
   * Show the pause screen.
   * @param {string} worldMeta
   */
  openPause(worldMeta) {
    this.elements.pauseWorldMeta.textContent = worldMeta;
    this.elements.pauseStatus.textContent = '';
    this.show('pause');
  }

  /** Status text under the pause buttons. */
  setPauseStatus(text) {
    this.elements.pauseStatus.textContent = text;
  }

  /** Open the settings screen, remembering where we came from. */
  openSettings() {
    this.syncSettingsControls();
    this.show('settings');
  }

  /**
   * Show the death screen.
   * @param {string} cause
   */
  openDeath(cause) {
    this.elements.deathCause.textContent = `Cause of death: ${cause || 'unknown'}`;
    this.show('death');
  }

  /**
   * Show a fatal error.
   * @param {string} message
   * @param {string} [detail]
   */
  showError(message, detail = '') {
    this.elements.errorMessage.textContent = message;
    this.elements.errorDetail.textContent = detail;
    this.elements.errorDetail.classList.toggle('is-hidden', !detail);
    this.show('error');
  }
}

/** Build a muted note element for empty lists. */
function makeNote(text, isError = false) {
  const element = document.createElement('div');
  element.className = 'empty-note';
  element.textContent = text;
  if (isError) element.style.color = '#ffb9b5';
  return element;
}

/** Stable string hash (FNV-1a style) used to turn text seeds into integers. */
function hashString(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Read settings from localStorage, filling in defaults. */
function loadSettings() {
  const settings = { ...DEFAULT_SETTINGS };
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return settings;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') Object.assign(settings, parsed);
  } catch {
    // Corrupt settings are not worth failing over: fall back to defaults.
  }
  settings.renderDistance = clampInt(settings.renderDistance, 3, 14, RENDER_DISTANCE);
  settings.sensitivity = clampNumber(settings.sensitivity, 0.2, 3, 1);
  settings.fov = clampNumber(settings.fov, 50, 110, RENDER.fov);
  settings.dayLengthMinutes = clampNumber(settings.dayLengthMinutes, 1, 40, 10);
  settings.volume = clampNumber(settings.volume, 0, 1, AUDIO.masterVolume);
  settings.muted = !!settings.muted;
  settings.invertY = !!settings.invertY;
  return settings;
}

/** Persist settings. */
function saveSettings(settings) {
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Storage may be unavailable; settings simply will not persist.
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
