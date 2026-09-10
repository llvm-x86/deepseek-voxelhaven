/**
 * TerrainGenerator.js — deterministic procedural world generation.
 *
 * Pipeline for one chunk:
 *   1. Climate & elevation noise      -> biome + surface height per column
 *   2. Column filling                 -> stone / subsoil / surface / water
 *   3. Cave carving                   -> 3D noise tunnels + cheese caverns
 *   4. Ore veins                      -> deterministic per-chunk random blobs
 *   5. Vegetation                     -> trees, cacti, plants (cross-chunk safe)
 *
 * Determinism: every random decision comes from `seed`, so the same seed always
 * produces the same world regardless of chunk generation order or thread count.
 *
 * This module is DOM-free and runs inside a Web Worker.
 */

import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/Config.js';
import { PerlinNoise, NoiseChannel, smoothStep01 } from '../core/Noise.js';

/** Clamp a noise sample into [-1,1] after gain has been applied. */
function clampUnit(v) {
  return v < -1 ? -1 : v > 1 ? 1 : v;
}
import { Random, chunkRandom, hash2f, hash3f, hash3i } from '../core/Random.js';
import { BlockId } from './Blocks.js';
import { Chunk } from './Chunk.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const TERRAIN = {
  /** Y level of the ocean surface. */
  seaLevel: 62,
  /** Average ground level of flat plains. */
  baseHeight: 68,
  /** Highest terrain the generator will produce (keeps peaks below the build limit). */
  maxHeight: WORLD_HEIGHT - 10,
  /** Lowest terrain the generator will produce. */
  minHeight: 8,
  /** Vertical amplitude of the continent-scale elevation field. */
  continentAmplitude: 30,
  /** Vertical amplitude of the hill-scale field. */
  hillAmplitude: 9,
  /** Vertical amplitude of the mountain ridge field. */
  mountainAmplitude: 46,
  /** Height above which a column counts as mountainous. */
  mountainLine: 88,
  /** Height above which peaks turn to bare stone. */
  rockLine: 98,
  /** Height above which peaks get a snow cap. */
  snowLine: 104,
  /**
   * Fractal noise is the sum of several octaves normalised by their total
   * amplitude, so its practical range is about +/-0.55 with a standard
   * deviation near 0.17 — not the +/-1 the raw maths suggests. Each field is
   * therefore scaled up and clamped before it is used, which is what gives the
   * terrain its full range of oceans, plains and mountains.
   */
  continentGain: 1.9,
  hillGain: 1.8,
  mountainMaskGain: 1.8,
  climateGain: 1.7,
  /** Thickness of the subsoil layer below the surface block. */
  subsoilDepth: 4,
  /** Number of coal veins attempted per chunk. */
  coalVeinsPerChunk: 7,
  /** Coal vein vertical range. */
  coalMinY: 5,
  coalMaxY: 58,
  /** Cave carving is suppressed within this many blocks of the surface. */
  caveSurfaceMargin: 3,
  /** Caves are only carved inside this vertical band (tunnels). */
  tunnelMinY: 4,
  tunnelMaxY: 66,
  /** Cheese caverns are only carved inside this vertical band. */
  cheeseMinY: 8,
  cheeseMaxY: 42,
  /** Below this Y everything is unbreakable bedrock. */
  bedrockDepth: 2,
  /** Distance outside the chunk that tree canopies may reach into it. */
  treeMargin: 3
};

/** Biome identifiers. Stored in saves implicitly (derived from the seed). */
export const Biome = Object.freeze({
  OCEAN: 0,
  BEACH: 1,
  PLAINS: 2,
  FOREST: 3,
  DESERT: 4,
  SNOWY: 5,
  MOUNTAIN: 6,
  PEAK: 7
});

/** Human readable biome names for the debug overlay. */
export const BIOME_NAMES = ['Ocean', 'Beach', 'Plains', 'Forest', 'Desert', 'Snowy Hills', 'Mountains', 'Peaks'];

/** Independent noise channel names; each is hashed with the world seed. */
const CHANNELS = {
  continent: 'continent-v1',
  hills: 'hills-v2',
  mountainMask: 'mountainmask-v1',
  ridge: 'ridge-v1',
  temperature: 'temperature-v1',
  humidity: 'humidity-v1',
  caveA: 'cave-a-v2',
  caveB: 'cave-b-v2',
  cheese: 'cheese-v1',
  soil: 'soil-v1',
  warp: 'warp-v1'
};

