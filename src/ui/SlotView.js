/**
 * SlotView.js — the shared slot rendering and "held stack" interaction model.
 *
 * Slots are plain DOM elements, not canvas, matching the rest of the overlay
 * UI. The model is the one Voxelhaven has always used because it needs no
 * drag-and-drop plumbing and works with a single mouse button:
 *
 *   click an occupied slot        -> pick the stack up
 *   click an empty slot           -> put it down
 *   click a matching slot         -> merge up to the stack limit
 *   click a different slot        -> swap
 *   shift-click with a held stack -> drop one item into that slot
 *   shift-click with empty hands  -> split the stack in half into your hand
 *
 * On top of that it adds keyboard operation: every slot is focusable, the
 * arrow keys walk the bound slots, Enter/Space is a plain click and `S` is the
 * shift-click equivalent, so the grid is usable without a mouse.
 */

import { ItemRegistry } from '../world/Items.js';

/** Icon size multiplier used for inventory slot art. */
const ICON_SCALE = 4;

export class SlotView {
  /**
   * @param {object} options
   * @param {import('../render/TextureAtlas.js').TextureAtlas} options.atlas
   * @param {import('../systems/AudioSystem.js').AudioSystem} options.audio
   * @param {() => void} options.onChange called after every mutation
   * @param {(reason:string) => void} [options.onReject] called when a click is refused
   */
  constructor({ atlas, audio, onChange, onReject }) {
    this.atlas = atlas;
    this.audio = audio;
    this.onChange = onChange || (() => {});
    this.onReject = onReject || (() => {});
    /** Stack currently held by the cursor, or null. */
    this.held = null;
    /** @type {Array<{element:HTMLElement, container:object, index:number, role:string}>} */
    this.entries = [];
    /** Monotonic counter used to keep keyboard navigation in DOM order. */
    this._order = 0;
  }

