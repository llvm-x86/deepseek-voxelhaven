/**
 * TextureAtlas.js — every block texture in the game, generated in code.
 *
 * No external image files are used. Each 16x16 tile is painted procedurally
 * from a deterministic random stream, then written into a single 256x256
 * texture. Using one atlas means a whole chunk renders with a single draw call.
 *
 * The atlas is also kept as a canvas so the HUD can copy individual tiles out
 * as data URLs for inventory icons, which keeps the block art consistent
 * between the world and the interface.
 */

import { RENDER } from '../core/Config.js';
import { Random } from '../core/Random.js';

const TILE = RENDER.tileSize;      // 16 px
const GRID = RENDER.atlasGrid;     // 16 x 16 tiles
const ATLAS_PX = TILE * GRID;      // 256 px

/**
 * Convert HSL-ish shading into an RGB triple.
 * @returns {[number,number,number]}
 */
function rgb(r, g, b) {
  return [r < 0 ? 0 : r > 255 ? 255 : r | 0,
    g < 0 ? 0 : g > 255 ? 255 : g | 0,
    b < 0 ? 0 : b > 255 ? 255 : b | 0];
}

/** Blend two colours; t=0 gives a, t=1 gives b. */
function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** Scale a colour's brightness. */
function shade(c, k) {
  return [c[0] * k, c[1] * k, c[2] * k];
}

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const PALETTE = {
  grass: [104, 168, 72],
  grassDark: [78, 134, 54],
  grassLight: [134, 194, 92],
  dirt: [122, 88, 60],
  dirtDark: [96, 68, 46],
  dirtLight: [146, 108, 74],
  stone: [136, 136, 138],
  stoneDark: [104, 104, 108],
  stoneLight: [162, 162, 164],
  sand: [222, 208, 152],
  sandDark: [196, 180, 124],
  sandstone: [214, 198, 142],
  gravel: [130, 126, 122],
  snow: [242, 246, 250],
  snowShade: [214, 222, 234],
  bark: [96, 70, 44],
  barkDark: [72, 52, 32],
  barkLight: [118, 88, 56],
  wood: [172, 136, 88],
  woodDark: [138, 106, 66],
  leaf: [66, 128, 52],
  leafDark: [46, 98, 40],
  leafLight: [92, 160, 66],
  water: [58, 110, 200],
  coal: [34, 34, 38],
  bedrock: [58, 58, 62],
  glow: [255, 214, 130],
  cactus: [76, 130, 66],
  cactusDark: [56, 104, 50],
  flowerPink: [226, 120, 168],
  flowerYellow: [240, 214, 96],
  fiber: [176, 200, 110]
};

// ---------------------------------------------------------------------------
// Tile painters
// ---------------------------------------------------------------------------

/**
 * Each painter receives (set, rng) where `set(x, y, colour|null)` writes a
 * pixel. `null` writes full transparency.
 * @type {Record<string, (set:Function, rng:Random)=>void>}
 */
