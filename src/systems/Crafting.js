/**
 * Crafting.js — a small recipe book.
 *
 * Voxelhaven has no grid-based crafting table. Instead the player opens a
 * Craft panel that lists every recipe they can currently afford, which keeps
 * progression readable and avoids an inventory-management minigame. The
 * recipes exist to connect the raw materials: timber becomes planks, planks
 * and coal become lanterns, sand becomes glass, and fiber becomes canopy.
 */

import { ItemRegistry } from '../world/Items.js';

/**
 * @typedef {Object} Recipe
 * @property {string} id
 * @property {string} name
 * @property {Array<{item:string, count:number}>} inputs
 * @property {{item:string, count:number}} output
 * @property {string} [hint] shown under the recipe in the UI
 */

/** @type {Recipe[]} */
export const RECIPES = [
  {
    id: 'planks',
    name: 'Planks',
    inputs: [{ item: 'timber', count: 1 }],
    output: { item: 'planks', count: 4 },
    hint: 'Saw a timber block into building planks.'
  },
  {
    id: 'glass',
    name: 'Glass',
    inputs: [{ item: 'sand', count: 2 }],
    output: { item: 'glass', count: 1 },
    hint: 'Kiln-fired sand. Transparent, but it shatters when broken.'
  },
  {
    id: 'lantern',
    name: 'Lantern',
    inputs: [
      { item: 'coal', count: 1 },
      { item: 'planks', count: 4 }
    ],
    output: { item: 'lantern', count: 2 },
    hint: 'Lights caves and keeps Gloomlings away.'
  },
  {
    id: 'canopy',
    name: 'Canopy',
    inputs: [{ item: 'fiber', count: 4 }],
    output: { item: 'canopy', count: 1 },
    hint: 'Weave fiber into a block of foliage.'
  }
];

export const Crafting = {
  /** Every recipe, in display order. */
  all() {
    return RECIPES;
  },

  /** Look up a recipe by id. */
  byId(id) {
    return RECIPES.find((recipe) => recipe.id === id) || null;
  },

  /**
   * How many times a recipe could be crafted with the current inventory.
   * @param {import('../player/Inventory.js').Inventory} inventory
   * @param {Recipe} recipe
   * @returns {number}
   */
  affordableCount(inventory, recipe) {
    let crafts = Infinity;
    for (const input of recipe.inputs) {
      const have = inventory.countOf(input.item);
      crafts = Math.min(crafts, Math.floor(have / input.count));
    }
    return crafts === Infinity ? 0 : crafts;
  },

  /** True when the recipe can be crafted at least once. */
  canCraft(inventory, recipe) {
    return Crafting.affordableCount(inventory, recipe) > 0;
  },

  /**
   * Consume the inputs and add the output.
   * @param {import('../player/Inventory.js').Inventory} inventory
   * @param {Recipe} recipe
   * @returns {{ok:boolean, reason?:string}}
   */
  craft(inventory, recipe) {
    if (!recipe) return { ok: false, reason: 'Unknown recipe.' };
    if (!Crafting.canCraft(inventory, recipe)) {
      return { ok: false, reason: `Not enough materials for ${recipe.name}.` };
    }
    // Check there will be room for the output before consuming anything, so a
    // full inventory cannot silently eat the ingredients.
    const maxStack = ItemRegistry.maxStack(recipe.output.item);
    const existingRoom = inventory.slots.reduce((total, slot) => {
      if (!slot || slot.item !== recipe.output.item) return total;
      return total + (maxStack - slot.count);
    }, 0);
    const freeSlots = inventory.slots.filter((slot) => !slot).length;
    if (existingRoom + freeSlots * maxStack < recipe.output.count) {
      return { ok: false, reason: 'No room in the inventory for the result.' };
    }

    for (const input of recipe.inputs) {
      const removed = inventory.removeItem(input.item, input.count);
      if (removed < input.count) {
        // Should be unreachable given the affordability check, but restore
        // what was taken rather than losing the player's materials.
        inventory.add(input.item, removed);
        return { ok: false, reason: `Not enough ${ItemRegistry.name(input.item)}.` };
      }
    }
    inventory.add(recipe.output.item, recipe.output.count);
    return { ok: true };
  },

  /**
   * Recipes the player can currently afford, with their craftable counts.
   * @param {import('../player/Inventory.js').Inventory} inventory
   */
  available(inventory) {
    return RECIPES.map((recipe) => ({
      recipe,
      crafts: Crafting.affordableCount(inventory, recipe)
    }));
  }
};
