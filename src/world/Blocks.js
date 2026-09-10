/**
 * Blocks.js — the block registry.
 *
 * This module is deliberately free of any DOM/WebGL dependency so it can be
 * imported inside Web Workers by the terrain generator.
 *
 * Block ids are stable small integers (0..255) because chunks store one byte
 * per block. Adding a new block means appending to BLOCK_LIST; never reorder
 * or renumber existing entries or existing saves will decode incorrectly.
 *
 * Face index convention used everywhere in the project:
 *   0 = +X (east)   1 = -X (west)
 *   2 = +Y (top)    3 = -Y (bottom)
 *   4 = +Z (south)  5 = -Z (north)
 */

/** Stable numeric ids for every block. */
export const BlockId = Object.freeze({
  AIR: 0,
  TURF: 1,
  LOAM: 2,
  STONE: 3,
  COBBLE: 4,
  SAND: 5,
  SANDSTONE: 6,
  GRAVEL: 7,
  SNOW: 8,
  TIMBER: 9,
  CANOPY: 10,
  PLANKS: 11,
  WATER: 12,
  COAL_ORE: 13,
  BEDROCK: 14,
  GLASS: 15,
  LANTERN: 16,
  GLOWCAP: 17,
  CACTUS: 18,
  BRAMBLE: 19,
  BLOOM: 20
});

/** Number of bytes available for block ids in a chunk. */
export const BLOCK_ID_LIMIT = 256;

/** Face index constants. */
export const FACE = Object.freeze({
  EAST: 0,
  WEST: 1,
  TOP: 2,
  BOTTOM: 3,
  SOUTH: 4,
  NORTH: 5
});

/** Unit normal for each face index: [x, y, z]. */
export const FACE_NORMALS = [
  [1, 0, 0], [-1, 0, 0],
  [0, 1, 0], [0, -1, 0],
  [0, 0, 1], [0, 0, -1]
];

/** Opposite face index, used to find the neighbour that shares a face. */
export const FACE_OPPOSITE = [1, 0, 3, 2, 5, 4];

/**
 * @typedef {Object} BlockDefinition
 * @property {number} id                 stable numeric id
 * @property {string} key                stable string key (used in saves/UI)
 * @property {string} name               human readable name
 * @property {boolean} solid             blocks player/entity movement
 * @property {boolean} opaque            fully blocks light and hides neighbour faces
 * @property {boolean} [translucent]     rendered in the transparent pass
 * @property {boolean} [liquid]          behaves as a fluid for physics
 * @property {boolean} [replaceable]     can be overwritten by placement / worldgen
 * @property {boolean} [targetable]      can be selected by the block raycast
 * @property {boolean} [emissive]        emits block light
 * @property {number} [emission]         emitted light level 0..15
 * @property {number} [attenuation]      extra skylight loss passing through
 * @property {number} hardness           seconds to break by hand (0 = instant)
 * @property {string[]} textures         tile name per face index
 * @property {{item:string, min:number, max:number}} drops what breaking yields
 * @property {string} sound              audio group: stone|dirt|grass|wood|sand|glass|liquid|plant
 * @property {boolean} [plant]           decorative, breaks instantly, no collision
 */

/**
 * Master block list. Index in this array MUST equal definition.id.
 * @type {BlockDefinition[]}
 */