/** Seeds for the per-chunk random streams. */
const SALT = {
  ore: 0x0f1e2d3c,
  trees: 0x51a2b3c4,
  plants: 0x7d8e9fa0,
  glowcap: 0x11223344,
  surface: 0x55667788
};

// ---------------------------------------------------------------------------
// Coarse scalar field
// ---------------------------------------------------------------------------

/**
 * A 3D noise field sampled on a coarse lattice and read back with trilinear
 * interpolation.
 *
 * Cave carving needs a noise value for every underground voxel, which is by far
 * the most expensive part of generation. Sampling the noise every COARSE_STEP
 * blocks instead of every block cuts the number of noise evaluations by
 * `step^3` (64x at step 4) while changing the result only slightly, because the
 * cave noise wavelengths (40-80 blocks) are an order of magnitude larger than
 * the step. The interpolation is C0 continuous, so tunnels stay connected.
 */
class CoarseField {
  /**
   * @param {number} step lattice spacing in blocks
   * @param {number} sizeX lattice points along X (inclusive of both edges)
   * @param {number} sizeY lattice points along Y
   * @param {number} sizeZ lattice points along Z
   */
  constructor(step, sizeX, sizeY, sizeZ) {
    this.step = step;
    this.sizeX = sizeX;
    this.sizeY = sizeY;
    this.sizeZ = sizeZ;
    this.data = new Float32Array(sizeX * sizeY * sizeZ);
  }

  /** Lattice index -> flat array index. */
  index(ix, iy, iz) {
    return (iy * this.sizeZ + iz) * this.sizeX + ix;
  }

  /**
   * Fill the lattice by evaluating `fn` at every lattice point.
   * @param {(x:number,y:number,z:number)=>number} fn
   * @param {number} originX world X of lattice point 0
   * @param {number} originY world Y of lattice point 0
   * @param {number} originZ world Z of lattice point 0
   */
  fill(fn, originX, originY, originZ) {
    const { step, sizeX, sizeY, sizeZ, data } = this;
    let i = 0;
    for (let iy = 0; iy < sizeY; iy++) {
      const wy = originY + iy * step;
      for (let iz = 0; iz < sizeZ; iz++) {
        const wz = originZ + iz * step;
        for (let ix = 0; ix < sizeX; ix++) {
          data[i++] = fn(originX + ix * step, wy, wz);
        }
      }
    }
  }

  /**
   * Trilinearly interpolated value at a local voxel coordinate.
   * Coordinates outside the lattice are clamped to its edge.
   */
  sample(x, y, z) {
    const { step, sizeX, sizeY, sizeZ, data } = this;
    const inv = 1 / step;

    let fx = x * inv, fy = y * inv, fz = z * inv;
    let ix = Math.floor(fx), iy = Math.floor(fy), iz = Math.floor(fz);
    if (ix < 0) { ix = 0; fx = 0; } else if (ix >= sizeX - 1) { ix = sizeX - 2; fx = ix; }
    if (iy < 0) { iy = 0; fy = 0; } else if (iy >= sizeY - 1) { iy = sizeY - 2; fy = iy; }
    if (iz < 0) { iz = 0; fz = 0; } else if (iz >= sizeZ - 1) { iz = sizeZ - 2; fz = iz; }

    const tx = fx - ix, ty = fy - iy, tz = fz - iz;

    const sx = sizeX, sz = sizeZ;
    const i000 = (iy * sz + iz) * sx + ix;
    const i100 = i000 + 1;
    const i010 = i000 + sx * sz;
    const i110 = i010 + 1;
    const i001 = i000 + sx;
    const i101 = i001 + 1;
    const i011 = i010 + sx;
    const i111 = i011 + 1;

    const c00 = data[i000] + (data[i100] - data[i000]) * tx;
    const c10 = data[i010] + (data[i110] - data[i010]) * tx;
    const c01 = data[i001] + (data[i101] - data[i001]) * tx;
    const c11 = data[i011] + (data[i111] - data[i011]) * tx;

    const c0 = c00 + (c10 - c00) * ty;
    const c1 = c01 + (c11 - c01) * ty;
    return c0 + (c1 - c0) * tz;
  }
}

