/**
 * Noise.js — deterministic gradient noise used for terrain, caves and biomes.
 *
 * Implements classic Perlin gradient noise with a seed-derived permutation
 * table plus fractal helpers (fBm, ridged multifractal, domain warp). All
 * functions are pure: the same seed and coordinates always yield the same
 * value, which is what makes world generation reproducible.
 */

import { Random } from './Random.js';

/** Perlin's quintic smoothing curve: 6t^5 - 15t^4 + 10t^3. */
function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Linear interpolation. */
function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** 2D gradient dot product for one of 8 evenly spaced unit gradients. */
function grad2(hash, x, y) {
  switch (hash & 7) {
    case 0: return x + y;
    case 1: return x - y;
    case 2: return -x + y;
    case 3: return -x - y;
    case 4: return x;
    case 5: return -x;
    case 6: return y;
    default: return -y;
  }
}

/**
 * 3D gradient dot product using the classic 12-edge gradient set.
 * `hash` is masked to 15 by the caller.
 */
function grad3(hash, x, y, z) {
  switch (hash & 15) {
    case 0: return x + y;
    case 1: return -x + y;
    case 2: return x - y;
    case 3: return -x - y;
    case 4: return x + z;
    case 5: return -x + z;
    case 6: return x - z;
    case 7: return -x - z;
    case 8: return y + z;
    case 9: return -y + z;
    case 10: return y - z;
    case 11: return -y - z;
    case 12: return x + y;
    case 13: return -y + z;
    case 14: return -x + y;
    default: return -y - z;
  }
}

/** Perlin noise generator bound to a seed. */
export class PerlinNoise {
  /** @param {number} seed */
  constructor(seed = 0) {
    const rng = new Random(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // Fisher-Yates shuffle driven by the deterministic stream.
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const tmp = p[i];
      p[i] = p[j];
      p[j] = tmp;
    }
    // Doubled table removes the need for a modulo in the hot path.
    this.perm = new Uint8Array(512);
    this.permMod12 = new Uint8Array(512);
    for (let i = 0; i < 512; i++) {
      this.perm[i] = p[i & 255];
      this.permMod12[i] = this.perm[i] % 12;
    }
  }

  /**
   * 2D Perlin noise.
   * @param {number} x
   * @param {number} y
   * @returns {number} approximately [-1,1]
   */
  noise2(x, y) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const xf = x - xi;
    const yf = y - yi;
    const X = xi & 255;
    const Y = yi & 255;
    const u = fade(xf);
    const v = fade(yf);
    const perm = this.perm;

    const aa = perm[perm[X] + Y];
    const ab = perm[perm[X] + Y + 1];
    const ba = perm[perm[X + 1] + Y];
    const bb = perm[perm[X + 1] + Y + 1];

    const x1 = lerp(grad2(aa, xf, yf), grad2(ba, xf - 1, yf), u);
    const x2 = lerp(grad2(ab, xf, yf - 1), grad2(bb, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }

  /**
   * 3D Perlin noise.
   * @param {number} x
   * @param {number} y
   * @param {number} z
   * @returns {number} approximately [-1,1]
   */
  noise3(x, y, z) {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = x - xi;
    const yf = y - yi;
    const zf = z - zi;
    const X = xi & 255;
    const Y = yi & 255;
    const Z = zi & 255;
    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);
    const perm = this.perm;

    const a = perm[X] + Y;
    const aa = perm[a] + Z;
    const ab = perm[a + 1] + Z;
    const b = perm[X + 1] + Y;
    const ba = perm[b] + Z;
    const bb = perm[b + 1] + Z;

    const x1 = lerp(grad3(perm[aa], xf, yf, zf), grad3(perm[ba], xf - 1, yf, zf), u);
    const x2 = lerp(grad3(perm[ab], xf, yf - 1, zf), grad3(perm[bb], xf - 1, yf - 1, zf), u);
    const y1 = lerp(x1, x2, v);

    const x3 = lerp(grad3(perm[aa + 1], xf, yf, zf - 1), grad3(perm[ba + 1], xf - 1, yf, zf - 1), u);
    const x4 = lerp(grad3(perm[ab + 1], xf, yf - 1, zf - 1), grad3(perm[bb + 1], xf - 1, yf - 1, zf - 1), u);
    const y2 = lerp(x3, x4, v);

    return lerp(y1, y2, w);
  }

  /**
   * Fractal Brownian motion (summed octaves of Perlin noise).
   * @param {number} x
   * @param {number} y
   * @param {number} octaves
   * @param {number} [lacunarity] frequency multiplier per octave
   * @param {number} [gain] amplitude multiplier per octave
   * @returns {number} roughly [-1,1]
   */
  fbm2(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise2(x * freq, y * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /** 3D fractal Brownian motion. */
  fbm3(x, y, z, octaves = 3, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      sum += amp * this.noise3(x * freq, y * freq, z * freq);
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }

  /**
   * Ridged multifractal — produces sharp crests, ideal for mountain ranges.
   * @returns {number} in [0,1]
   */
  ridged2(x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let o = 0; o < octaves; o++) {
      const n = 1 - Math.abs(this.noise2(x * freq, y * freq));
      sum += amp * n * n;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return norm > 0 ? sum / norm : 0;
  }
}

/**
 * A named noise channel with an independent seed, so adding a new channel
 * never changes the output of the existing ones.
 */
export class NoiseChannel {
  /**
   * @param {number} seed base world seed
   * @param {string} name channel name (hashed into the derived seed)
   */
  constructor(seed, name) {
    let nameHash = 0;
    for (let i = 0; i < name.length; i++) {
      nameHash = (Math.imul(nameHash, 31) + name.charCodeAt(i)) | 0;
    }
    this.noise = new PerlinNoise((seed ^ nameHash) | 0);
  }

  /** @see PerlinNoise#noise2 */
  n2(x, y) { return this.noise.noise2(x, y); }
  /** @see PerlinNoise#noise3 */
  n3(x, y, z) { return this.noise.noise3(x, y, z); }
  /** @see PerlinNoise#fbm2 */
  fbm2(x, y, oct = 4, lac = 2, gain = 0.5) { return this.noise.fbm2(x, y, oct, lac, gain); }
  /** @see PerlinNoise#fbm3 */
  fbm3(x, y, z, oct = 3, lac = 2, gain = 0.5) { return this.noise.fbm3(x, y, z, oct, lac, gain); }
  /** @see PerlinNoise#ridged2 */
  ridged2(x, y, oct = 4, lac = 2, gain = 0.5) { return this.noise.ridged2(x, y, oct, lac, gain); }
}

/**
 * Maps a value from one range to another, clamped to [0,1] on the way out.
 * @param {number} v
 * @param {number} inMin
 * @param {number} inMax
 * @returns {number} in [0,1]
 */
export function smoothStep01(v, inMin, inMax) {
  if (inMax === inMin) return v < inMin ? 0 : 1;
  let t = (v - inMin) / (inMax - inMin);
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  return t * t * (3 - 2 * t);
}