  /**
   * Register a slot element against a container.
   *
   * @param {HTMLElement} element
   * @param {{get:(i:number)=>object|null, set:(i:number,stack:object|null)=>void, size:number}} container
   * @param {number} index
   * @param {string} [role] free-form label used by keyboard navigation and tests
   * @returns {HTMLElement} the element, for chaining
   */
  bind(element, container, index, role = 'slot') {
    const entry = { element, container, index, role, order: this._order++ };
    element.dataset.slot = String(index);
    element.dataset.role = role;
    element.tabIndex = 0;
    if (!element.querySelector('.slot-count')) {
      const count = document.createElement('span');
      count.className = 'slot-count';
      element.appendChild(count);
    }
    element.addEventListener('click', (event) => {
      event.preventDefault();
      this.click(entry, event);
    });
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.click(entry, { shiftKey: true });
    });
    element.addEventListener('keydown', (event) => this.onKeyDown(entry, event));
    // Clicking anywhere in the slot should also focus it, so keyboard and
    // mouse interaction stay in sync.
    element.addEventListener('focus', () => { this.focused = entry; });
    this.entries.push(entry);
    return element;
  }

  /** Drop every binding (used when a screen is rebuilt). */
  unbindAll() {
    this.entries = [];
    this.focused = null;
  }

  /** Find an entry by role and index. */
  entryFor(role, index) {
    return this.entries.find((entry) => entry.role === role && entry.index === index) || null;
  }

  // -------------------------------------------------------------------------
  // Interaction
  // -------------------------------------------------------------------------

  /**
   * Apply a click to one slot.
   * @param {{element:HTMLElement, container:object, index:number, role:string}} entry
   * @param {{shiftKey?:boolean}} [event]
   */
  click(entry, event = {}) {
    const container = entry.container;
    const index = entry.index;

    // A container may restrict what a slot accepts (a furnace's fuel slot, for
    // example). Refusing up front keeps the held stack on the cursor.
    if (this.held && typeof container.accepts === 'function' && !container.accepts(index, this.held)) {
      this.onReject(container.rejectReason ? container.rejectReason(index, this.held) : 'That item does not go there.');
      return;
    }

    if (event.shiftKey) {
      this._shiftClick(container, index);
    } else if (!this.held) {
      const stack = container.get(index);
      if (!stack) return;
      this.held = { ...stack };
      container.set(index, null);
    } else {
      const target = container.get(index);
      if (!target) {
        container.set(index, this.held);
        this.held = null;
      } else if (target.item === this.held.item) {
        const max = ItemRegistry.maxStack(target.item);
        const room = max - target.count;
        const moved = Math.min(room, this.held.count);
        target.count += moved;
        this.held.count -= moved;
        if (this.held.count <= 0) this.held = null;
      } else {
        container.set(index, this.held);
        this.held = { ...target };
      }
    }
    this.audio.play('click');
    this.onChange();
  }

  /** Shift-click: split out of a slot, or drip one item into it. */
  _shiftClick(container, index) {
    if (this.held) {
      if (typeof container.accepts === 'function' && !container.accepts(index, this.held)) return;
      const target = container.get(index);
      if (!target) {
        container.set(index, { item: this.held.item, count: 1, durability: this.held.durability });
        this.held.count -= 1;
      } else if (target.item === this.held.item) {
        const max = ItemRegistry.maxStack(target.item);
        if (target.count < max) {
          target.count += 1;
          this.held.count -= 1;
        }
      }
      if (this.held.count <= 0) this.held = null;
      return;
    }
    const stack = container.get(index);
    if (!stack) return;
    const half = Math.floor(stack.count / 2);
    if (half > 0) {
      this.held = { ...stack, count: half };
      stack.count -= half;
      if (stack.count <= 0) container.set(index, null);
    } else {
      this.held = { ...stack };
      container.set(index, null);
    }
  }

  /**
   * Keyboard: arrows walk the bound slots, Enter/Space clicks, S splits.
   * @param {object} entry
   * @param {KeyboardEvent} event
   */
  onKeyDown(entry, event) {
    const entries = this.entries;
    const position = entries.indexOf(entry);
    if (position === -1) return;
    let target = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = position + 1;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = position - 1;
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = entries.length - 1;
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.click(entry, { shiftKey: event.shiftKey });
      return;
    } else if (event.key === 's' || event.key === 'S') {
      event.preventDefault();
      this.click(entry, { shiftKey: true });
      return;
    } else {
      return;
    }
    event.preventDefault();
    const next = entries[(target + entries.length) % entries.length];
    if (next) next.element.focus();
  }

  /** Move keyboard focus into the first bound slot. */
  focusFirst() {
    if (this.entries.length > 0) this.entries[0].element.focus();
  }

  /** True while a stack is on the cursor. */
  get isHolding() {
    return !!this.held;
  }

  /**
   * Hand the held stack back to an inventory.
   * @param {{add:(item:string,count:number)=>number}} inventory
   * @returns {{item:string,count:number}|null} what did not fit, if anything
   */
  returnHeld(inventory) {
    if (!this.held) return null;
    const stack = this.held;
    this.held = null;
    const leftover = inventory.add(stack.item, stack.count);
    return leftover > 0 ? { item: stack.item, count: leftover } : null;
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Redraw every bound slot. */
  refresh() {
    for (const entry of this.entries) {
      const stack = entry.container.get(entry.index);
      const element = entry.element;
      const countEl = element.querySelector('.slot-count');
      let durabilityEl = element.querySelector('.slot-durability');
      if (stack) {
        element.style.backgroundImage = `url("${this.atlas.iconDataURL(ItemRegistry.tile(stack.item), ICON_SCALE)}")`;
        countEl.textContent = stack.count > 1 ? String(stack.count) : '';
        element.title = describe(stack);
        const max = ItemRegistry.durability(stack.item);
        if (max > 0) {
          if (!durabilityEl) {
            durabilityEl = document.createElement('span');
            durabilityEl.className = 'slot-durability';
            durabilityEl.appendChild(document.createElement('i'));
            element.appendChild(durabilityEl);
          }
          const current = stack.durability === undefined ? max : stack.durability;
          const bar = durabilityEl.querySelector('i');
          bar.style.width = `${Math.max(0, Math.min(1, current / max)) * 100}%`;
          bar.style.background = durabilityColour(current / max);
        } else if (durabilityEl) {
          durabilityEl.remove();
        }
      } else {
        element.style.backgroundImage = '';
        countEl.textContent = '';
        element.title = '';
        if (durabilityEl) durabilityEl.remove();
      }
    }
  }
}

/** Tooltip text for a stack, including remaining durability for tools. */
export function describe(stack) {
  const max = ItemRegistry.durability(stack.item);
  if (max > 0) {
    const current = stack.durability === undefined ? max : stack.durability;
    return `${ItemRegistry.name(stack.item)} — durability ${current}/${max}`;
  }
  return `${ItemRegistry.name(stack.item)} ×${stack.count}`;
}

/** Green through amber to red as a tool wears out. */
function durabilityColour(ratio) {
  if (ratio > 0.5) return '#7fc45a';
  if (ratio > 0.25) return '#d8c455';
  return '#d2603f';
}