const PAINTERS = {
  /** Fully transparent placeholder for air. */
  air: (set) => {
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) set(x, y, null);
  },

  /** Diagnostic checker used when a tile name is missing. */
  missing: (set) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const on = ((x >> 3) + (y >> 3)) % 2 === 0;
        set(x, y, on ? [255, 0, 220] : [20, 20, 20]);
      }
    }
  },

  turf_top: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.grass, PALETTE.grassDark, n * 0.9);
        if (n > 0.86) c = PALETTE.grassLight;
        set(x, y, rgb(...c));
      }
    }
  },

  turf_side: (set, rng) => {
    // Dirt body with a ragged grass fringe along the top few rows.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        if (y < 3 + (x % 3 === 0 ? 1 : 0)) {
          const c = mix(PALETTE.grass, PALETTE.grassDark, n * 0.8);
          set(x, y, rgb(...c));
        } else if (y === 3 && n > 0.55) {
          set(x, y, rgb(...mix(PALETTE.grassDark, PALETTE.dirt, 0.4)));
        } else {
          const c = mix(PALETTE.dirt, PALETTE.dirtDark, n * 0.85);
          set(x, y, rgb(...(n > 0.9 ? PALETTE.dirtLight : c)));
        }
      }
    }
  },

  loam: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.dirt, PALETTE.dirtDark, n * 0.9);
        if (n > 0.9) c = PALETTE.dirtLight;
        set(x, y, rgb(...c));
      }
    }
  },

  stone: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.stone, PALETTE.stoneDark, n * 0.7);
        if (n > 0.9) c = PALETTE.stoneLight;
        if (n < 0.05) c = shade(PALETTE.stoneDark, 0.85);
        set(x, y, rgb(...c));
      }
    }
  },

  cobble: (set, rng) => {
    // Rounded cobbles on a dark mortar background.
    for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) set(x, y, rgb(...shade(PALETTE.stoneDark, 0.62)));
    const blobs = [
      [3, 3, 4], [10, 3, 4], [3, 10, 4], [10, 10, 4], [7, 7, 3]
    ];
    for (const [cx, cy, r] of blobs) {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          const d = Math.hypot(x, y);
          if (d > r - 0.2 && !(Math.abs(x) <= r && Math.abs(y) <= r && d <= r + 0.1)) continue;
          const px = (cx + x + TILE) % TILE;
          const py = (cy + y + TILE) % TILE;
          if (d > r) continue;
          const lit = 1 - y / (r * 2.6);
          const n = rng.next();
          const base = mix(PALETTE.stone, PALETTE.stoneLight, n * 0.5);
          set(px, py, rgb(...shade(base, 0.75 + lit * 0.45)));
        }
      }
    }
  },

  sand: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        const c = mix(PALETTE.sand, PALETTE.sandDark, n * 0.6);
        set(x, y, rgb(...c));
      }
    }
  },

  sandstone_top: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.sandstone, PALETTE.sandDark, n * 0.45)));
      }
    }
  },

  sandstone_side: (set, rng) => {
    // Horizontal sedimentary banding.
    for (let y = 0; y < TILE; y++) {
      const band = 0.18 + 0.24 * Math.abs(Math.sin(y * 0.9));
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.sandstone, PALETTE.sandDark, band + n * 0.2);
        if (y % 6 === 0) c = shade(c, 0.88);
        set(x, y, rgb(...c));
      }
    }
  },

  gravel: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.gravel, shade(PALETTE.gravel, 0.6), n);
        if (n > 0.88) c = mix(PALETTE.gravel, PALETTE.dirt, 0.6);
        set(x, y, rgb(...c));
      }
    }
  },

  snow: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.snow, PALETTE.snowShade, n * 0.5)));
      }
    }
  },

  timber_side: (set, rng) => {
    // Vertical bark grain.
    for (let x = 0; x < TILE; x++) {
      const grain = (Math.sin(x * 1.7) + Math.sin(x * 0.6 + 1.3)) * 0.25 + 0.5;
      for (let y = 0; y < TILE; y++) {
        const n = rng.next();
        let c = mix(PALETTE.bark, PALETTE.barkDark, grain * 0.7 + n * 0.3);
        if (n > 0.9) c = PALETTE.barkLight;
        set(x, y, rgb(...c));
      }
    }
  },

  timber_top: (set, rng) => {
    // Growth rings.
    const cx = 7.5;
    const cy = 7.5;
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot(x - cx, y - cy);
        const ring = (Math.sin(d * 2.1) + 1) * 0.5;
        const n = rng.next();
        let c = mix(PALETTE.wood, PALETTE.woodDark, ring * 0.75 + n * 0.2);
        if (d > 7.2) c = mix(PALETTE.bark, PALETTE.barkDark, n * 0.5);
        set(x, y, rgb(...c));
      }
    }
  },

  canopy: (set, rng) => {
    // Foliage is fully opaque. Painting these clumps with transparent gaps
    // makes the opaque pass's alpha test punch real holes through every leaf
    // block, which lines up across neighbouring blocks into repeating
    // perforations and lets the sky through the canopy. Depth comes from
    // shading the clump shadows darker instead.
    const clumpShadow = shade(PALETTE.leafDark, 0.72);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        if (n < 0.10) { set(x, y, rgb(...clumpShadow)); continue; }
        let c = mix(PALETTE.leaf, PALETTE.leafDark, rng.next() * 0.9);
        if (rng.next() > 0.82) c = PALETTE.leafLight;
        set(x, y, rgb(...c));
      }
    }
  },

  planks: (set, rng) => {
    // Four horizontal planks separated by dark seams.
    for (let y = 0; y < TILE; y++) {
      const seam = y % 4 === 3;
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        if (seam) { set(x, y, rgb(...shade(PALETTE.woodDark, 0.7))); continue; }
        // Stagger the vertical joints between planks.
        const row = Math.floor(y / 4);
        const joint = (x + row * 5) % 8 === 0;
        let c = mix(PALETTE.wood, PALETTE.woodDark, n * 0.45 + (y % 4 === 0 ? 0.18 : 0));
        if (joint) c = shade(c, 0.78);
        set(x, y, rgb(...c));
      }
    }
  },

  water: (set, rng) => {
    // Translucent with a soft wave pattern; blended in the transparent pass.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const wave = (Math.sin(x * 0.7 + y * 1.1) + Math.sin(x * 0.3 - y * 0.5)) * 0.5 + 0.5;
        const c = mix(PALETTE.water, shade(PALETTE.water, 1.35), wave * 0.6 + rng.next() * 0.2);
        set(x, y, [c[0], c[1], c[2], 190]);
      }
    }
  },

  coal_ore: (set, rng) => {
    // Stone with embedded coal lumps.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.stone, PALETTE.stoneDark, n * 0.7)));
      }
    }
    const lumps = [[3, 4, 2], [10, 3, 1], [6, 10, 2], [12, 11, 1], [2, 12, 1]];
    for (const [cx, cy, r] of lumps) {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          if (Math.hypot(x, y) > r + 0.2) continue;
          const px = cx + x;
          const py = cy + y;
          if (px < 0 || px >= TILE || py < 0 || py >= TILE) continue;
          const n = rng.next();
          set(px, py, rgb(...shade(PALETTE.coal, 0.7 + n * 0.7)));
        }
      }
    }
  },

  bedrock: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        const c = mix(PALETTE.bedrock, [20, 20, 22], n);
        set(x, y, rgb(...c));
      }
    }
  },

  glass: (set, rng) => {
    // Nearly transparent pane with a bright frame and a diagonal glint.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const border = x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1;
        const glint = (x + y) % 11 === 3 && x > 2 && y > 2;
        if (border) set(x, y, [214, 236, 246, 210]);
        else if (glint) set(x, y, [246, 252, 255, 150]);
        else set(x, y, [200, 226, 240, rng.next() > 0.5 ? 34 : 24]);
      }
    }
  },

  lantern: (set, rng) => {
    // Warm glowing core inside a dark metal frame.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const border = x < 2 || y < 2 || x > TILE - 3 || y > TILE - 3;
        const bar = (x === 7 || x === 8) && y > 1 && y < TILE - 2;
        if (border || bar) {
          set(x, y, rgb(...mix([86, 74, 60], [58, 48, 40], rng.next())));
        } else {
          const d = Math.hypot(x - 7.5, y - 7.5);
          const glow = Math.max(0.35, 1 - d / 7);
          set(x, y, rgb(...shade(PALETTE.glow, 0.6 + glow * 0.7)));
        }
      }
    }
  },

  glowcap: (set, rng) => {
    // Small glowing mushroom: cap on top, pale stalk below.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = x - 7.5;
        const dy = y - 4.5;
        const inCap = Math.hypot(dx, dy * 1.25) < 5.2 && y < 8;
        const inStalk = Math.abs(dx) < 1.6 && y >= 8 && y < 14;
        if (inCap) {
          const edge = Math.hypot(dx, dy * 1.25) / 5.2;
          set(x, y, rgb(...mix([214, 236, 255], [120, 168, 236], edge + rng.next() * 0.2)));
        } else if (inStalk) {
          set(x, y, rgb(...mix([226, 232, 216], [186, 196, 176], rng.next())));
        }
      }
    }
  },

  cactus_side: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.cactus, PALETTE.cactusDark, n * 0.7);
        // Vertical ribs and spines.
        if (x % 5 === 2) c = shade(c, 0.82);
        if (x % 5 === 2 && y % 4 === 1) c = [236, 232, 180];
        // Darker edges give the cactus a rounded silhouette.
        if (x === 0 || x === TILE - 1) c = shade(PALETTE.cactusDark, 0.85);
        set(x, y, rgb(...c));
      }
    }
  },

  cactus_top: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot(x - 7.5, y - 7.5);
        const n = rng.next();
        let c = mix(PALETTE.cactus, PALETTE.cactusDark, Math.min(1, d / 8) * 0.8 + n * 0.2);
        set(x, y, rgb(...c));
      }
    }
  },

  bramble: (set, rng) => {
    // A dense leafy clump drawn as a rounded bush silhouette, so it reads
    // correctly when rendered as crossed billboards.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const dx = (x - 7.5) / 6.6;
        const dy = (y - 9.5) / 6.0;
        const d = Math.hypot(dx, dy);
        // Irregular edge: sample noise so the silhouette is not a plain oval.
        const wobble = (Math.sin(x * 1.3) + Math.cos(y * 1.7) + Math.sin((x + y) * 0.7)) * 0.13;
        if (d + wobble > 1.0) { set(x, y, null); continue; }
        const n = rng.next();
        let c = mix(PALETTE.leaf, PALETTE.leafDark, n * 0.85);
        if (n > 0.86) c = PALETTE.leafLight;
        // A few gaps keep it from looking like a solid green blob.
        if (n < 0.06 && d > 0.35) { set(x, y, null); continue; }
        set(x, y, rgb(...c));
      }
    }
    // A couple of darker stems at the base anchor it to the ground.
    for (let y = 12; y < TILE; y++) {
      set(7, y, rgb(...shade(PALETTE.leafDark, 0.8)));
      if (rng.next() > 0.5) set(8, y, rgb(...shade(PALETTE.leafDark, 0.7)));
    }
  },

  bloom: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    // Stem.
    for (let y = 8; y < TILE; y++) set(7, y, rgb(...PALETTE.leafDark));
    // Leaves.
    set(5, 12, rgb(...PALETTE.leaf));
    set(9, 11, rgb(...PALETTE.leaf));
    // Petals.
    const petal = rng.next() > 0.5 ? PALETTE.flowerPink : PALETTE.flowerYellow;
    for (let y = 3; y < 9; y++) {
      for (let x = 4; x < 12; x++) {
        const d = Math.hypot(x - 7.5, y - 6);
        if (d < 3.2) set(x, y, rgb(...mix(petal, [255, 255, 255], d < 1.2 ? 0.85 : d * 0.1)));
      }
    }
  },

  item_coal: (set, rng) => {
    // A lump of coal with a lighter rim so it stays readable on a dark slot.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot((x - 7.5) * 1.02, (y - 8) * 0.98) + rng.next() * 1.4;
        if (d > 6.4) { set(x, y, null); continue; }
        const facet = Math.max(0.3, 1 - d / 7.4) * (0.75 + rng.next() * 0.5);
        const base = d > 5.4 ? [96, 98, 108] : [42, 43, 50];
        set(x, y, rgb(...shade(base, facet * 1.7)));
      }
    }
    // A couple of bright facets sell the glossy, faceted look.
    for (const [cx, cy] of [[5, 5], [9, 7], [7, 10]]) {
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) set(cx + dx, cy + dy, rgb(...[132, 136, 148]));
      }
    }
  },

  mob_woolback: (set, rng) => {
    // Dense woolly fleece.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const curl = (Math.sin(x * 1.9) + Math.cos(y * 2.2)) * 0.5 + 0.5;
        const n = rng.next();
        const base = mix([238, 232, 214], [198, 188, 166], curl * 0.7 + n * 0.3);
        set(x, y, rgb(...base));
      }
    }
  },

  mob_woolback_face: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const curl = (Math.sin(x * 1.9) + Math.cos(y * 2.2)) * 0.5 + 0.5;
        const base = mix([244, 238, 222], [204, 194, 172], curl * 0.6 + rng.next() * 0.3);
        set(x, y, rgb(...base));
      }
    }
    // Two dark, calm eyes and a small muzzle.
    const eye = [46, 40, 36];
    for (const ex of [3, 4, 11, 12]) {
      for (const ey of [5, 6]) set(ex, ey, rgb(...eye));
    }
    for (let x = 6; x <= 9; x++) {
      for (let y = 10; y <= 12; y++) set(x, y, rgb(...mix([196, 168, 158], [160, 132, 124], rng.next())));
    }
  },

  mob_gloomling: (set, rng) => {
    // Mottled shadow hide.
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        const blotch = (Math.sin(x * 0.8) + Math.cos(y * 0.7)) * 0.25 + 0.5;
        const base = mix([44, 34, 58], [22, 16, 32], blotch * 0.7 + n * 0.4);
        set(x, y, rgb(...base));
      }
    }
  },

  mob_gloomling_face: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        const base = mix([40, 30, 54], [18, 12, 28], (Math.sin(x * 0.8) + Math.cos(y * 0.7)) * 0.25 + 0.5 + n * 0.3);
        set(x, y, rgb(...base));
      }
    }
    // Wide glowing eyes.
    for (let x = 2; x <= 5; x++) for (let y = 5; y <= 7; y++) set(x, y, rgb(...mix([255, 168, 74], [255, 226, 150], rng.next())));
    for (let x = 10; x <= 13; x++) for (let y = 5; y <= 7; y++) set(x, y, rgb(...mix([255, 168, 74], [255, 226, 150], rng.next())));
    // A jagged grin.
    for (let x = 5; x <= 10; x++) {
      set(x, 11, rgb(...[214, 122, 70]));
      if (x % 2 === 0) set(x, 12, rgb(...[214, 122, 70]));
    }
  },

  item_fiber: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    for (let i = 0; i < 5; i++) {
      const baseX = 3 + i * 2;
      for (let y = 3; y < 14; y++) {
        const x = baseX + Math.round(Math.sin(y * 0.7 + i) * 1.6);
        set(x, y, rgb(...mix(PALETTE.fiber, PALETTE.leafDark, rng.next() * 0.7)));
      }
    }
  },

  hand: (set, rng) => {
    // Skin for the first-person arm. The top third is a warm cloth sleeve so
    // the arm reads as an arm rather than a bare tube, and a soft crease across
    // the middle suggests a hand gripping whatever is held. The sleeve is kept
    // warm rather than blue-grey because the arm is drawn against the sky,
    // where a cool tone disappears.
    const skin = [214, 166, 130];
    const sleeve = [122, 84, 58];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const base = y < 6 ? sleeve : skin;
        // Fine grain plus a gentle fold running down the forearm.
        const grain = 0.9 + rng.next() * 0.18;
        const fold = Math.abs(x - 5.5) < 1.2 && y >= 6 && y < 12 ? 0.82 : 1;
        const edge = (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1) ? 0.86 : 1;
        set(x, y, rgb(...shade(base, grain * fold * edge)));
      }
    }
    // Knuckle highlights.
    for (const [kx, ky] of [[4, 10], [7, 11], [10, 10], [6, 13], [9, 13]]) {
      set(kx, ky, rgb(...shade(skin, 1.12)));
    }
  }
};