const BLOCK_LIST = [
  {
    id: 0, key: 'air', name: 'Air',
    solid: false, opaque: false, translucent: true, replaceable: true, targetable: false,
    hardness: 0, textures: ['air', 'air', 'air', 'air', 'air', 'air'],
    drops: { item: 'air', min: 0, max: 0 }, sound: 'none'
  },
  {
    id: 1, key: 'turf', name: 'Turf',
    solid: true, opaque: true,
    hardness: 0.65, sound: 'grass',
    // Top is grass, bottom is dirt, sides are the grass/dirt blend.
    textures: ['turf_side', 'turf_side', 'turf_top', 'loam', 'turf_side', 'turf_side'],
    drops: { item: 'loam', min: 1, max: 1 }
  },
  {
    id: 2, key: 'loam', name: 'Loam',
    solid: true, opaque: true,
    hardness: 0.55, sound: 'dirt',
    textures: ['loam', 'loam', 'loam', 'loam', 'loam', 'loam'],
    drops: { item: 'loam', min: 1, max: 1 }
  },
  {
    id: 3, key: 'stone', name: 'Stone',
    solid: true, opaque: true,
    hardness: 1.6, sound: 'stone',
    textures: ['stone', 'stone', 'stone', 'stone', 'stone', 'stone'],
    drops: { item: 'cobble', min: 1, max: 1 }
  },
  {
    id: 4, key: 'cobble', name: 'Cobblestone',
    solid: true, opaque: true,
    hardness: 1.5, sound: 'stone',
    textures: ['cobble', 'cobble', 'cobble', 'cobble', 'cobble', 'cobble'],
    drops: { item: 'cobble', min: 1, max: 1 }
  },
  {
    id: 5, key: 'sand', name: 'Sand',
    solid: true, opaque: true,
    hardness: 0.5, sound: 'sand',
    textures: ['sand', 'sand', 'sand', 'sand', 'sand', 'sand'],
    drops: { item: 'sand', min: 1, max: 1 }
  },
  {
    id: 6, key: 'sandstone', name: 'Sandstone',
    solid: true, opaque: true,
    hardness: 1.2, sound: 'stone',
    textures: ['sandstone_side', 'sandstone_side', 'sandstone_top', 'sandstone_top', 'sandstone_side', 'sandstone_side'],
    drops: { item: 'sandstone', min: 1, max: 1 }
  },
  {
    id: 7, key: 'gravel', name: 'Gravel',
    solid: true, opaque: true,
    hardness: 0.6, sound: 'sand',
    textures: ['gravel', 'gravel', 'gravel', 'gravel', 'gravel', 'gravel'],
    drops: { item: 'gravel', min: 1, max: 1 }
  },
  {
    id: 8, key: 'snow', name: 'Snow Block',
    solid: true, opaque: true,
    hardness: 0.35, sound: 'sand',
    textures: ['snow', 'snow', 'snow', 'snow', 'snow', 'snow'],
    drops: { item: 'snow', min: 1, max: 1 }
  },
  {
    id: 9, key: 'timber', name: 'Timber',
    solid: true, opaque: true,
    hardness: 1.1, sound: 'wood',
    textures: ['timber_side', 'timber_side', 'timber_top', 'timber_top', 'timber_side', 'timber_side'],
    drops: { item: 'timber', min: 1, max: 1 }
  },
  {
    id: 10, key: 'canopy', name: 'Canopy',
    solid: true, opaque: false, translucent: false, attenuation: 1,
    hardness: 0.25, sound: 'plant',
    textures: ['canopy', 'canopy', 'canopy', 'canopy', 'canopy', 'canopy'],
    drops: { item: 'canopy', min: 1, max: 1 }
  },
  {
    id: 11, key: 'planks', name: 'Planks',
    solid: true, opaque: true,
    hardness: 1.0, sound: 'wood',
    textures: ['planks', 'planks', 'planks', 'planks', 'planks', 'planks'],
    drops: { item: 'planks', min: 1, max: 1 }
  },
  {
    id: 12, key: 'water', name: 'Water',
    solid: false, opaque: false, translucent: true, liquid: true, replaceable: true, targetable: false,
    attenuation: 2,
    hardness: 0, sound: 'liquid',
    textures: ['water', 'water', 'water', 'water', 'water', 'water'],
    drops: { item: 'air', min: 0, max: 0 }
  },
  {
    id: 13, key: 'coal_ore', name: 'Coal Ore',
    solid: true, opaque: true,
    hardness: 1.9, sound: 'stone',
    textures: ['coal_ore', 'coal_ore', 'coal_ore', 'coal_ore', 'coal_ore', 'coal_ore'],
    drops: { item: 'coal', min: 1, max: 2 }
  },
  {
    id: 14, key: 'bedrock', name: 'Bedrock',
    solid: true, opaque: true,
    hardness: -1, sound: 'stone', // -1 hardness = unbreakable
    textures: ['bedrock', 'bedrock', 'bedrock', 'bedrock', 'bedrock', 'bedrock'],
    drops: { item: 'air', min: 0, max: 0 }
  },
  {
    id: 15, key: 'glass', name: 'Glass',
    solid: true, opaque: false, translucent: true,
    hardness: 0.4, sound: 'glass',
    textures: ['glass', 'glass', 'glass', 'glass', 'glass', 'glass'],
    drops: { item: 'air', min: 0, max: 0 } // shatters: yields nothing, like the real thing
  },
  {
    id: 16, key: 'lantern', name: 'Lantern',
    solid: true, opaque: true, emissive: true, emission: 14,
    hardness: 0.7, sound: 'glass',
    textures: ['lantern', 'lantern', 'lantern', 'lantern', 'lantern', 'lantern'],
    drops: { item: 'lantern', min: 1, max: 1 }
  },
  {
    id: 17, key: 'glowcap', name: 'Glowcap',
    solid: false, opaque: false, attenuateLight: true, emissive: true, emission: 9,
    hardness: 0.15, sound: 'plant', plant: true, replaceable: true,
    textures: ['glowcap', 'glowcap', 'glowcap', 'glowcap', 'glowcap', 'glowcap'],
    drops: { item: 'glowcap', min: 1, max: 1 }
  },
  {
    id: 18, key: 'cactus', name: 'Cactus',
    solid: true, opaque: true,
    hardness: 0.5, sound: 'plant', plant: true,
    textures: ['cactus_side', 'cactus_side', 'cactus_top', 'cactus_top', 'cactus_side', 'cactus_side'],
    drops: { item: 'cactus', min: 1, max: 1 }
  },
  {
    id: 19, key: 'bramble', name: 'Bramble',
    solid: false, opaque: false, plant: true, replaceable: true, targetable: true,
    hardness: 0.05, sound: 'plant',
    textures: ['bramble', 'bramble', 'bramble', 'bramble', 'bramble', 'bramble'],
    drops: { item: 'fiber', min: 1, max: 2 }
  },
  {
    id: 20, key: 'bloom', name: 'Bloom',
    solid: false, opaque: false, plant: true, replaceable: true, targetable: true,
    hardness: 0.05, sound: 'plant',
    textures: ['bloom', 'bloom', 'bloom', 'bloom', 'bloom', 'bloom'],
    drops: { item: 'bloom', min: 1, max: 1 }
  }
];