/** Lattice spacing used for the cave noise fields. */
const CAVE_LATTICE_STEP = 4;

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

export class TerrainGenerator {
  /** @param {number} seed 32-bit world seed */
  constructor(seed) {
    this.seed = seed | 0;
    /** @type {Record<string, NoiseChannel>} */
    this.channels = {};
    for (const [key, name] of Object.entries(CHANNELS)) {
      this.channels[key] = new NoiseChannel(this.seed, name);
    }
    // A plain Perlin instance for domain warping (cheaper than a channel).
    this.warpNoise = new PerlinNoise((this.seed ^ 0x2f6e3a11) | 0);
    /** Small cache so repeated column queries within one edit cost nothing. */
    this._columnCache = new Map();
    this._columnCacheLimit = 4096;

    // Reusable coarse lattices for the cave fields. Allocated once and refilled
    // per chunk: (16/4 + 1) = 5 points across, (68/4 + 2) = 19 down.
    const latticeXZ = CHUNK_SIZE / CAVE_LATTICE_STEP + 1;
    const latticeY = Math.floor(TERRAIN.tunnelMaxY / CAVE_LATTICE_STEP) + 3;
    this._caveA = new CoarseField(CAVE_LATTICE_STEP, latticeXZ, latticeY, latticeXZ);
    this._caveB = new CoarseField(CAVE_LATTICE_STEP, latticeXZ, latticeY, latticeXZ);
    this._cheese = new CoarseField(CAVE_LATTICE_STEP, latticeXZ, latticeY, latticeXZ);
  }

  // -------------------------------------------------------------------------
  // Column sampling (pure functions of world coordinates)
  // -------------------------------------------------------------------------

  /**
   * Surface height (Y of the topmost solid terrain block) at a world column.
   * Water is not considered; compare against TERRAIN.seaLevel for oceans.
   * @param {number} wx
   * @param {number} wz
   * @returns {number}
   */
  surfaceHeight(wx, wz) {
    const c = this.channels;
    const x = wx;
    const z = wz;

    // Continent-scale elevation shapes oceans and highlands.
    const continent = c.continent.fbm2(x * 0.0011, z * 0.0011, 4, 2.0, 0.5);
    // Mid-scale rolling hills.
    const hills = c.hills.fbm2(x * 0.0072, z * 0.0072, 4, 2.0, 0.5);
    // Low frequency mask deciding where mountain ranges exist at all.
    const maskRaw = clampUnit(c.mountainMask.fbm2(x * 0.0016, z * 0.0016, 3, 2.0, 0.5) * TERRAIN.mountainMaskGain);
    const mountainMask = smoothStep01(maskRaw, 0.12, 0.92);
    // Sharp crests for the ranges themselves.
    const ridge = c.ridge.ridged2(x * 0.0043, z * 0.0043, 4, 2.0, 0.5);

    let h = TERRAIN.baseHeight;
    h += clampUnit(continent * TERRAIN.continentGain) * TERRAIN.continentAmplitude;
    // Hills flatten out where mountains take over, so ranges stand clear.
    h += clampUnit(hills * TERRAIN.hillGain) * TERRAIN.hillAmplitude * (1 - 0.6 * mountainMask);
    // pow() sharpens the ridge profile so ranges have narrow crests and wide
    // foothills instead of uniform bumps.
    h += mountainMask * Math.pow(ridge, 2.2) * TERRAIN.mountainAmplitude;

    // Gentle terraces keep large flat building areas near sea level.
    if (h > TERRAIN.seaLevel - 2 && h < TERRAIN.seaLevel + 6) {
      h = TERRAIN.seaLevel + 3 + (h - (TERRAIN.seaLevel + 3)) * 0.55;
    }

    return Math.max(TERRAIN.minHeight, Math.min(TERRAIN.maxHeight, Math.round(h)));
  }

  /**
   * Climate at a world column.
   * @returns {{temperature:number, humidity:number}} both roughly [-1,1]
   */
  climate(wx, wz) {
    return {
      temperature: clampUnit(this.channels.temperature.fbm2(wx * 0.0009, wz * 0.0009, 3, 2.0, 0.5) * TERRAIN.climateGain),
      humidity: clampUnit(this.channels.humidity.fbm2(wx * 0.0013, wz * 0.0013, 3, 2.0, 0.5) * TERRAIN.climateGain)
    };
  }

