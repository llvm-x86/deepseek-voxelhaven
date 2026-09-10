/**
 * Items.js — the item registry.
 *
 * Items are identified by stable string keys (used in save files and the UI).
 * Every placeable block has a matching item; a few items exist only as
 * materials and have no block form.
 *
 * Like Blocks.js this module must stay DOM-free so workers can import it.
 */

import { BlockId, BlockRegistry } from './Blocks.js';

/**
 * @typedef {Object} ItemDefinition
 * @property {string} key        stable identifier
 * @property {string} name       display name
 * @property {number} maxStack   maximum stack size
 * @property {string} tile       atlas tile name used for the icon
 * @property {number|null} blockId block placed when used, or null for materials
 * @property {number} [fuel]     reserved: future smelting value
 */

/** Special item key meaning "nothing". */
export const EMPTY_ITEM = 'air';

/**
 * Materials that are not blocks.
 * @type {ItemDefinition[]}
 */
const MATERIAL_ITEMS = [
  { key: 'coal', name: 'Coal', maxStack: 64, tile: 'item_coal', blockId: null },
  { key: 'fiber', name: 'Fiber', maxStack: 64, tile: 'item_fiber', blockId: null }
];

/** @type {Map<string, ItemDefinition>} */
const ITEMS = new Map();

/** Items in display order, used to build the creative/inventory palette. */
const ORDERED_KEYS = [];

function defineItem(def) {
  if (ITEMS.has(def.key)) throw new Error(`[Items] duplicate item key "${def.key}"`);
  ITEMS.set(def.key, def);
  ORDERED_KEYS.push(def.key);
  return def;
}

// 1. Every block except air becomes an item whose icon uses that block's
//    "icon face" — the side texture for most blocks, the top for plants.
for (const block of BlockRegistry.all()) {
  if (block.id === BlockId.AIR) continue;
  if (block.key === 'water') continue; // water is not collectible
  const iconFace = block.plant ? 2 : 0;
  defineItem({
    key: block.key,
    name: block.name,
    maxStack: 64,
    tile: BlockRegistry.faceTileName(block.id, iconFace),
    blockId: block.id
  });
}

// 2. Material items.
for (const def of MATERIAL_ITEMS) defineItem(def);

/** Mapping from item key back to the block id it places (null for materials). */
const BLOCK_OF_ITEM = new Map();
for (const [key, def] of ITEMS) BLOCK_OF_ITEM.set(key, def.blockId);

export const ItemRegistry = {
  /** @returns {ItemDefinition|undefined} */
  get(key) {
    return ITEMS.get(key);
  },

  /** @returns {boolean} */
  has(key) {
    return ITEMS.has(key);
  },

  /** Display name for an item key, falling back to the raw key. */
  name(key) {
    const def = ITEMS.get(key);
    return def ? def.name : key;
  },

  /** Maximum stack size for an item key (1 for unknown items). */
  maxStack(key) {
    const def = ITEMS.get(key);
    return def ? def.maxStack : 1;
  },

  /** Atlas tile name used as the item's icon. */
  tile(key) {
    const def = ITEMS.get(key);
    return def ? def.tile : 'missing';
  },

  /**
   * Block id placed when the item is used.
   * @returns {number|null} null when the item is not placeable
   */
  blockIdOf(key) {
    const id = BLOCK_OF_ITEM.get(key);
    return typeof id === 'number' ? id : null;
  },

  /** True when the item places a block. */
  isPlaceable(key) {
    return ItemRegistry.blockIdOf(key) !== null;
  },

  /** Item key that a block breaks into (its primary drop). */
  itemOfBlock(blockId) {
    const drop = BlockRegistry.drops(blockId);
    return drop && drop.item !== EMPTY_ITEM ? drop.item : null;
  },

  /** True when the key refers to a real, known item. */
  isValid(key) {
    return key === EMPTY_ITEM || ITEMS.has(key);
  },

  /** Every item definition in registration order. */
  all() {
    return ORDERED_KEYS.map((k) => ITEMS.get(k));
  },

  /** Every item key in registration order. */
  keys() {
    return ORDERED_KEYS.slice();
  },

  /**
   * Items the player starts a new world with. Kept small so the early game has
   * a purpose, but not empty so building is possible immediately.
   */
  startingLoadout() {
    return [
      { item: 'lantern', count: 8 },
      { item: 'planks', count: 24 }
    ];
  }
};