/** @type {Map<string, BlockDefinition>} key -> definition */
const BY_KEY = new Map();
/** @type {Map<string, number>} texture tile name -> atlas index (filled by TextureAtlas) */
const TILE_INDEX = new Map();

for (const def of BLOCK_LIST) {
  if (def.id !== BLOCK_LIST.indexOf(def)) {
    throw new Error(`[Blocks] definition for "${def.key}" has id ${def.id} at index ${BLOCK_LIST.indexOf(def)}`);
  }
  if (def.id >= BLOCK_ID_LIMIT) {
    throw new Error(`[Blocks] block "${def.key}" exceeds the ${BLOCK_ID_LIMIT} id limit`);
  }
  // Fill in defaults so consumers never have to check for undefined.
  def.translucent = def.translucent === true;
  def.liquid = def.liquid === true;
  def.replaceable = def.replaceable === true;
  def.targetable = def.targetable !== false;
  def.emissive = def.emissive === true;
  def.emission = def.emission || 0;
  def.attenuation = def.attenuation || 0;
  def.plant = def.plant === true;
  if (!Array.isArray(def.textures) || def.textures.length !== 6) {
    throw new Error(`[Blocks] block "${def.key}" must declare exactly 6 face textures`);
  }
  BY_KEY.set(def.key, def);
}

// ---------------------------------------------------------------------------
// Flat typed-array lookup tables for the hot paths (meshing, lighting, physics)
// ---------------------------------------------------------------------------

/** 1 when the block stops movement. */
export const SOLID = new Uint8Array(BLOCK_ID_LIMIT);
/** 1 when the block fully blocks light and hides neighbouring faces. */
export const OPAQUE = new Uint8Array(BLOCK_ID_LIMIT);
/** 1 when the block is drawn in the translucent pass. */
export const TRANSLUCENT = new Uint8Array(BLOCK_ID_LIMIT);
/** 1 when the block behaves as a fluid. */
export const LIQUID = new Uint8Array(BLOCK_ID_LIMIT);
/** 1 when the block may be overwritten by placement or worldgen. */
export const REPLACEABLE = new Uint8Array(BLOCK_ID_LIMIT);
/** 1 when the block is a decorative plant. */
export const PLANT = new Uint8Array(BLOCK_ID_LIMIT);
/** Block light emission level 0..15. */
export const EMISSION = new Uint8Array(BLOCK_ID_LIMIT);
/** Extra skylight lost per block travelled through this block. */
export const ATTENUATION = new Uint8Array(BLOCK_ID_LIMIT);
/** 1 when the block can be hit by the interaction raycast. */
export const TARGETABLE = new Uint8Array(BLOCK_ID_LIMIT);

