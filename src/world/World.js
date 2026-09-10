/**
 * World.js — the authoritative voxel data store.
 *
 * Owns the chunk map, exposes world-coordinate block access, records player
 * edits (the "delta" half of seed+delta persistence) and emits change events
 * that the streaming and rendering layers react to.
 *
 * World deliberately knows nothing about WebGL, the DOM or the player.
 */

import { CHUNK_SIZE, WORLD_HEIGHT, LIGHT } from '../core/Config.js';
import { BlockId, SOLID, LIQUID, TARGETABLE, OPAQUE, EMISSION } from './Blocks.js';
import { Chunk, ChunkState, blockIndex } from './Chunk.js';

/**
 * How far a block change can affect light in a neighbouring chunk, in blocks.
 * Light values top out at 15, so a change can never influence anything further
 * than that.
 */
const LIGHT_NEIGHBOUR_RANGE = LIGHT.max;

/** Convert a world coordinate to a chunk coordinate (floor division). */
export function worldToChunk(w) {
  return Math.floor(w / CHUNK_SIZE);
}

/** Convert a world coordinate to a 0..15 local coordinate. */
export function worldToLocal(w) {
  return ((w % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE;
}

/**
 * Numeric chunk key.
 *
 * Chunk lookups happen hundreds of thousands of times per frame while meshing
 * and lighting, so building a template string per lookup is far too expensive.
 * This packs the two coordinates into one exact integer: with an offset of
 * 2^22 the key is collision free for |coordinate| < 2^22 chunks (67 million
 * blocks), and the product stays well inside the 2^53 exact-integer range.
 */
const KEY_OFFSET = 0x400000;
const KEY_STRIDE = 0x800000;
export function chunkKey(cx, cz) {
  return (cx + KEY_OFFSET) * KEY_STRIDE + (cz + KEY_OFFSET);
}

export class World {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {import('./TerrainGenerator.js').TerrainGenerator} generator
   */
  constructor(bus, generator) {
    this.bus = bus;
    this.generator = generator;
    /** @type {number} world seed, persisted with the save */
    this.seed = generator.seed;

    /** @type {Map<number, Chunk>} keyed by the packed numeric key from chunkKey() */
    this.chunks = new Map();
    /**
     * Retained edits for chunks that are no longer resident. Keyed by the
     * readable "cx,cz" name (this path is cold, so readability wins).
     * @type {Map<string, Map<number, number>>}
     */
    this.detachedEdits = new Map();

    // Statistics for the debug overlay.
    this.stats = { edits: 0, generated: 0, lit: 0 };

    // Small cache so repeated access inside one chunk is O(1) without hashing.
    /** @type {Chunk|null} */
    this._lastChunk = null;
    this._lastKey = -1;
  }

  /** Number of chunks currently resident in memory. */
  get chunkCount() {
    return this.chunks.size;
  }

  /** Total resident voxel memory in bytes. */
  memoryFootprint() {
    let total = 0;
    for (const chunk of this.chunks.values()) total += chunk.memoryFootprint();
    return total;
  }

  // -------------------------------------------------------------------------
  // Chunk access
  // -------------------------------------------------------------------------

  /** @returns {Chunk|undefined} */
  getChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    if (this._lastKey === key) return this._lastChunk || undefined;
    const chunk = this.chunks.get(key);
    this._lastKey = key;
    this._lastChunk = chunk || null;
    return chunk;
  }

  /**
   * Fetch the nine chunks around a centre coordinate in one call. Meshing and
   * lighting need all of them repeatedly, so caching them avoids a map lookup
   * (and a coordinate unpack) per border sample.
   * @returns {Array<Chunk|undefined>} index (dz+1)*3 + (dx+1)
   */
  getNeighbourhood(cx, cz, out = new Array(9)) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        out[(dz + 1) * 3 + (dx + 1)] = this.getChunk(cx + dx, cz + dz);
      }
    }
    return out;
  }

  /** @returns {Chunk|undefined} */
  getChunkAt(worldX, worldZ) {
    return this.getChunk(worldToChunk(worldX), worldToChunk(worldZ));
  }

  /** True when the chunk exists and has voxel data. */
  hasDataAt(worldX, worldZ) {
    const chunk = this.getChunkAt(worldX, worldZ);
    return !!chunk && chunk.hasData;
  }

  /**
   * Create (or reuse) the chunk record for a coordinate. Does not generate.
   * @returns {Chunk}
   */
  ensureChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = new Chunk(cx, cz);
      const retained = this.detachedEdits.get(chunk.key);
      if (retained) {
        chunk.edits = new Map(retained);
        this.detachedEdits.delete(chunk.key);
      }
      this.chunks.set(key, chunk);
      this._lastKey = -1;
    }
    return chunk;
  }

  /**
   * Remove a chunk from memory, retaining its edit delta so that walking far
   * away and coming back does not lose the player's changes.
   * @param {string} key
   */
  releaseChunk(cx, cz) {
    const key = chunkKey(cx, cz);
    const chunk = this.chunks.get(key);
    if (!chunk) return null;
    if (chunk.edits.size > 0) this.detachedEdits.set(chunk.key, new Map(chunk.edits));
    this.chunks.delete(key);
    if (this._lastKey === key) {
      this._lastKey = -1;
      this._lastChunk = null;
    }
    return chunk;
  }

  // -------------------------------------------------------------------------
  // Block access (world coordinates)
  // -------------------------------------------------------------------------

  /**
   * Read a block. Returns air for unloaded regions so callers never crash —
   * use `hasDataAt` when the difference between "air" and "not loaded" matters.
   * @returns {number}
   */
  getBlock(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return BlockId.AIR;
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    const chunk = this.getChunk(cx, cz);
    if (!chunk || !chunk.hasData) return BlockId.AIR;
    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    return chunk.blocks[blockIndex(lx, y, lz)];
  }

  /** True when the block at these coordinates is not loaded. */
  isUnloaded(x, y, z) {
    const chunk = this.getChunkAt(x, z);
    return !chunk || !chunk.hasData;
  }

  /**
   * Write a block at world coordinates.
   *
   * @param {number} x @param {number} y @param {number} z
   * @param {number} id new block id
   * @param {{record?:boolean}} [options] record=false skips edit tracking
   *        (used while applying a loaded save, where the edits already exist)
   * @returns {boolean} true when the world actually changed
   */
  setBlock(x, y, z, id, options = {}) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const record = options.record !== false;
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    const chunk = this.getChunk(cx, cz);
    if (!chunk || !chunk.hasData) return false;

    const lx = x - cx * CHUNK_SIZE;
    const lz = z - cz * CHUNK_SIZE;
    const index = blockIndex(lx, y, lz);
    const previous = chunk.blocks[index];
    if (previous === id) return false;

    chunk.blocks[index] = id;
    chunk.updateHeightMap(lx, lz);
    chunk.meshDirty = true;
    chunk.lightDirty = true;
    // Let this chunk offer its (possibly changed) light to its neighbours once
    // more, so a placed lantern lights the cave next door.
    chunk.lightPropagated = false;
    if (record) {
      chunk.edits.set(index, id);
      this.stats.edits++;
    }

    // Light travels up to 15 blocks, so any neighbouring chunk whose nearest
    // column is within that distance may hold light that flowed through (or
    // from) the changed block, and must be recalculated. Without this, breaking
    // a lantern would leave a permanent glow in the chunks next door.
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dz === 0) continue;
        const gapX = dx < 0 ? lx : dx > 0 ? (CHUNK_SIZE - 1 - lx) : 0;
        const gapZ = dz < 0 ? lz : dz > 0 ? (CHUNK_SIZE - 1 - lz) : 0;
        if (Math.max(gapX, gapZ) > LIGHT_NEIGHBOUR_RANGE) continue;
        this.touchNeighbour(cx + dx, cz + dz, true);
      }
    }

    this.bus.emit('blockChanged', { x, y, z, previous, id, cx, cz });
    return true;
  }

  /** Mark a neighbouring chunk dirty when it is loaded. */
  touchNeighbour(cx, cz, includeLight) {
    const neighbour = this.getChunk(cx, cz);
    if (!neighbour || !neighbour.hasData) return;
    neighbour.meshDirty = true;
    if (includeLight) neighbour.lightDirty = true;
  }

  // -------------------------------------------------------------------------
  // Light access
  // -------------------------------------------------------------------------

  /** Skylight 0..15 at world coordinates (0 when unloaded). */
  getSkyLight(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return y >= WORLD_HEIGHT ? 15 : 0;
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    const chunk = this.getChunk(cx, cz);
    if (!chunk || chunk.state < ChunkState.LIT) return 0;
    return chunk.skyLight[blockIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
  }

  /** Block light 0..15 at world coordinates. */
  getBlockLight(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return 0;
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    const chunk = this.getChunk(cx, cz);
    if (!chunk || chunk.state < ChunkState.LIT) return 0;
    return chunk.blockLight[blockIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)];
  }

  /** Combined light used for mob spawning decisions. */
  getLight(x, y, z) {
    return Math.max(this.getSkyLight(x, y, z), this.getBlockLight(x, y, z));
  }

  // -------------------------------------------------------------------------
  // Convenience queries used by physics, entities and the generator
  // -------------------------------------------------------------------------

  /** True when the block stops movement. Unloaded space is treated as solid. */
  isSolid(x, y, z) {
    if (y < 0) return true;
    if (y >= WORLD_HEIGHT) return false;
    const chunk = this.getChunkAt(x, z);
    if (!chunk || !chunk.hasData) return true; // never let the player fall out of the world
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    return SOLID[chunk.blocks[blockIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]] === 1;
  }

  /** True when the block is a fluid. */
  isLiquid(x, y, z) {
    if (y < 0 || y >= WORLD_HEIGHT) return false;
    const chunk = this.getChunkAt(x, z);
    if (!chunk || !chunk.hasData) return false;
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    return LIQUID[chunk.blocks[blockIndex(x - cx * CHUNK_SIZE, y, z - cz * CHUNK_SIZE)]] === 1;
  }

  /** True when the block can be hit by the interaction ray. */
  isTargetable(x, y, z) {
    const id = this.getBlock(x, y, z);
    return TARGETABLE[id] === 1;
  }

  /** True when the block fully blocks light. */
  isOpaque(x, y, z) {
    return OPAQUE[this.getBlock(x, y, z)] === 1;
  }

  /** Light emitted by the block at these coordinates. */
  emission(x, y, z) {
    return EMISSION[this.getBlock(x, y, z)];
  }

  /**
   * Highest non-air block in a column, or -1 when the column is unloaded/empty.
   */
  heightAt(x, z) {
    const chunk = this.getChunkAt(x, z);
    if (!chunk || !chunk.hasData) return -1;
    const cx = worldToChunk(x);
    const cz = worldToChunk(z);
    return chunk.heightMap[(z - cz * CHUNK_SIZE) * CHUNK_SIZE + (x - cx * CHUNK_SIZE)];
  }

  /** True when the column at these coordinates has been generated. */
  isColumnLoaded(x, z) {
    const chunk = this.getChunkAt(x, z);
    return !!chunk && chunk.hasData;
  }

  // -------------------------------------------------------------------------
  // Persistence support
  // -------------------------------------------------------------------------

  /**
   * Collect every chunk edit, including chunks that are no longer resident.
   * @returns {Record<string, Array<[number, number]>>} chunk key -> [index, id] pairs
   */
  serializeEdits() {
    /** @type {Record<string, Array<[number, number]>>} */
    const out = {};
    const pushChunk = (name, edits) => {
      if (!edits || edits.size === 0) return;
      const pairs = new Array(edits.size);
      let i = 0;
      for (const [index, id] of edits) pairs[i++] = [index, id];
      out[name] = pairs;
    };
    for (const chunk of this.chunks.values()) pushChunk(chunk.key, chunk.edits);
    for (const [name, edits] of this.detachedEdits) {
      // A resident chunk's edits take precedence over any retained copy.
      if (!out[name]) pushChunk(name, edits);
    }
    return out;
  }

  /**
   * Replace all edit deltas from a save file. Invalid entries are skipped and
   * counted so a partially corrupt save degrades instead of failing.
   * @param {Record<string, Array<[number, number]>>} data
   * @param {(id:number)=>boolean} isValidBlock
   * @returns {{accepted:number, rejected:number}}
   */
  loadEdits(data, isValidBlock) {
    let accepted = 0;
    let rejected = 0;
    this.detachedEdits.clear();
    for (const chunk of this.chunks.values()) chunk.edits.clear();

    if (!data || typeof data !== 'object') return { accepted, rejected };

    for (const [key, pairs] of Object.entries(data)) {
      if (!/^-?\d+,-?\d+$/.test(key) || !Array.isArray(pairs)) { rejected++; continue; }
      const map = new Map();
      for (const entry of pairs) {
        if (!Array.isArray(entry) || entry.length !== 2) { rejected++; continue; }
        const index = entry[0] | 0;
        const id = entry[1] | 0;
        if (index < 0 || index >= CHUNK_SIZE * CHUNK_SIZE * WORLD_HEIGHT || !isValidBlock(id)) {
          rejected++;
          continue;
        }
        map.set(index, id);
        accepted++;
      }
      if (map.size > 0) this.detachedEdits.set(key, map);
    }
    this.stats.edits = accepted;
    return { accepted, rejected };
  }

  /** Apply the stored delta for a chunk that has just been generated. */
  applyEdits(chunk) {
    const edits = chunk.edits;
    if (!edits || edits.size === 0) {
      // Pick up a retained delta for this coordinate if one exists.
      const retained = this.detachedEdits.get(chunk.key);
      if (retained && retained.size > 0) {
        for (const [index, id] of retained) chunk.blocks[index] = id;
        chunk.edits = new Map(retained);
        this.detachedEdits.delete(chunk.key);
        chunk.recomputeHeightMaps();
      }
      return 0;
    }
    for (const [index, id] of edits) chunk.blocks[index] = id;
    chunk.recomputeHeightMaps();
    return edits.size;
  }

  /** Drop every chunk (used when leaving a world). */
  clear() {
    this.chunks.clear();
    this.detachedEdits.clear();
    this._lastKey = -1;
    this._lastChunk = null;
    this.stats.edits = 0;
    this.stats.generated = 0;
    this.stats.lit = 0;
  }
}
