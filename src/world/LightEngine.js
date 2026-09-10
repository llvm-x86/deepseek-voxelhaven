/**
 * LightEngine.js — per-chunk skylight and block-light propagation.
 *
 * Model
 *  - Skylight (0..15) is seeded from the top of the world downwards. A column
 *    is fully lit until it hits a light-blocking block; water and leaves
 *    attenuate it gradually. Seeded cells then flood horizontally/downwards.
 *  - Block light (0..15) is seeded by emissive blocks (lanterns, glowcaps) and
 *    spreads the same way.
 *  - Propagation reads voxels and light from the 8 surrounding chunks so light
 *    crosses chunk borders, but only ever writes inside the chunk being lit.
 *    When a chunk finishes lighting, its four neighbours are marked for a
 *    re-import pass, which is what makes cross-border light converge without
 *    any global synchronisation.
 *
 * Both passes use a BFS over a growable integer queue. Positions are packed
 * into a single int to avoid allocating objects per cell (this runs tens of
 * thousands of times per chunk).
 */

import { CHUNK_SIZE, WORLD_HEIGHT, LIGHT } from '../core/Config.js';
import { OPAQUE, ATTENUATION, EMISSION } from './Blocks.js';
import { ChunkState } from './Chunk.js';

const MAX_LIGHT = LIGHT.max;

/**
 * Growable FIFO queue of packed block positions.
 * Packing: (y << 10) | ((z + 1) << 5) | (x + 1) covers x,z in [-1,16] and y in [0,127].
 */
class PositionQueue {
  constructor(capacity = 4096) {
    this.data = new Int32Array(capacity);
    this.head = 0;
    this.tail = 0;
  }

  get size() {
    return this.tail - this.head;
  }

  clear() {
    this.head = 0;
    this.tail = 0;
  }

  push(packed) {
    if (this.tail === this.data.length) {
      // Compact when the head has advanced, otherwise grow.
      if (this.head > this.data.length / 2) {
        this.data.copyWithin(0, this.head, this.tail);
        this.tail -= this.head;
        this.head = 0;
      } else {
        const grown = new Int32Array(this.data.length * 2);
        grown.set(this.data);
        this.data = grown;
      }
    }
    this.data[this.tail++] = packed;
  }

  shift() {
    return this.data[this.head++];
  }
}

/** Pack local chunk coordinates (x,z may be -1..16) plus y into one int. */
function pack(x, y, z) {
  return (y << 10) | ((z + 1) << 5) | (x + 1);
}

/** Unpack into a reusable scratch object. */
const scratch = { x: 0, y: 0, z: 0 };
function unpack(packed) {
  scratch.x = (packed & 31) - 1;
  scratch.z = ((packed >> 5) & 31) - 1;
  scratch.y = packed >> 10;
  return scratch;
}

export class LightEngine {
  constructor() {
    this.skyQueue = new PositionQueue(8192);
    this.blockQueue = new PositionQueue(4096);
    /** Diagnostics. */
    this.stats = { chunksLit: 0, lastCellsVisited: 0 };
  }

  /**
   * Recompute both light channels for a chunk.
   *
   * @param {import('./Chunk.js').Chunk} chunk
   * @param {import('./World.js').World} world
   */
  compute(chunk, world) {
    this.seed(chunk);
    this.importFromNeighbours(chunk, world);
    const visited = this.floodAll(chunk, world);
    this.stats.chunksLit++;
    this.stats.lastCellsVisited = visited;
    return visited;
  }