for (const def of BLOCK_LIST) {
  SOLID[def.id] = def.solid ? 1 : 0;
  OPAQUE[def.id] = def.opaque ? 1 : 0;
  TRANSLUCENT[def.id] = def.translucent ? 1 : 0;
  LIQUID[def.id] = def.liquid ? 1 : 0;
  REPLACEABLE[def.id] = def.replaceable ? 1 : 0;
  PLANT[def.id] = def.plant ? 1 : 0;
  EMISSION[def.id] = def.emission;
  ATTENUATION[def.id] = def.attenuation;
  TARGETABLE[def.id] = def.targetable ? 1 : 0;
}

// Pre-resolve each block's six face tile *names* into a flat array of strings
// for fast lookup during meshing (atlas indices are resolved lazily).
/** @type {string[][]} */
const FACE_TILES = BLOCK_LIST.map((def) => def.textures.slice());

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const BlockRegistry = {
  /** Total number of registered blocks. */
  get count() { return BLOCK_LIST.length; },

  /** Highest valid block id. */
  get maxId() { return BLOCK_LIST.length - 1; },

  /**
   * Look up a block definition.
   * @param {number} id
   * @returns {BlockDefinition} the air definition when the id is unknown
   */
  get(id) {
    return BLOCK_LIST[id] || BLOCK_LIST[0];
  },

  /**
   * Look up a block by its stable string key.
   * @param {string} key
   * @returns {BlockDefinition|undefined}
   */
  byKey(key) {
    return BY_KEY.get(key);
  },

  /**
   * Resolve a block id by key, falling back to air.
   * @param {string} key
   * @returns {number}
   */
  idByKey(key) {
    const def = BY_KEY.get(key);
    return def ? def.id : 0;
  },

  /**
   * True when the id refers to a registered block. Used to sanitise save data.
   * @param {number} id
   */
  isValid(id) {
    return Number.isInteger(id) && id >= 0 && id < BLOCK_LIST.length;
  },

  /** True when the block stops movement. */
  isSolid(id) { return SOLID[id] === 1; },
  /** True when the block is fully opaque to light and hides faces. */
  isOpaque(id) { return OPAQUE[id] === 1; },
  /** True when the block is rendered with blending. */
  isTranslucent(id) { return TRANSLUCENT[id] === 1; },
  /** True when the block is a fluid. */
  isLiquid(id) { return LIQUID[id] === 1; },
  /** True when the block can be replaced by placement/decoration. */
  isReplaceable(id) { return REPLACEABLE[id] === 1; },
  /** True when the block is a small plant. */
  isPlant(id) { return PLANT[id] === 1; },
  /** True when the block emits light. */
  isEmissive(id) { return EMISSION[id] > 0; },
  /** Light level emitted (0 when not emissive). */
  emission(id) { return EMISSION[id]; },
  /** Extra skylight attenuation. */
  attenuation(id) { return ATTENUATION[id]; },
  /** True when the tell-tale raycast can select the block. */
  isTargetable(id) { return TARGETABLE[id] === 1; },
  /** True for blocks that are completely invisible (air). */
  isAir(id) { return id === 0; },

  /**
   * Texture tile name for one face of one block.
   * @param {number} id
   * @param {number} face 0..5
   * @returns {string}
   */
  faceTileName(id, face) {
    const tiles = FACE_TILES[id] || FACE_TILES[0];
    return tiles[face] || tiles[0];
  },

  /** All six face tile names for a block. */
  faceTiles(id) {
    return FACE_TILES[id] || FACE_TILES[0];
  },

  /** Seconds required to break the block by hand. -1 means unbreakable. */
  hardness(id) {
    const def = BLOCK_LIST[id];
    return def ? def.hardness : 0;
  },

  /** True when the block cannot be broken by the player. */
  isUnbreakable(id) {
    const def = BLOCK_LIST[id];
    return !!def && def.hardness < 0;
  },

  /** Drop table for a block. */
  drops(id) {
    const def = BLOCK_LIST[id];
    return def ? def.drops : { item: 'air', min: 0, max: 0 };
  },

  /** Audio group used for break/place/step sounds. */
  sound(id) {
    const def = BLOCK_LIST[id];
    return def ? def.sound : 'stone';
  },

  /** Iterate every registered block definition. */
  all() {
    return BLOCK_LIST;
  }
};

/**
 * Sanitise a block id coming from an untrusted source (save file, network).
 * @param {unknown} id
 * @returns {number} a valid block id, or 0 (air) when invalid
 */
export function sanitizeBlockId(id) {
  const n = typeof id === 'number' ? id : Number(id);
  return BlockRegistry.isValid(n) ? n : 0;
}
