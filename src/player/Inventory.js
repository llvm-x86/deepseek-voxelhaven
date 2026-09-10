/**
 * Inventory.js — hotbar and backpack storage.
 *
 * Layout matches the familiar survival convention: slots 0..8 are the hotbar,
 * slots 9..35 are the backpack. Each slot holds `null` or `{ item, count }`.
 *
 * The inventory is deliberately independent of the UI and of the world: it only
 * knows about item keys and counts, which makes it trivial to serialise.
 */

import { ItemRegistry, EMPTY_ITEM } from '../world/Items.js';

/** Number of hotbar slots. */
export const HOTBAR_SIZE = 9;
/** Total number of inventory slots. */
export const INVENTORY_SIZE = 36;

export class Inventory {
  constructor(size = INVENTORY_SIZE) {
    this.size = size;
    /** @type {Array<{item:string, count:number}|null>} */
    this.slots = new Array(size).fill(null);
  }

  /** Empty every slot. */
  clear() {
    this.slots.fill(null);
  }

  /** Slot contents, or null. */
  get(index) {
    if (index < 0 || index >= this.size) return null;
    return this.slots[index];
  }

  /** True when the slot holds nothing. */
  isEmpty(index) {
    const slot = this.get(index);
    return !slot || slot.count <= 0;
  }

  /**
   * Overwrite a slot.
   * @param {number} index
   * @param {{item:string,count:number}|null} stack
   */
  set(index, stack) {
    if (index < 0 || index >= this.size) return;
    if (stack && (stack.count <= 0 || !ItemRegistry.isValid(stack.item) || stack.item === EMPTY_ITEM)) {
      this.slots[index] = null;
      return;
    }
    this.slots[index] = stack ? { item: stack.item, count: stack.count } : null;
  }

  /**
   * Add items to the inventory, filling partial stacks first and then empty
   * slots, hotbar before backpack.
   *
   * @param {string} item
   * @param {number} count
   * @returns {number} how many items could NOT be stored
   */
  add(item, count = 1) {
    if (!ItemRegistry.isValid(item) || item === EMPTY_ITEM || count <= 0) return count;
    const maxStack = ItemRegistry.maxStack(item);
    let remaining = count;

    // Pass 1: top up existing stacks that are not full.
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const slot = this.slots[i];
      if (!slot || slot.item !== item) continue;
      const room = maxStack - slot.count;
      if (room <= 0) continue;
      const moved = Math.min(room, remaining);
      slot.count += moved;
      remaining -= moved;
    }

    // Pass 2: fill empty slots, hotbar first so picked-up blocks are usable.
    const order = this._fillOrder();
    for (const i of order) {
      if (remaining <= 0) break;
      if (this.slots[i]) continue;
      const moved = Math.min(maxStack, remaining);
      this.slots[i] = { item, count: moved };
      remaining -= moved;
    }
    return remaining;
  }

  /** Iteration order for filling: hotbar then backpack. */
  _fillOrder() {
    if (this._order && this._order.length === this.size) return this._order;
    const order = [];
    for (let i = 0; i < Math.min(HOTBAR_SIZE, this.size); i++) order.push(i);
    for (let i = HOTBAR_SIZE; i < this.size; i++) order.push(i);
    this._order = order;
    return order;
  }

  /**
   * Remove up to `count` items from a slot.
   * @returns {number} how many were actually removed
   */
  removeAt(index, count = 1) {
    const slot = this.get(index);
    if (!slot) return 0;
    const removed = Math.min(slot.count, count);
    slot.count -= removed;
    if (slot.count <= 0) this.slots[index] = null;
    return removed;
  }

  /**
   * Remove items of a kind from anywhere in the inventory.
   * @returns {number} how many were actually removed
   */
  removeItem(item, count = 1) {
    let remaining = count;
    for (let i = 0; i < this.size && remaining > 0; i++) {
      const slot = this.slots[i];
      if (!slot || slot.item !== item) continue;
      const taken = Math.min(slot.count, remaining);
      slot.count -= taken;
      remaining -= taken;
      if (slot.count <= 0) this.slots[i] = null;
    }
    return count - remaining;
  }

  /** How many of an item the inventory holds in total. */
  countOf(item) {
    let total = 0;
    for (const slot of this.slots) if (slot && slot.item === item) total += slot.count;
    return total;
  }

  /** Number of slots that are not empty. */
  usedSlots() {
    let used = 0;
    for (const slot of this.slots) if (slot) used++;
    return used;
  }

  /** True when no items at all remain (used to give the starter kit). */
  isEmptyInventory() {
    return this.usedSlots() === 0;
  }

  /**
   * Move or merge a stack between two slots.
   * When the destination holds the same item the stacks merge up to the limit.
   * @returns {boolean} true when something changed
   */
  moveStack(from, to) {
    if (from === to) return false;
    const source = this.get(from);
    const target = this.get(to);
    if (!source) return false;

    if (!target) {
      this.slots[to] = source;
      this.slots[from] = null;
      return true;
    }
    if (target.item === source.item) {
      const maxStack = ItemRegistry.maxStack(target.item);
      const room = maxStack - target.count;
      if (room <= 0) return false;
      const moved = Math.min(room, source.count);
      target.count += moved;
      source.count -= moved;
      if (source.count <= 0) this.slots[from] = null;
      return true;
    }
    // Different items: swap.
    this.slots[to] = source;
    this.slots[from] = target;
    return true;
  }

  /** Split a stack in half, moving the back half to `to`. */
  splitStack(from, to) {
    const source = this.get(from);
    if (!source || this.get(to)) return false;
    const half = Math.floor(source.count / 2);
    if (half <= 0) return false;
    this.slots[to] = { item: source.item, count: half };
    source.count -= half;
    return true;
  }

  /** Serialise to a compact array of {s,i,c} entries (only filled slots). */
  serialize() {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const slot = this.slots[i];
      if (slot && slot.count > 0) out.push([i, slot.item, slot.count]);
    }
    return out;
  }

  /**
   * Restore from a save, ignoring unknown items and out-of-range slots so a
   * partially corrupt inventory degrades instead of crashing.
   * @param {Array} data
   * @returns {{restored:number, skipped:number}}
   */
  deserialize(data) {
    this.clear();
    let restored = 0;
    let skipped = 0;
    if (!Array.isArray(data)) return { restored, skipped };
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length < 3) { skipped++; continue; }
      const index = entry[0] | 0;
      const item = entry[1];
      const count = entry[2] | 0;
      if (index < 0 || index >= this.size || count <= 0 || !ItemRegistry.isValid(item)
        || item === EMPTY_ITEM || !ItemRegistry.has(item)) {
        skipped++;
        continue;
      }
      const maxStack = ItemRegistry.maxStack(item);
      this.slots[index] = { item, count: Math.min(count, maxStack) };
      restored++;
    }
    return { restored, skipped };
  }
}
