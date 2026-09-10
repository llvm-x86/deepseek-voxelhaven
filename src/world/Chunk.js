/**
 * Chunk.js — voxel storage for one 16 x 128 x 16 column of the world.
 *
 * Layout notes
 *  - `blocks` is a flat Uint8Array of block ids, indexed as
 *        index = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x
 *    which keeps a full horizontal slice contiguous (good for meshing and for
 *    column scans during generation).
 *  - Light is stored in two parallel byte arrays holding values 0..15.
 *
 * A chunk owns no GPU resources: the renderer keeps those, keyed by chunk key,
 * so a chunk can be unloaded and its data kept while its mesh is freed.
 */

import { CHUNK_SIZE, WORLD_HEIGHT, CHUNK_VOLUME, CHUNK_AREA } from '../core/Config.js';
import { BlockId, OPAQUE } from './Blocks.js';

/** Convert local chunk coordinates to a flat array index. */
export function blockIndex(x, y, z) {
  return (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
}

/** Lifecycle states a chunk moves through. */
export const ChunkState = Object.freeze({
  /** Voxel data not yet requested. */
  EMPTY: 0,
  /** Generation queued or running. */
  GENERATING: 1,
  /** Voxels exist; lighting not yet computed. */
  GENERATED: 2,
  /** Lighting computed; mesh not yet built. */
  LIT: 3,
  /** Mesh built and uploaded. */
  READY: 4
});

export class Chunk {
  /**
   * @param {number} cx chunk X coordinate
   * @param {number} cz chunk Z coordinate
   */
  constructor(cx, cz) {
    this.cx = cx;
    this.cz = cz;
    /** World-space origin of the chunk (block corner). */
    this.originX = cx * CHUNK_SIZE;
    this.originZ = cz * CHUNK_SIZE;

    /** @type {Uint8Array} block ids */
    this.blocks = new Uint8Array(CHUNK_VOLUME);
    /** @type {Uint8Array} skylight 0..15 */
    this.skyLight = new Uint8Array(CHUNK_VOLUME);
    /** @type {Uint8Array} block light 0..15 */
    this.blockLight = new Uint8Array(CHUNK_VOLUME);

    /** Highest non-air block per column, or -1 for an empty column. */
    this.heightMap = new Int16Array(CHUNK_AREA).fill(-1);
    /** Highest *opaque* block per column, used to seed skylight. */
    this.opaqueHeightMap = new Int16Array(CHUNK_AREA).fill(-1);

    /** @type {number} see ChunkState */
    this.state = ChunkState.EMPTY;
    /** Player edits applied to this chunk: index -> block id. */
    this.edits = new Map();
    /** True when the mesh needs rebuilding. */
    this.meshDirty = true;
    /** True when lighting needs recomputation. */
    this.lightDirty = true;
    /**
     * Set once this chunk's light has been offered to its neighbours. Without
     * this latch, re-lighting a chunk would re-dirty its neighbours, which
     * would re-light them and re-dirty this chunk again — an endless cascade
     * that starves the streaming queue of the frame budget.
     */
    this.lightPropagated = false;
    /** Renderer-owned GPU handles; null until uploaded. */
    this.mesh = null;
    /** Distance to the player in chunks, refreshed by the chunk manager. */
    this.distanceToPlayer = Infinity;
    /** Non-null when generation failed; surfaced in the debug overlay. */
    this.error = null;
  }

  /** Stable string key, e.g. "3,-7". Also used as the renderer mesh key. */
  get key() {
    return `${this.cx},${this.cz}`;
  }

  /** True once voxel data is available (generated or loaded). */
  get hasData() {
    return this.state >= ChunkState.GENERATED;
  }

  /** True once a mesh has been uploaded for this chunk. */
  get isReady() {
    return this.state === ChunkState.READY;
  }

  /** Bounds-checked local coordinate test. */
  static inBounds(x, y, z) {
    return x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y >= 0 && y < WORLD_HEIGHT;
  }

  /**
   * Read a block by local coordinates. Out-of-range reads return air.
   * @returns {number}
   */
  getBlock(x, y, z) {
    if (!Chunk.inBounds(x, y, z)) return BlockId.AIR;
    return this.blocks[blockIndex(x, y, z)];
  }

  /**
   * Recompute both height maps for one column.
   * Cheap enough to call on every write (128 iterations worst case) and it
   * keeps skylight seeding correct without a full rescan.
   *
   *  - heightMap       = highest non-air block (used for spawn placement)
   *  - opaqueHeightMap = highest fully light-blocking block (skylight seed)
   */
  updateHeightMap(x, z) {
    const col = z * CHUNK_SIZE + x;
    let top = -1;
    let opaque = -1;
    for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
      const id = this.blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
      if (id === BlockId.AIR) continue;
      if (top < 0) top = y;
      if (opaque < 0 && OPAQUE[id] === 1) opaque = y;
      if (opaque >= 0) break; // top is already set on the first non-air block
    }
    this.heightMap[col] = top;
    this.opaqueHeightMap[col] = opaque;
  }

  /** Recompute every column's height maps (called after generation). */
  recomputeHeightMaps() {
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) this.updateHeightMap(x, z);
    }
  }

  /** Clear every voxel and derived array to a blank state. */
  clear() {
    this.blocks.fill(BlockId.AIR);
    this.skyLight.fill(0);
    this.blockLight.fill(0);
    this.heightMap.fill(-1);
    this.opaqueHeightMap.fill(-1);
    this.edits.clear();
    this.state = ChunkState.EMPTY;
    this.meshDirty = true;
    this.lightDirty = true;
    this.lightPropagated = false;
    this.error = null;
  }

  /**
   * Highest solid block at a local column, searching downwards from `fromY`.
   * Returns -1 when nothing solid exists. Used for safe spawn placement.
   */
  topSolidAt(x, z, fromY = WORLD_HEIGHT - 1) {
    if (x < 0 || x >= CHUNK_SIZE || z < 0 || z >= CHUNK_SIZE) return -1;
    for (let y = Math.min(fromY, WORLD_HEIGHT - 1); y >= 0; y--) {
      const id = this.blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
      if (id !== BlockId.AIR && id !== BlockId.WATER) return y;
    }
    return -1;
  }

  /**
   * Approximate resident memory in bytes; shown in the debug overlay.
   */
  memoryFootprint() {
    return this.blocks.byteLength + this.skyLight.byteLength + this.blockLight.byteLength
      + this.heightMap.byteLength + this.opaqueHeightMap.byteLength;
  }
}