// ---------------------------------------------------------------------------
// Atlas
// ---------------------------------------------------------------------------

export class TextureAtlas {
  constructor() {
    /** @type {Map<string, number>} tile name -> atlas index */
    this.names = new Map();
    /** @type {string[]} index -> tile name */
    this.order = [];
    /** @type {Uint8ClampedArray} RGBA pixel data for the whole atlas */
    this.pixels = new Uint8ClampedArray(ATLAS_PX * ATLAS_PX * 4);
    /** @type {HTMLCanvasElement|null} kept for HUD icon extraction */
    this.canvas = null;
    /** @type {WebGLTexture|null} */
    this.texture = null;
    /** @type {Map<string,string>} tile name -> cached data URL */
    this.iconCache = new Map();
  }

  /** Number of tiles registered. */
  get tileCount() {
    return this.order.length;
  }

  /**
   * Paint every tile into the atlas pixel buffer.
   * Tile order is fixed by `TILE_ORDER` so atlas indices are stable.
   */
  generate() {
    const names = Object.keys(PAINTERS);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (i >= GRID * GRID) {
        console.warn(`[TextureAtlas] more than ${GRID * GRID} tiles; "${name}" was skipped`);
        break;
      }
      this.names.set(name, i);
      this.order.push(name);
      this.paintTile(i, name, PAINTERS[name]);
    }
    this.buildCanvas();
    return this;
  }

  /** Paint one tile into the shared pixel buffer. */
  paintTile(index, name, painter) {
    const col = index % GRID;
    const row = Math.floor(index / GRID);
    const originX = col * TILE;
    const originY = row * TILE;
    // Deterministic per tile so textures never change between runs.
    const rng = new Random(0x9e37 + index * 7919);

    const set = (x, y, colour) => {
      if (x < 0 || x >= TILE || y < 0 || y >= TILE) return;
      const px = ((originY + y) * ATLAS_PX + originX + x) * 4;
      if (colour === null) {
        this.pixels[px] = 0;
        this.pixels[px + 1] = 0;
        this.pixels[px + 2] = 0;
        this.pixels[px + 3] = 0;
      } else {
        this.pixels[px] = colour[0];
        this.pixels[px + 1] = colour[1];
        this.pixels[px + 2] = colour[2];
        this.pixels[px + 3] = colour.length > 3 ? colour[3] : 255;
      }
    };

    try {
      painter(set, rng);
    } catch (err) {
      // A broken painter must not stop the game: fall back to the diagnostic tile.
      console.error(`[TextureAtlas] painter for "${name}" failed:`, err);
      PAINTERS.missing(set, rng);
    }
  }

  /** Copy the pixel buffer into a canvas for icon extraction. */
  buildCanvas() {
    if (typeof document === 'undefined') return;
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_PX;
    canvas.height = ATLAS_PX;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(this.pixels, ATLAS_PX, ATLAS_PX), 0, 0);
    this.canvas = canvas;
  }

  /**
   * Upload the atlas to the GPU.
   * @param {WebGL2RenderingContext} gl
   */
  upload(gl) {
    if (this.texture) gl.deleteTexture(this.texture);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // LINEAR keeps distant blocks from sparkling; the shader clamps sampling to
    // the middle of each tile so neighbouring tiles can never bleed together.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D, 0, gl.RGBA, ATLAS_PX, ATLAS_PX, 0,
      gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(this.pixels.buffer)
    );
    this.texture = texture;
    return texture;
  }

  /** Atlas index for a tile name; falls back to the "missing" tile. */
  indexOf(name) {
    const index = this.names.get(name);
    if (index === undefined) {
      const fallback = this.names.get('missing');
      return fallback === undefined ? 0 : fallback;
    }
    return index;
  }

  /** Atlas cell origin (0..1) of a tile, used by the mesh builder. */
  tileU(name) {
    return (this.indexOf(name) % GRID) / GRID;
  }

  /** Atlas cell origin (0..1) of a tile. */
  tileV(name) {
    return Math.floor(this.indexOf(name) / GRID) / GRID;
  }

  /**
   * A data URL containing just this tile, scaled up for crisp HUD icons.
   * Cached because the inventory redraws often.
   * @param {string} name
   * @param {number} [scale] pixel size multiplier
   * @returns {string}
   */
  iconDataURL(name, scale = 4) {
    const key = `${name}@${scale}`;
    const cached = this.iconCache.get(key);
    if (cached) return cached;
    if (!this.canvas) return '';

    const index = this.indexOf(name);
    const col = index % GRID;
    const row = Math.floor(index / GRID);
    const canvas = document.createElement('canvas');
    canvas.width = TILE * scale;
    canvas.height = TILE * scale;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.canvas, col * TILE, row * TILE, TILE, TILE, 0, 0, TILE * scale, TILE * scale);
    const url = canvas.toDataURL('image/png');
    this.iconCache.set(key, url);
    return url;
  }

  /** Free GPU resources. */
  dispose(gl) {
    if (this.texture && gl) gl.deleteTexture(this.texture);
    this.texture = null;
  }
}
