/**
 * HUD.js — the in-world heads-up display.
 *
 * Owns the crosshair, hotbar, health and breath bars, the transient message
 * stack, the debug overlay and the full-screen feedback tints. It reads state
 * from the game and writes to the DOM; it never changes game state itself.
 *
 * Icons and hearts are generated as data URLs from the procedural texture atlas
 * and from inline SVG, so the HUD uses exactly the same art as the world and
 * needs no image files.
 */

import { ItemRegistry } from '../world/Items.js';
import { HOTBAR_SIZE } from '../player/Inventory.js';

/** Inline SVG heart shapes, coloured by CSS custom properties. */
function heartDataURL(fill, stroke = 'rgba(0,0,0,0.55)') {
  const path = 'M8 13.6C8 13.6 1.2 9.3 1.2 5.3 1.2 3.2 2.9 1.6 4.9 1.6 6.2 1.6 7.3 2.4 8 3.5 8.7 2.4 9.8 1.6 11.1 1.6 13.1 1.6 14.8 3.2 14.8 5.3 14.8 9.3 8 13.6 8 13.6Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">`
    + `<path d="${path}" fill="${fill}" stroke="${stroke}" stroke-width="0.9"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** Half-filled heart: full heart clipped to the left half over an empty one. */
function halfHeartDataURL() {
  const path = 'M8 13.6C8 13.6 1.2 9.3 1.2 5.3 1.2 3.2 2.9 1.6 4.9 1.6 6.2 1.6 7.3 2.4 8 3.5 8.7 2.4 9.8 1.6 11.1 1.6 13.1 1.6 14.8 3.2 14.8 5.3 14.8 9.3 8 13.6 8 13.6Z';
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">`
    + `<path d="${path}" fill="rgba(40,44,52,0.9)" stroke="rgba(0,0,0,0.55)" stroke-width="0.9"/>`
    + `<clipPath id="half"><rect x="0" y="0" width="8" height="16"/></clipPath>`
    + `<path d="${path}" fill="#e0453f" clip-path="url(#half)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** How long the "held item" name stays visible after switching slots. */
const HELD_NAME_DURATION = 1.8;

export class HUD {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {import('../render/TextureAtlas.js').TextureAtlas} atlas
   */
  constructor(bus, atlas) {
    this.bus = bus;
    this.atlas = atlas;

    this.root = document.getElementById('hud');
    this.hotbarEl = document.getElementById('hotbar');
    this.healthEl = document.getElementById('health-bar');
    this.breathEl = document.getElementById('breath-bar');
    this.breakEl = document.getElementById('break-progress');
    this.breakFillEl = document.getElementById('break-progress-fill');
    this.debugEl = document.getElementById('debug-overlay');
    this.toastEl = document.getElementById('hud-toasts');
    this.worldNameEl = document.getElementById('hud-world-name');
    this.worldMetaEl = document.getElementById('hud-world-meta');
    this.heldNameEl = document.getElementById('held-item-name');
    this.damageEl = document.getElementById('damage-vignette');
    this.waterEl = document.getElementById('water-overlay');

    document.documentElement.style.setProperty('--heart-full', heartDataURL('#e0453f'));
    document.documentElement.style.setProperty('--heart-half', halfHeartDataURL());
    document.documentElement.style.setProperty('--heart-empty', heartDataURL('rgba(38,42,50,0.92)'));

    /** @type {HTMLElement[]} */
    this.slotElements = [];
    /** @type {HTMLElement[]} */
    this.heartElements = [];
    /** @type {HTMLElement[]} */
    this.bubbleElements = [];

    this._buildHotbar();
    this._buildVitals();

    this.heldNameTimer = 0;
    this.damageTimer = 0;
    this.lastSelectedSlot = -1;
    this.lastInventoryRevision = -1;
    this.lastHealth = -1;
    this.lastBreath = -1;
    this.underwater = false;
    this.debugVisible = false;
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /** Create the nine hotbar slot elements once. */
  _buildHotbar() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const slot = document.createElement('div');
      slot.className = 'slot';
      slot.dataset.slot = String(i);
      slot.innerHTML = `<span class="slot-index">${i + 1}</span><span class="slot-count"></span>`;
      fragment.appendChild(slot);
      this.slotElements.push(slot);
    }
    this.hotbarEl.appendChild(fragment);
  }

  /** Create ten hearts and ten breath bubbles. */
  _buildVitals() {
    const hearts = document.createDocumentFragment();
    for (let i = 0; i < 10; i++) {
      const heart = document.createElement('div');
      heart.className = 'heart empty';
      hearts.appendChild(heart);
      this.heartElements.push(heart);
    }
    this.healthEl.appendChild(hearts);

    const bubbles = document.createDocumentFragment();
    for (let i = 0; i < 10; i++) {
      const bubble = document.createElement('div');
      bubble.className = 'bubble';
      bubbles.appendChild(bubble);
      this.bubbleElements.push(bubble);
    }
    this.breathEl.appendChild(bubbles);
  }

  // -------------------------------------------------------------------------
  // Visibility
  // -------------------------------------------------------------------------

  /** Show the HUD. */
  show() {
    this.root.classList.remove('is-hidden');
    this.root.setAttribute('aria-hidden', 'false');
  }

  /** Hide the HUD. */
  hide() {
    this.root.classList.add('is-hidden');
    this.root.setAttribute('aria-hidden', 'true');
  }

  // -------------------------------------------------------------------------
  // World info
  // -------------------------------------------------------------------------

  /**
   * @param {string} name
   * @param {number} seed
   */
  setWorldInfo(name, seed) {
    this.worldNameEl.textContent = name;
    this.worldMetaEl.textContent = `seed ${seed}`;
  }

  /** Extra line under the world name (mode, difficulty, ...). */
  setWorldNote(note) {
    this.worldMetaEl.textContent = note;
  }

  // -------------------------------------------------------------------------
  // Per-frame updates
  // -------------------------------------------------------------------------

  /**
   * Refresh everything that can change each frame.
   * @param {import('../player/Player.js').Player} player
   * @param {number} dt
   * @param {object} state extra values: { breakProgress, underwater, debugLines }
   */
  update(player, dt, state) {
    if (this.heldNameTimer > 0) {
      this.heldNameTimer -= dt;
      if (this.heldNameTimer <= 0) this.heldNameEl.classList.remove('is-visible');
    }
    if (this.damageTimer > 0) {
      this.damageTimer -= dt;
      if (this.damageTimer <= 0) this.damageEl.style.opacity = '0';
    }

    if (player.selectedSlot !== this.lastSelectedSlot) {
      this.lastSelectedSlot = player.selectedSlot;
      this.refreshHotbar(player);
    }
    // Poll the inventory revision as well as listening for refresh events.
    // Placing a block spends a stack without announcing anything, which used to
    // leave the hotbar showing an item the player no longer had until they
    // happened to switch slots. Checking a counter each frame makes every
    // mutation visible, whoever made it.
    else if (player.inventory && player.inventory.revision !== this.lastInventoryRevision) {
      this.refreshHotbar(player);
    }
    if (player.health !== this.lastHealth) {
      this.lastHealth = player.health;
      this.refreshHealth(player.health);
    }
    if (player.breath !== this.lastBreath) {
      this.lastBreath = player.breath;
      this.refreshBreath(player);
    }

    // Breaking progress bar.
    const progress = state.breakProgress || 0;
    if (progress > 0) {
      this.breakEl.classList.add('is-active');
      this.breakFillEl.style.width = `${Math.min(100, progress * 100).toFixed(1)}%`;
    } else {
      this.breakEl.classList.remove('is-active');
    }

    // Underwater tint.
    if (state.underwater !== this.underwater) {
      this.underwater = state.underwater;
      this.waterEl.style.opacity = state.underwater ? '1' : '0';
      this.breathEl.classList.toggle('is-hidden', !state.underwater && player.breath >= 14);
    }

    if (this.debugVisible && state.debugLines) {
      this.debugEl.innerHTML = state.debugLines;
    }
  }

  /** Rebuild the hotbar icons and counts from the player's inventory. */
  refreshHotbar(player) {
    this.lastInventoryRevision = player.inventory ? player.inventory.revision : 0;
    for (let i = 0; i < this.slotElements.length; i++) {
      const element = this.slotElements[i];
      const stack = player.inventory.get(i);
      const icon = element.querySelector('.slot-count');
      if (stack) {
        const tile = ItemRegistry.tile(stack.item);
        element.style.backgroundImage = `url("${this.atlas.iconDataURL(tile, 4)}")`;
        icon.textContent = stack.count > 1 ? String(stack.count) : '';
        element.title = `${ItemRegistry.name(stack.item)} ×${stack.count}`;
      } else {
        element.style.backgroundImage = '';
        icon.textContent = '';
        element.title = '';
      }
      element.classList.toggle('is-selected', i === player.selectedSlot);
    }
    this.showHeldItemName(player);
  }

  /** Briefly display the name of the newly selected item. */
  showHeldItemName(player) {
    const stack = player.heldStack();
    if (!stack) {
      this.heldNameEl.classList.remove('is-visible');
      return;
    }
    this.heldNameEl.textContent = ItemRegistry.name(stack.item);
    this.heldNameEl.classList.add('is-visible');
    this.heldNameTimer = HELD_NAME_DURATION;
  }

  /** Update the heart row. */
  refreshHealth(health) {
    const hearts = Math.max(0, Math.min(20, health));
    for (let i = 0; i < this.heartElements.length; i++) {
      const threshold = i * 2;
      const element = this.heartElements[i];
      if (hearts >= threshold + 2) element.className = 'heart full';
      else if (hearts === threshold + 1) element.className = 'heart half';
      else element.className = 'heart empty';
    }
    this.healthEl.classList.toggle('is-hidden', health <= 0 && false);
  }

  /** Update the breath bubbles (only visible while submerged). */
  refreshBreath(player) {
    const fraction = Math.max(0, Math.min(1, player.breath / 14));
    const filled = Math.ceil(fraction * 10);
    for (let i = 0; i < this.bubbleElements.length; i++) {
      this.bubbleElements[i].classList.toggle('empty', i >= filled);
    }
    const show = player.headInWater || player.breath < 13.9;
    this.breathEl.classList.toggle('is-hidden', !show);
  }

  // -------------------------------------------------------------------------
  // Feedback
  // -------------------------------------------------------------------------

  /** Flash the red damage vignette. */
  flashDamage() {
    this.damageEl.style.opacity = '1';
    this.damageTimer = 0.42;
  }

  /**
   * Show a transient message.
   * @param {string} message
   * @param {'info'|'warn'|'error'} [kind]
   * @param {number} [duration] seconds
   */
  toast(message, kind = 'info', duration = 2.6) {
    const element = document.createElement('div');
    element.className = `toast ${kind === 'warn' ? 'warn' : kind === 'error' ? 'error' : ''}`;
    element.textContent = message;
    this.toastEl.appendChild(element);
    // Keep the stack short so the screen never fills up with messages.
    while (this.toastEl.childElementCount > 5) this.toastEl.removeChild(this.toastEl.firstChild);
    setTimeout(() => {
      element.classList.add('fade');
      setTimeout(() => element.remove(), 340);
    }, duration * 1000);
  }

  /** Toggle the debug overlay. */
  toggleDebug() {
    this.debugVisible = !this.debugVisible;
    this.debugEl.classList.toggle('is-hidden', !this.debugVisible);
    return this.debugVisible;
  }

  /** Force the debug overlay on or off. */
  setDebugVisible(visible) {
    this.debugVisible = visible;
    this.debugEl.classList.toggle('is-hidden', !visible);
  }

  /**
   * Replace the debug overlay contents.
   * @param {Array<[string, string]>} rows label/value pairs
   */
  setDebugRows(rows) {
    if (!this.debugVisible) return;
    let html = '';
    for (const [label, value] of rows) {
      html += `${label}: <b>${escapeHtml(value)}</b>\n`;
    }
    this.debugEl.innerHTML = html;
  }
}

/** Escape text inserted into the debug overlay. */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