  /**
   * Clear both light channels for a chunk and seed them from the chunk's own
   * content only: the skylight columns and the emissive blocks.
   *
   * This is the first half of a full recompute. It is exposed separately so a
   * batch of chunks affected by one edit can all be cleared *before* any of
   * them reads light from its neighbours — otherwise a removed light source
   * would immediately be re-imported from a neighbour that still remembers it.
   *
   * @param {import('./Chunk.js').Chunk} chunk
   */
  seed(chunk) {
    const blocks = chunk.blocks;
    const sky = chunk.skyLight;
    const block = chunk.blockLight;
    sky.fill(0);
    block.fill(0);

    this.skyQueue.clear();
    this.blockQueue.clear();

    // --- Skylight: walk each column down from the build limit --------------
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        let level = MAX_LIGHT;
        for (let y = WORLD_HEIGHT - 1; y >= 0; y--) {
          const index = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
          const id = blocks[index];
          if (OPAQUE[id] === 1) break;
          const attenuation = ATTENUATION[id];
          if (attenuation > 0) {
            level -= attenuation;
            if (level <= 0) break;
          }
          sky[index] = level;
          this.skyQueue.push(pack(x, y, z));
        }
      }
    }

    // --- Block light: every emissive block is a source ---------------------
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const layer = y * CHUNK_SIZE * CHUNK_SIZE;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const index = layer + z * CHUNK_SIZE + x;
          const emission = EMISSION[blocks[index]];
          if (emission > 0) {
            block[index] = emission;
            this.blockQueue.push(pack(x, y, z));
          }
        }
      }
    }
  }

  /** Run both flood fills after the queues have been primed. */
  floodAll(chunk, world) {
    return this.flood(chunk, world, this.skyQueue, chunk.skyLight)
      + this.flood(chunk, world, this.blockQueue, chunk.blockLight);
  }

  /**
   * Seed the queues with light entering from adjacent chunks. A neighbour's
   * border value of L contributes L-1 to the cell on our side of the border.
   */
  importFromNeighbours(chunk, world) {
    const cx = chunk.cx;
    const cz = chunk.cz;

    for (let dir = 0; dir < 4; dir++) {
      const nx = cx + (dir === 0 ? -1 : dir === 1 ? 1 : 0);
      const nz = cz + (dir === 2 ? -1 : dir === 3 ? 1 : 0);
      const neighbour = world.getChunk(nx, nz);
      if (!neighbour || neighbour.state < ChunkState.LIT) continue;
      // A neighbour that is itself queued for a light recompute still holds
      // values from before the edit. Importing them would bake a ghost of a
      // light source that has already been removed into this chunk, and the
      // ghost survives every later pass because this chunk is no longer dirty.
      // The neighbour offers its light again — through the `lightPropagated`
      // re-import pass — as soon as it is clean, so skipping it here is both
      // safe and what makes removing a light source converge to zero.
      if (neighbour.lightDirty) continue;

      for (let i = 0; i < CHUNK_SIZE; i++) {
        for (let y = 0; y < WORLD_HEIGHT; y++) {
          // Neighbour cell just outside our border, and our matching cell.
          let nLocalX;
          let nLocalZ;
          let lLocalX;
          let lLocalZ;
          if (dir === 0) { nLocalX = CHUNK_SIZE - 1; nLocalZ = i; lLocalX = 0; lLocalZ = i; }
          else if (dir === 1) { nLocalX = 0; nLocalZ = i; lLocalX = CHUNK_SIZE - 1; lLocalZ = i; }
          else if (dir === 2) { nLocalZ = CHUNK_SIZE - 1; nLocalX = i; lLocalZ = 0; lLocalX = i; }
          else { nLocalZ = 0; nLocalX = i; lLocalZ = CHUNK_SIZE - 1; lLocalX = i; }

          const nIndex = (y * CHUNK_SIZE + nLocalZ) * CHUNK_SIZE + nLocalX;
          const lIndex = (y * CHUNK_SIZE + lLocalZ) * CHUNK_SIZE + lLocalX;

          // Neighbour light minus one, but only if it can actually reach us.
          const nSky = neighbour.skyLight[nIndex] - 1;
          if (nSky > chunk.skyLight[lIndex] && OPAQUE[chunk.blocks[lIndex]] !== 1) {
            chunk.skyLight[lIndex] = nSky;
            this.skyQueue.push(pack(lLocalX, y, lLocalZ));
          }
          const nBlock = neighbour.blockLight[nIndex] - 1;
          if (nBlock > chunk.blockLight[lIndex] && OPAQUE[chunk.blocks[lIndex]] !== 1) {
            chunk.blockLight[lIndex] = nBlock;
            this.blockQueue.push(pack(lLocalX, y, lLocalZ));
          }
        }
      }
    }
  }

  /**
   * BFS flood fill for one light channel.
   * Writes are clamped to the chunk; reads outside it come from the world so
   * light flows correctly across borders without touching neighbour arrays.
   *
   * @param {import('./Chunk.js').Chunk} chunk
   * @param {import('./World.js').World} world
   * @param {PositionQueue} queue
   * @param {Uint8Array} target light array of `chunk`
   * @returns {number} number of cells visited
   */
  flood(chunk, world, queue, target) {
    const blocks = chunk.blocks;
    const ox = chunk.originX;
    const oz = chunk.originZ;
    let visited = 0;

    while (queue.size > 0) {
      const packed = queue.shift();
      const { x, y, z } = unpack(packed);
      visited++;

      const current = target[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
      if (current <= 0) continue;
      const next = current - 1;

      for (let dir = 0; dir < 6; dir++) {
        const nx = x + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
        const ny = y + (dir === 2 ? 1 : dir === 3 ? -1 : 0);
        const nz = z + (dir === 4 ? 1 : dir === 5 ? -1 : 0);
        if (ny < 0 || ny >= WORLD_HEIGHT) continue;
        if (nx < -1 || nx > CHUNK_SIZE || nz < -1 || nz > CHUNK_SIZE) continue;

        let id;
        let targetArray;
        let targetIndex;
        if (nx >= 0 && nx < CHUNK_SIZE && nz >= 0 && nz < CHUNK_SIZE) {
          targetIndex = (ny * CHUNK_SIZE + nz) * CHUNK_SIZE + nx;
          id = blocks[targetIndex];
          targetArray = target;
        } else {
          // Outside this chunk: read the neighbour's voxel, but do not write.
          id = world.getBlock(ox + nx, ny, oz + nz);
        }

        if (OPAQUE[id] === 1) continue;
        // Attenuating blocks (water, leaves) absorb an extra light level.
        const attenuation = ATTENUATION[id];
        const incoming = attenuation > 0 ? next - attenuation : next;
        if (incoming <= 0) continue;

        if (targetArray && incoming > targetArray[targetIndex]) {
          targetArray[targetIndex] = incoming;
          queue.push(pack(nx, ny, nz));
        }
      }
    }
    return visited;
  }
}