  /**
   * Biome at a world column. Depends only on the seed and the coordinates.
   * @param {number} wx
   * @param {number} wz
   * @param {number} [height] pre-computed surface height (avoids recomputation)
   * @returns {number} a Biome value
   */
  biomeAt(wx, wz, height = this.surfaceHeight(wx, wz)) {
    const { temperature, humidity } = this.climate(wx, wz);

    if (height >= TERRAIN.snowLine) return Biome.PEAK;
    if (height >= TERRAIN.rockLine) return Biome.MOUNTAIN;
    if (height >= TERRAIN.mountainLine) {
      // Cold high ground keeps its snow; warm high ground is bare rock.
      return temperature < 0.25 ? Biome.SNOWY : Biome.MOUNTAIN;
    }
    if (height < TERRAIN.seaLevel - 1) return Biome.OCEAN;
    if (height <= TERRAIN.seaLevel + 1) return Biome.BEACH;
    if (temperature < -0.42) return Biome.SNOWY;
    if (temperature > 0.25 && humidity < -0.35) return Biome.DESERT;
    if (humidity > 0.05) return Biome.FOREST;
    return Biome.PLAINS;
  }

  /** Thickness of the soil layer (blocks below the surface block). */
  soilDepth(wx, wz) {
    const n = this.channels.soil.n2(wx * 0.09, wz * 0.09);
    return TERRAIN.subsoilDepth + Math.round(n * 1.6);
  }

  /**
   * Complete column description used to fill voxels.
   * @returns {{height:number, biome:number, surface:number, subsoil:number, filler:number}}
   */
  columnInfo(wx, wz) {
    const key = `${wx},${wz}`;
    const cached = this._columnCache.get(key);
    if (cached) return cached;

    const height = this.surfaceHeight(wx, wz);
    const biome = this.biomeAt(wx, wz, height);
    const depth = this.soilDepth(wx, wz);

    let surface = BlockId.TURF;
    let subsoil = BlockId.LOAM;
    let filler = BlockId.STONE;

    switch (biome) {
      case Biome.OCEAN:
        surface = height < TERRAIN.seaLevel - 7 ? BlockId.GRAVEL : BlockId.SAND;
        subsoil = BlockId.SAND;
        break;
      case Biome.BEACH:
        surface = BlockId.SAND;
        subsoil = BlockId.SAND;
        filler = BlockId.SANDSTONE;
        break;
      case Biome.DESERT:
        surface = BlockId.SAND;
        subsoil = BlockId.SAND;
        filler = BlockId.SANDSTONE;
        break;
      case Biome.SNOWY:
        surface = BlockId.SNOW;
        subsoil = BlockId.LOAM;
        break;
      case Biome.MOUNTAIN:
        surface = height > TERRAIN.mountainLine + 6 ? BlockId.STONE : BlockId.TURF;
        subsoil = height > TERRAIN.mountainLine + 6 ? BlockId.STONE : BlockId.LOAM;
        break;
      case Biome.PEAK:
        surface = BlockId.SNOW;
        subsoil = BlockId.STONE;
        break;
      default:
        surface = BlockId.TURF;
        subsoil = BlockId.LOAM;
        break;
    }

    const info = { height, biome, surface, subsoil, filler, soil: depth };
    if (this._columnCache.size > this._columnCacheLimit) this._columnCache.clear();
    this._columnCache.set(key, info);
    return info;
  }

  /** Clears the column cache (call when the world is disposed). */
  dispose() {
    this._columnCache.clear();
  }

  // -------------------------------------------------------------------------
  // Chunk generation
  // -------------------------------------------------------------------------

