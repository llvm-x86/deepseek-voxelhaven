/**
 * CraftGrid.js — the player's crafting grid.
 *
 * Deliberately the same shape as Inventory (`size`, `get`, `set`, `slots`) so
 * the UI can bind slots and move stacks without caring which container it is
 * looking at, and so `Crafting.craftFromGrid()` can take either.
 *
 * Contents live here rather than in the UI so they survive a redraw, and so a
 * test can drive the grid without touching the DOM.
 */

import { ItemRegistry, EMPTY_ITEM } from '../world/Items.js';

/** Side length of the inventory crafting grid. */
export const CRAFT_GRID_INVENTORY = 2;
/** Side length of the crafting table grid. */
export const CRAFT_GRID_TABLE = 3;

export class CraftGrid {
  /** @param {number} dimension 2 for the inventory, 3 for a crafting table */
  constructor(dimension = CRAFT_GRID_INVENTORY) {
    /** Side length: the grid holds `dimension * dimension` slots. */
    this.dimension = dimension;
    this.size = dimension * dimension;
    /** @type {Array<{item:string,count:number,durability?:number}|null>} */
    this.slots = new Array(this.size).fill(null);
  }

  /** Resize (and clear) the grid, e.g. when switching between the two screens. */
  resize(dimension) {
    this.dimension = dimension;
    this.size = dimension * dimension;
    this.slots = new Array(this.size).fill(null);
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

  /** Overwrite a slot, validating the stack the same way Inventory does. */
  set(index, stack) {
    if (index < 0 || index >= this.size) return;
    if (!stack || stack.count <= 0 || !ItemRegistry.isValid(stack.item) || stack.item === EMPTY_ITEM) {
      this.slots[index] = null;
      return;
    }
    const maxStack = ItemRegistry.maxStack(stack.item);
    const entry = { item: stack.item, count: Math.min(stack.count, maxStack) };
    const maxDurability = ItemRegistry.durability(stack.item);
    if (maxDurability > 0) {
      const value = Number.isFinite(stack.durability) ? stack.durability : maxDurability;
      entry.durability = Math.max(0, Math.min(maxDurability, Math.round(value)));
    }
    this.slots[index] = entry;
  }

  /** True when every slot is empty. */
  isEmptyGrid() {
    return this.slots.every((slot) => !slot || slot.count <= 0);
  }

  /** A copy of the slot array, safe to hand to the matcher. */
  toArray() {
    return this.slots.slice();
  }

  /**
   * Move every stack back into an inventory.
   *
   * Whatever does not fit is returned to the caller instead of being deleted,
   * so the UI can drop it into the world. Losing a player's materials because
   * they closed a screen would be unacceptable.
   *
   * @param {import('./Inventory.js').Inventory} inventory
   * @returns {Array<{item:string,count:number}>} stacks that did not fit
   */
  returnAllTo(inventory) {
    const leftover = [];
    for (let i = 0; i < this.size; i++) {
      const slot = this.slots[i];
      if (!slot || slot.count <= 0) continue;
      const remaining = inventory.add(slot.item, slot.count);
      if (remaining > 0) leftover.push({ item: slot.item, count: remaining });
      this.slots[i] = null;
    }
    return leftover;
  }

  /** Serialise like Inventory does (tools carry their durability). */
  serialize() {
    const out = [];
    for (let i = 0; i < this.size; i++) {
      const slot = this.slots[i];
      if (!slot || slot.count <= 0) continue;
      out.push(slot.durability === undefined
        ? [i, slot.item, slot.count]
        : [i, slot.item, slot.count, slot.durability]);
    }
    return out;
  }
}
