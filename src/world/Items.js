/**
 * Items.js — the item registry.
 *
 * Items are identified by stable string keys (used in save files and the UI).
 * Every placeable block has a matching item; a few items exist only as
 * materials, and the tool items add durability on top.
 *
 * Like Blocks.js this module must stay DOM-free so workers can import it, and
 * so the offline recipe builder (`tools/build-recipes.mjs`) can import it in
 * plain Node to validate that every recipe names a real item.
 */

import { BlockId, BlockRegistry } from './Blocks.js';

/**
 * @typedef {Object} ToolStats
 * @property {'pickaxe'|'axe'|'shovel'|'sword'} type
 * @property {number} tier      harvest tier: 1 wood, 2 stone, 3 iron
 * @property {number} speed     block-breaking speed multiplier
 * @property {number} damage    attack damage, in half-hearts
 */

/**
 * @typedef {Object} ItemDefinition
 * @property {string} key        stable identifier
 * @property {string} name       display name
 * @property {number} maxStack   maximum stack size (1 for tools)
 * @property {string} tile       atlas tile name used for the icon
 * @property {number|null} blockId block placed when used, or null for materials
 * @property {number} [durability] uses before the item breaks (tools only)
 * @property {ToolStats} [tool]  tool behaviour, when the item is a tool
 * @property {number} [fuel]     items this unit smelts in a furnace
 */

/** Special item key meaning "nothing". */
export const EMPTY_ITEM = 'air';

/** Durability of every tool, by tier: wood, stone, iron. */
export const TOOL_DURABILITY = { 1: 60, 2: 132, 3: 251 };

/** Block-breaking speed multiplier of every tool, by tier. */
export const TOOL_SPEED = { 1: 2, 2: 4, 3: 6 };

/** Attack damage in half-hearts: tools do more than a bare fist (1). */
const TOOL_DAMAGE = { pickaxe: 2, axe: 3, shovel: 2, sword: 4 };

/**
 * Materials that are not blocks.
 * @type {ItemDefinition[]}
 */
const MATERIAL_ITEMS = [
  { key: 'coal', name: 'Coal', maxStack: 64, tile: 'item_coal', blockId: null, fuel: 8 },
  { key: 'fiber', name: 'Fiber', maxStack: 64, tile: 'item_fiber', blockId: null },
  { key: 'stick', name: 'Stick', maxStack: 64, tile: 'item_stick', blockId: null, fuel: 0.5 },
  { key: 'charcoal', name: 'Charcoal', maxStack: 64, tile: 'item_charcoal', blockId: null, fuel: 8 },
  { key: 'iron_nugget', name: 'Iron Nugget', maxStack: 64, tile: 'item_iron_nugget', blockId: null },
  { key: 'iron_ingot', name: 'Iron Ingot', maxStack: 64, tile: 'item_iron_ingot', blockId: null },
  // A bucket stacks to 16 like the real thing; a filled one never stacks.
  { key: 'bucket', name: 'Bucket', maxStack: 16, tile: 'item_bucket', blockId: null },
  { key: 'water_bucket', name: 'Water Bucket', maxStack: 1, tile: 'item_water_bucket', blockId: null }
];

/**
 * Tool items. Every tool is unstackable and carries durability, so the
 * inventory stores a per-stack `durability` alongside the count.
 * @type {ItemDefinition[]}
 */
const TOOL_ITEMS = [
  tool('wooden_pickaxe', 'Wooden Pickaxe', 'pickaxe', 1),
  tool('wooden_axe', 'Wooden Axe', 'axe', 1),
  tool('wooden_shovel', 'Wooden Shovel', 'shovel', 1),
  tool('wooden_sword', 'Wooden Sword', 'sword', 1),
  tool('stone_pickaxe', 'Stone Pickaxe', 'pickaxe', 2),
  tool('stone_axe', 'Stone Axe', 'axe', 2),
  tool('stone_shovel', 'Stone Shovel', 'shovel', 2),
  tool('stone_sword', 'Stone Sword', 'sword', 2),
  tool('iron_pickaxe', 'Iron Pickaxe', 'pickaxe', 3),
  tool('iron_axe', 'Iron Axe', 'axe', 3),
  tool('iron_shovel', 'Iron Shovel', 'shovel', 3),
  tool('iron_sword', 'Iron Sword', 'sword', 3)
];

/**
 * Build one tool definition.
 * @param {string} key
 * @param {string} name
 * @param {'pickaxe'|'axe'|'shovel'|'sword'} type
 * @param {number} tier
 * @returns {ItemDefinition}
 */
function tool(key, name, type, tier) {
  return {
    key,
    name,
    maxStack: 1,
    tile: `item_${key}`,
    blockId: null,
    durability: TOOL_DURABILITY[tier],
    tool: { type, tier, speed: TOOL_SPEED[tier], damage: TOOL_DAMAGE[type] }
  };
}

/** Fuel values the furnace reads, by item key (items smelted per unit). */
const FUEL_OVERRIDES = {
  planks: 1.5,
  timber: 1.5,
  crafting_table: 1.5
};

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
    blockId: block.id,
    ...(FUEL_OVERRIDES[block.key] !== undefined ? { fuel: FUEL_OVERRIDES[block.key] } : {})
  });
}

// 2. Material items.
for (const def of MATERIAL_ITEMS) defineItem(def);

// 3. Tool items.
for (const def of TOOL_ITEMS) defineItem(def);

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

  /** True when the item is a tool (unstackable, carries durability). */
  isTool(key) {
    const def = ITEMS.get(key);
    return !!(def && def.tool);
  },

  /**
   * Tool behaviour for an item key, or null.
   * @returns {ToolStats|null}
   */
  tool(key) {
    const def = ITEMS.get(key);
    return def && def.tool ? def.tool : null;
  },

  /** Maximum durability of a tool, or 0 for everything else. */
  durability(key) {
    const def = ITEMS.get(key);
    return def && def.durability ? def.durability : 0;
  },

  /** How many items one unit of this fuel smelts (0 when it is not a fuel). */
  fuelValue(key) {
    const def = ITEMS.get(key);
    return def && def.fuel ? def.fuel : 0;
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

  /** Every item key that is a tool. */
  toolKeys() {
    return ORDERED_KEYS.filter((key) => ItemRegistry.isTool(key));
  },

  /**
   * Items the player starts a new world with. Kept small so the early game has
   * a purpose, but not empty so building is possible immediately. Order is part
   * of the contract: the integration tests assume planks land in slot 1.
   */
  startingLoadout() {
    return [
      { item: 'lantern', count: 8 },
      { item: 'planks', count: 24 }
    ];
  },
};