  /**
   * Generate a fully populated chunk (terrain + caves + ores + vegetation).
   * @param {number} cx
   * @param {number} cz
   * @returns {Chunk}
   */
  generateChunk(cx, cz) {
    const chunk = new Chunk(cx, cz);
    try {
      this.fillTerrain(chunk);
      this.carveCaves(chunk);
      this.placeOreVeins(chunk);
      this.decorate(chunk);
      chunk.recomputeHeightMaps();
      chunk.state = 2; // ChunkState.GENERATED
    } catch (err) {
      // A generation failure must never take down the game: record it and
      // leave whatever was produced so far as a solid fallback.
      chunk.error = err && err.message ? err.message : String(err);
      console.error(`[TerrainGenerator] chunk ${cx},${cz} failed:`, err);
      chunk.blocks.fill(BlockId.STONE);
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          chunk.blocks[(70 * CHUNK_SIZE + z) * CHUNK_SIZE + x] = BlockId.TURF;
        }
      }
      chunk.recomputeHeightMaps();
      chunk.state = 2;
    }
    return chunk;
  }

  /** Step 2: fill every column with bedrock, stone, subsoil, surface and water. */
  fillTerrain(chunk) {
    const blocks = chunk.blocks;
    const ox = chunk.originX;
    const oz = chunk.originZ;
    const sea = TERRAIN.seaLevel;

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const wx = ox + x;
        const wz = oz + z;
        const info = this.columnInfo(wx, wz);
        const h = info.height;
        const soilBottom = h - info.soil;

        for (let y = 0; y <= h; y++) {
          let id;
          if (y <= TERRAIN.bedrockDepth) {
            // Jagged bedrock floor: always solid at y=0, patchy above.
            id = (y === 0 || hash3f(wx, y, wz, this.seed ^ 0x1234) < 0.72 - y * 0.2)
              ? BlockId.BEDROCK
              : BlockId.STONE;
          } else if (y === h) {
            id = info.surface;
          } else if (y > soilBottom) {
            id = info.subsoil;
          } else if (y > soilBottom - 3 && info.filler === BlockId.SANDSTONE) {
            id = BlockId.SANDSTONE;
          } else {
            id = BlockId.STONE;
          }
          blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x] = id;
        }

        // Ocean / lake filling.
        if (h < sea) {
          for (let y = h + 1; y <= sea; y++) {
            blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x] = BlockId.WATER;
          }
        }
      }
    }
  }

  /**
   * Step 3: carve caves.
   *
   * Two independent 3D noise fields are combined:
   *  - "tunnels" appear where BOTH fields are near zero, which produces the
   *    long winding tubes characteristic of classic voxel caves.
   *  - "cheese" caverns appear where a low-frequency field exceeds a threshold.
   * Carving is suppressed near the surface so the landscape stays intact.
   */
  carveCaves(chunk) {
    const blocks = chunk.blocks;
    const ox = chunk.originX;
    const oz = chunk.originZ;
    const caveA = this.channels.caveA;
    const caveB = this.channels.caveB;
    const cheese = this.channels.cheese;

    // Fill the coarse lattices once per chunk (a few thousand noise calls
    // instead of ~60,000), then interpolate per voxel.
    const fieldA = this._caveA;
    const fieldB = this._caveB;
    const fieldC = this._cheese;
    fieldA.fill((x, y, z) => caveA.n3(x * 0.0208, y * 0.0345, z * 0.0208), ox, 0, oz);
    fieldB.fill((x, y, z) => caveB.n3(x * 0.0208, y * 0.0345, z * 0.0208), ox, 0, oz);
    fieldC.fill((x, y, z) => cheese.n3(x * 0.0122, y * 0.0245, z * 0.0122), ox, 0, oz);

    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        const surface = this.columnInfo(ox + x, oz + z).height;
        const maxY = Math.min(TERRAIN.tunnelMaxY, surface - TERRAIN.caveSurfaceMargin);
        if (maxY <= TERRAIN.tunnelMinY) continue;

        for (let y = TERRAIN.tunnelMinY; y <= maxY; y++) {
          const index = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
          const id = blocks[index];
          if (id === BlockId.AIR || id === BlockId.WATER || id === BlockId.BEDROCK) continue;

          // --- winding tunnels -------------------------------------------------
          const a = fieldA.sample(x, y, z);
          const b = fieldB.sample(x, y, z);
          // Thresholds shrink with depth so tunnels taper out near bedrock.
          const depthTaper = smoothStep01(y, TERRAIN.tunnelMinY, TERRAIN.tunnelMinY + 8);
          const threshold = 0.058 * depthTaper;
          if (Math.abs(a) < threshold && Math.abs(b) < threshold) {
            blocks[index] = BlockId.AIR;
            continue;
          }

          // --- large cheese caverns -------------------------------------------
          if (y >= TERRAIN.cheeseMinY && y <= TERRAIN.cheeseMaxY) {
            const c = fieldC.sample(x, y, z);
            // Fade caverns out near the surface so the landscape stays intact.
            const surfaceGuard = smoothStep01(surface - TERRAIN.caveSurfaceMargin - y, 0, 7);
            if (c > 0.30 && surfaceGuard > 0) {
              blocks[index] = BlockId.AIR;
            }
          }
        }
      }
    }
  }

  /**
   * Step 4: scatter coal veins. Each vein is a short random walk of blocks,
   * generated from a per-chunk deterministic stream so it never straddles
   * chunk borders inconsistently (veins are clipped at the border, which is
   * visually indistinguishable from a vein ending there).
   */
  placeOreVeins(chunk) {
    const rng = chunkRandom(this.seed, chunk.cx, chunk.cz, SALT.ore);
    const blocks = chunk.blocks;

    for (let vein = 0; vein < TERRAIN.coalVeinsPerChunk; vein++) {
      let x = rng.int(0, CHUNK_SIZE - 1);
      let z = rng.int(0, CHUNK_SIZE - 1);
      let y = rng.int(TERRAIN.coalMinY, TERRAIN.coalMaxY);
      const size = rng.int(4, 10);

      for (let step = 0; step < size; step++) {
        if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y > TERRAIN.bedrockDepth && y < WORLD_HEIGHT) {
          const index = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
          if (blocks[index] === BlockId.STONE) blocks[index] = BlockId.COAL_ORE;
        }
        // Random walk biased to spread out rather than clump.
        const axis = rng.int(0, 2);
        if (axis === 0) x += rng.sign();
        else if (axis === 1) z += rng.sign();
        else y += rng.sign();
      }
    }

    // A few glowcaps growing on cave floors give the underground some light.
    const glowRng = chunkRandom(this.seed, chunk.cx, chunk.cz, SALT.glowcap);
    for (let i = 0; i < 10; i++) {
      const x = glowRng.int(0, CHUNK_SIZE - 1);
      const z = glowRng.int(0, CHUNK_SIZE - 1);
      const y = glowRng.int(TERRAIN.tunnelMinY + 2, TERRAIN.cheeseMaxY);
      const index = (y * CHUNK_SIZE + z) * CHUNK_SIZE + x;
      const below = (y - 1) * CHUNK_SIZE * CHUNK_SIZE + z * CHUNK_SIZE + x;
      if (blocks[index] === BlockId.AIR && blocks[below] === BlockId.STONE) {
        blocks[index] = BlockId.GLOWCAP;
      }
    }
  }

  /**
   * Step 5: surface vegetation.
   *
   * Rather than iterating over trees stored somewhere, tree positions are a
   * pure function of world coordinates: each "cell" of a biome-dependent size
   * contains at most one candidate tree at a hashed offset. Any chunk can
   * therefore decide independently whether a tree overlaps it, which makes
   * trees seamless across chunk borders and independent of generation order.
   */
  decorate(chunk) {
    const ox = chunk.originX;
    const oz = chunk.originZ;
    const margin = TERRAIN.treeMargin;
    const rng = chunkRandom(this.seed, chunk.cx, chunk.cz, SALT.plants);

    for (let z = -margin; z < CHUNK_SIZE + margin; z++) {
      for (let x = -margin; x < CHUNK_SIZE + margin; x++) {
        const wx = ox + x;
        const wz = oz + z;
        const tree = this.treeAt(wx, wz);
        if (tree) this.writeTree(chunk, tree);
      }
    }

    // Ground cover: bramble, blooms and desert cacti.
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        if (!rng.chance(0.075)) continue;
        const wx = ox + x;
        const wz = oz + z;
        const info = this.columnInfo(wx, wz);
        if (info.height <= TERRAIN.seaLevel) continue;
        const surfaceIndex = (info.height * CHUNK_SIZE + z) * CHUNK_SIZE + x;
        const aboveIndex = ((info.height + 1) * CHUNK_SIZE + z) * CHUNK_SIZE + x;
        if (chunk.blocks[surfaceIndex] === BlockId.AIR) continue;
        if (chunk.blocks[aboveIndex] !== BlockId.AIR) continue;

        if (info.biome === Biome.DESERT) {
          if (rng.chance(0.35)) {
            const tall = rng.int(1, 3);
            for (let i = 1; i <= tall && info.height + i < WORLD_HEIGHT; i++) {
              chunk.blocks[((info.height + i) * CHUNK_SIZE + z) * CHUNK_SIZE + x] = BlockId.CACTUS;
            }
          }
        } else if (info.biome === Biome.PLAINS || info.biome === Biome.FOREST) {
          chunk.blocks[aboveIndex] = rng.chance(0.72) ? BlockId.BRAMBLE : BlockId.BLOOM;
        } else if (info.biome === Biome.SNOWY && rng.chance(0.2)) {
          chunk.blocks[aboveIndex] = BlockId.BRAMBLE;
        }
      }
    }
  }

  /**
   * Decide whether a tree/cactus grows with its base at this world column.
   * @param {number} wx
   * @param {number} wz
   * @returns {{x:number,z:number,y:number,height:number,kind:string}|null}
   */
  treeAt(wx, wz) {
    const height = this.surfaceHeight(wx, wz);
    if (height <= TERRAIN.seaLevel) return null;
    const biome = this.biomeAt(wx, wz, height);

    /** cell size controls how sparse the vegetation is per biome */
    let cell = 0;
    let kind = 'broadleaf';
    let chance = 0;
    switch (biome) {
      case Biome.FOREST: cell = 5; chance = 0.62; kind = 'broadleaf'; break;
      case Biome.PLAINS: cell = 13; chance = 0.35; kind = 'broadleaf'; break;
      case Biome.SNOWY: cell = 9; chance = 0.42; kind = 'needle'; break;
      case Biome.MOUNTAIN: cell = 24; chance = 0.18; kind = 'needle'; break;
      case Biome.DESERT: cell = 15; chance = 0.22; kind = 'cactus'; break;
      default: return null; // ocean, beach and peaks have no trees
    }
    if (cell <= 0) return null;

    // One candidate per cell, placed at a hashed offset inside the cell.
    const cellX = Math.floor(wx / cell);
    const cellZ = Math.floor(wz / cell);
    const h1 = hash3i(cellX, 0x51ed, cellZ, this.seed ^ SALT.trees);
    const h2 = hash3i(cellX, 0x9a37, cellZ, this.seed ^ SALT.trees);
    const offsetX = h1 % cell;
    const offsetZ = h2 % cell;
    const candidateX = cellX * cell + offsetX;
    const candidateZ = cellZ * cell + offsetZ;
    if (candidateX !== wx || candidateZ !== wz) return null;

    const roll = hash3f(cellX, 0x1234, cellZ, this.seed ^ SALT.trees);
    if (roll > chance) return null;

    const heightRoll = hash3f(cellX, 0x7788, cellZ, this.seed ^ SALT.trees);
    let trunkHeight;
    if (kind === 'cactus') trunkHeight = 1 + Math.floor(heightRoll * 3);
    else if (kind === 'needle') trunkHeight = 6 + Math.floor(heightRoll * 4);
    else trunkHeight = 4 + Math.floor(heightRoll * 3);

    // Need a reasonable amount of headroom above the surface.
    if (height + trunkHeight + 4 >= WORLD_HEIGHT) return null;

    return { x: wx, z: wz, y: height, height: trunkHeight, kind };
  }

  /**
   * Stamp a tree into a chunk, clipping anything outside its bounds.
   * Blocks are only placed into air so trees never overwrite terrain.
   */
  writeTree(chunk, tree) {
    const { x: tx, z: tz, y: baseY, height, kind } = tree;
    const ox = chunk.originX;
    const oz = chunk.originZ;

    /** Place a block if it lands inside this chunk and is currently air. */
    const put = (wx, wy, wz, id, overwrite = false) => {
      const lx = wx - ox;
      const lz = wz - oz;
      if (lx < 0 || lx >= CHUNK_SIZE || lz < 0 || lz >= CHUNK_SIZE) return;
      if (wy < 0 || wy >= WORLD_HEIGHT) return;
      const index = (wy * CHUNK_SIZE + lz) * CHUNK_SIZE + lx;
      const current = chunk.blocks[index];
      if (!overwrite && current !== BlockId.AIR && current !== BlockId.WATER) return;
      chunk.blocks[index] = id;
    };

    if (kind === 'cactus') {
      for (let i = 1; i <= height; i++) put(tx, baseY + i, tz, BlockId.CACTUS, true);
      return;
    }

    // Trunk.
    for (let i = 1; i <= height; i++) put(tx, baseY + i, tz, BlockId.TIMBER, true);

    const topY = baseY + height;
    if (kind === 'needle') {
      // Conical pine: three shrinking rings around the upper trunk.
      const layers = [
        { radius: 2, offset: -1, pattern: 'ring' },
        { radius: 1, offset: 1, pattern: 'ring' },
        { radius: 0, offset: 3, pattern: 'cross' }
      ];
      for (const layer of layers) {
        const y = topY + layer.offset;
        if (layer.pattern === 'ring') {
          for (let dz = -layer.radius; dz <= layer.radius; dz++) {
            for (let dx = -layer.radius; dx <= layer.radius; dx++) {
              // Trim the corners for a rounder silhouette.
              if (Math.abs(dx) === layer.radius && Math.abs(dz) === layer.radius) continue;
              put(tx + dx, y, tz + dz, BlockId.CANOPY);
            }
          }
        } else {
          put(tx, y, tz, BlockId.CANOPY);
          put(tx + 1, y, tz, BlockId.CANOPY);
          put(tx - 1, y, tz, BlockId.CANOPY);
          put(tx, y, tz + 1, BlockId.CANOPY);
          put(tx, y, tz - 1, BlockId.CANOPY);
          put(tx, y + 1, tz, BlockId.CANOPY);
        }
      }
      return;
    }

    // Broadleaf: two wide layers plus a small crown, corners trimmed.
    for (let dy = -2; dy <= 1; dy++) {
      const y = topY + dy;
      const radius = dy >= 1 ? 1 : 2;
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const isCorner = Math.abs(dx) === radius && Math.abs(dz) === radius;
          if (isCorner && (radius === 1 || dy === -2 || dy === 1)) continue;
          put(tx + dx, y, tz + dz, BlockId.CANOPY);
        }
      }
    }
    // A couple of random extra leaf blocks soften the silhouette.
    const rng = new Random(hash3i(tx, 0xabc, tz, this.seed));
    for (let i = 0; i < 3; i++) {
      put(tx + rng.int(-2, 2), topY + rng.int(-1, 2), tz + rng.int(-2, 2), BlockId.CANOPY);
    }
  }

  // -------------------------------------------------------------------------
  // Spawn helpers
  // -------------------------------------------------------------------------

  /**
   * Find a safe spawn position near the requested world column.
   * Searches outwards in a spiral for a column that is above sea level and not
   * covered by water or trees, so the player never starts inside geometry.
   * @param {number} centerX
   * @param {number} centerZ
   * @returns {{x:number, y:number, z:number, biome:number}}
   */
  findSpawn(centerX = 8, centerZ = 8) {
    for (let radius = 0; radius < 96; radius += 3) {
      const samples = radius === 0 ? 1 : 12;
      for (let s = 0; s < samples; s++) {
        const angle = (s / samples) * Math.PI * 2;
        const wx = Math.round(centerX + Math.cos(angle) * radius);
        const wz = Math.round(centerZ + Math.sin(angle) * radius);
        const info = this.columnInfo(wx, wz);
        if (info.height <= TERRAIN.seaLevel + 1) continue;
        if (info.surface === BlockId.SAND && info.height <= TERRAIN.seaLevel + 2) continue;
        // Reject spots occupied by a tree trunk or cactus.
        if (this.treeAt(wx, wz)) continue;
        if (this.treeAt(wx + 1, wz) || this.treeAt(wx - 1, wz)) continue;
        if (this.treeAt(wx, wz + 1) || this.treeAt(wx, wz - 1)) continue;
        return { x: wx + 0.5, y: info.height + 1.2, z: wz + 0.5, biome: info.biome };
      }
    }
    // Fallback: the requested column, raised well above the terrain.
    const info = this.columnInfo(centerX, centerZ);
    return { x: centerX + 0.5, y: Math.max(info.height + 4, TERRAIN.seaLevel + 4), z: centerZ + 0.5, biome: info.biome };
  }
}
