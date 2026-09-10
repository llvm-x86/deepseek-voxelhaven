/**
 * Random.js — deterministic pseudo-random number generation.
 *
 * Every random decision in world generation flows through these helpers so a
 * world seed always produces identical terrain. Math.random() must never be
 * used by world generation.
 */

/**
 * SplitMix32 — a fast, well-distributed 32-bit mixing function.
 * Used both as a standalone PRNG and to derive independent sub-seeds.
 * @param {number} seed
 * @returns {number} a well-mixed 32-bit unsigned integer
 */
export function mixSeed32(seed) {
  let z = (seed + 0x9e3779b9) | 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * Deterministic 32-bit hash of three integers. Used for per-block variation
 * (e.g. which way a tree leans) without keeping any state.
 * @param {number} x
 * @param {number} y
 * @param {number} z
 * @param {number} [seed]
 * @returns {number} unsigned 32-bit hash
 */
export function hash3i(x, y, z, seed = 0) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(z | 0, 0x9e3779b1);
  h = (h ^ seed) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Deterministic hash of two integers in [0,1). */
export function hash2f(x, z, seed = 0) {
  return hash3i(x, 0, z, seed) / 4294967296;
}

/** Deterministic hash of three integers in [0,1). */
export function hash3f(x, y, z, seed = 0) {
  return hash3i(x, y, z, seed) / 4294967296;
}

/**
 * Mulberry32 — small, fast, high quality 32-bit PRNG.
 * Produces a stream of floats in [0,1) from a single integer seed.
 */
export class Random {
  /** @param {number} seed */
  constructor(seed = 0) {
    this.state = mixSeed32(seed | 0);
  }

  /** @returns {number} float in [0,1) */
  next() {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** @returns {number} float in [min,max) */
  range(min, max) {
    return min + this.next() * (max - min);
  }

  /** @returns {number} integer in [min,max] inclusive */
  int(min, max) {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** @returns {boolean} true with probability p */
  chance(p) {
    return this.next() < p;
  }

  /** @returns {number} -1 or 1 */
  sign() {
    return this.next() < 0.5 ? -1 : 1;
  }

  /**
   * Weighted pick.
   * @param {Array<{weight:number}>} entries
   * @returns {number} index of the chosen entry, or -1 when the list is empty
   */
  pickWeighted(entries) {
    let total = 0;
    for (const e of entries) total += e.weight;
    if (total <= 0) return -1;
    let roll = this.next() * total;
    for (let i = 0; i < entries.length; i++) {
      roll -= entries[i].weight;
      if (roll <= 0) return i;
    }
    return entries.length - 1;
  }

  /** @template T @param {T[]} arr @returns {T} */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }
}

/**
 * A deterministic random stream bound to a 2D chunk coordinate, so chunk
 * generation is independent of the order in which chunks are generated.
 * @param {number} seed
 * @param {number} cx
 * @param {number} cz
 * @param {number} [salt]
 * @returns {Random}
 */
export function chunkRandom(seed, cx, cz, salt = 0) {
  return new Random(hash3i(cx, salt, cz, seed | 0));
}
