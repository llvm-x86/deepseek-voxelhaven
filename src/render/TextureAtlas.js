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
  fiber: [176, 200, 110],
  iron: [214, 214, 218],
  ironDark: [156, 158, 166],
  ironLight: [242, 242, 246],
  ironOre: [206, 168, 138],
  coalBlock: [38, 38, 44],
  torchFlame: [255, 196, 96],
  brick: [148, 148, 150]
};

/**
 * Tool materials: base, dark and light shading for the head of each tier.
 * Wooden heads reuse the plank palette, stone the cobble palette and iron the
 * metal palette, so tools read as being made of the thing they were crafted
 * from.
 */
const TOOL_MATERIALS = {
  1: { base: [172, 136, 88], dark: [124, 96, 60], light: [202, 166, 112] },
  2: { base: [136, 136, 138], dark: [96, 96, 100], light: [178, 178, 180] },
  3: { base: [214, 214, 218], dark: [150, 152, 160], light: [246, 246, 250] }
};

/**
 * Draw a tool icon: a wooden haft running bottom-left to top-right with a
 * head shape for the tool family. Parameterised rather than hand-painted
 * twelve times so every tier stays visually consistent.
 *
 * @param {(x:number,y:number,c:number[]|null)=>void} set
 * @param {import('../core/Random.js').Random} rng
 * @param {'pickaxe'|'axe'|'shovel'|'sword'} type
 * @param {number} tier
 */
function paintTool(set, rng, type, tier) {
  const material = TOOL_MATERIALS[tier] || TOOL_MATERIALS[1];
  for (let y = 0; y < TILE; y++) for (let x = 0; x < TILE; x++) set(x, y, null);

  const shadePixel = (x, y, base) => {
    const n = rng.next();
    set(x, y, rgb(...mix(base, [0, 0, 0], n * 0.28)));
  };

  // Haft: a two-pixel-wide diagonal from the bottom-left grip to the head.
  const haftFrom = type === 'sword' ? [5, 12] : [3, 13];
  const haftTo = type === 'sword' ? [8, 9] : [10, 6];
  const steps = Math.max(Math.abs(haftTo[0] - haftFrom[0]), Math.abs(haftTo[1] - haftFrom[1]));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = Math.round(haftFrom[0] + (haftTo[0] - haftFrom[0]) * t);
    const y = Math.round(haftFrom[1] + (haftTo[1] - haftFrom[1]) * t);
    shadePixel(x, y, PALETTE.bark);
    shadePixel(x + 1, y, PALETTE.barkDark);
  }

  if (type === 'pickaxe') {
    // A shallow arc: the head sweeps from the upper left across to the right.
    for (let x = 6; x <= 13; x++) {
      const drop = Math.round(Math.abs(x - 9.5) * 0.45);
      const y = 4 + drop;
      shadePixel(x, y, material.base);
      shadePixel(x, y + 1, material.dark);
      if (x >= 8 && x <= 11) shadePixel(x, y - 1, material.light);
    }
  } else if (type === 'axe') {
    // A blade on the left of the haft with a bright cutting edge.
    for (let y = 2; y <= 8; y++) {
      const width = y <= 5 ? 5 : 4;
      for (let x = 6; x <= 6 + width; x++) {
        shadePixel(x, y, x === 6 ? material.light : material.base);
      }
    }
    for (let y = 3; y <= 7; y++) set(6, y, rgb(...material.light));
  } else if (type === 'shovel') {
    // A rounded scoop sitting on the end of the haft.
    for (let y = 2; y <= 7; y++) {
      for (let x = 8; x <= 13; x++) {
        const edge = Math.hypot((x - 10.5) / 3, (y - 4.5) / 3.2);
        if (edge > 1) continue;
        shadePixel(x, y, edge > 0.75 ? material.dark : material.base);
      }
    }
  } else {
    // Sword: a straight bright blade with a crossguard across the grip.
    for (let i = 0; i <= 8; i++) {
      const x = 7 + i;
      const y = 9 - i;
      shadePixel(x, y, material.base);
      shadePixel(x, y - 1, material.light);
      shadePixel(x + 1, y, material.dark);
    }
    for (let i = -2; i <= 2; i++) shadePixel(6 + i, 12 + i, PALETTE.woodDark);
    shadePixel(12, 3, material.light);
    shadePixel(13, 3, material.light);
    shadePixel(12, 2, material.light);
  }
}

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

  // -------------------------------------------------------------------------
  // Crafting-system blocks
  // -------------------------------------------------------------------------

  /** Crafting table top: the familiar 3x3 grid carved into a plank surface. */
  crafting_table_top: (set, rng) => {
    PAINTERS.planks(set, rng);
    for (let i = 1; i <= 3; i++) {
      const at = i * 4 - 1;
      for (let x = 1; x < TILE - 1; x++) set(x, at, rgb(...shade(PALETTE.woodDark, 0.55)));
      for (let y = 1; y < TILE - 1; y++) set(at, y, rgb(...shade(PALETTE.woodDark, 0.55)));
    }
    // A light bevel around the border so the grid reads as recessed.
    for (let x = 0; x < TILE; x++) {
      set(x, 0, rgb(...shade(PALETTE.wood, 0.7)));
      set(x, TILE - 1, rgb(...shade(PALETTE.woodDark, 0.75)));
    }
  },

  /** Crafting table side: planks with a saw and a hammer resting on top. */
  crafting_table_side: (set, rng) => {
    PAINTERS.planks(set, rng);
    // Tool rack: a saw blade on the left, a hammer head on the right.
    for (let y = 3; y <= 6; y++) {
      for (let x = 1; x <= 6; x++) set(x, y, rgb(...mix([196, 198, 204], [140, 142, 150], rng.next() * 0.5)));
    }
    for (let i = 0; i < 4; i++) set(1 + i, 7, rgb(...PALETTE.woodDark));
    for (let y = 3; y <= 5; y++) {
      for (let x = 9; x <= 13; x++) set(x, y, rgb(...mix([176, 142, 96], [128, 100, 64], rng.next())));
    }
    for (let y = 6; y <= 9; y++) set(11, y, rgb(...PALETTE.woodDark));
  },

  furnace_top: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.stone, PALETTE.stoneDark, n * 0.6)));
      }
    }
    // A ring of rougher stone around a recessed centre.
    for (let y = 4; y < 12; y++) {
      for (let x = 4; x < 12; x++) {
        const edge = Math.max(Math.abs(x - 7.5), Math.abs(y - 7.5));
        if (edge > 3.4) continue;
        set(x, y, rgb(...shade(PALETTE.stoneDark, edge > 2.6 ? 0.8 : 0.62)));
      }
    }
  },

  furnace_side: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.stone, PALETTE.stoneDark, n * 0.6)));
      }
    }
    // A few cobble-like lumps so the furnace reads as masonry.
    for (const [cx, cy] of [[3, 4], [11, 3], [4, 12], [12, 11]]) {
      for (let y = -1; y <= 1; y++) {
        for (let x = -1; x <= 1; x++) {
          set(cx + x, cy + y, rgb(...shade(PALETTE.stoneLight, 0.72 + rng.next() * 0.3)));
        }
      }
    }
  },

  /** The furnace mouth. Unlit: a dark opening with an iron grate. */
  furnace_front: (set, rng) => {
    PAINTERS.furnace_side(set, rng);
    for (let y = 7; y <= 13; y++) {
      for (let x = 3; x <= 12; x++) {
        const inside = y <= 12 && x <= 11;
        set(x, y, rgb(...(inside ? [26, 24, 26] : shade(PALETTE.stoneDark, 0.55))));
      }
    }
    for (let x = 4; x <= 11; x++) set(x, 10, rgb(...shade(PALETTE.stoneDark, 0.7)));
    for (let y = 8; y <= 12; y++) set(7, y, rgb(...shade(PALETTE.stoneDark, 0.7)));
    for (let y = 8; y <= 12; y++) set(9, y, rgb(...shade(PALETTE.stoneDark, 0.7)));
  },

  iron_ore: (set, rng) => {
    PAINTERS.stone(set, rng);
    const lumps = [[3, 4, 2], [10, 4, 2], [6, 10, 2], [12, 11, 1], [2, 12, 1]];
    for (const [cx, cy, r] of lumps) {
      for (let y = -r; y <= r; y++) {
        for (let x = -r; x <= r; x++) {
          if (Math.hypot(x, y) > r + 0.2) continue;
          const px = cx + x;
          const py = cy + y;
          if (px < 0 || px >= TILE || py < 0 || py >= TILE) continue;
          const n = rng.next();
          set(px, py, rgb(...shade(PALETTE.ironOre, 0.72 + n * 0.42)));
        }
      }
    }
  },

  coal_block: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...shade(PALETTE.coalBlock, 0.75 + n * 0.6)));
      }
    }
    // Faceted highlights so a coal block is not a flat black square.
    for (const [cx, cy] of [[4, 4], [11, 5], [6, 11]]) {
      for (let y = 0; y < 3; y++) {
        for (let x = 0; x < 3; x++) set(cx + x, cy + y, rgb(...[96, 98, 108]));
      }
    }
  },

  iron_block: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.iron, PALETTE.ironDark, n * 0.4)));
      }
    }
    // Beaten-metal seams and rivets.
    for (const at of [5, 10]) {
      for (let x = 0; x < TILE; x++) set(x, at, rgb(...shade(PALETTE.ironDark, 0.85)));
      for (let y = 0; y < TILE; y++) set(at, y, rgb(...shade(PALETTE.ironDark, 0.9)));
    }
    for (const [cx, cy] of [[2, 2], [13, 2], [2, 13], [13, 13]]) {
      set(cx, cy, rgb(...PALETTE.ironLight));
    }
  },

  stone_bricks: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const row = Math.floor(y / 4);
        const offset = row % 2 === 0 ? 0 : 4;
        const mortarH = y % 4 === 3;
        const mortarV = (x + offset) % 8 === 7;
        if (mortarH || mortarV) {
          set(x, y, rgb(...shade(PALETTE.brick, 0.55 + rng.next() * 0.1)));
          continue;
        }
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.brick, PALETTE.stoneLight, n * 0.35)));
      }
    }
  },

  cut_sandstone: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        let c = mix(PALETTE.sandstone, PALETTE.sandDark, 0.18 + n * 0.16);
        // A single crisp inset panel line.
        if (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1) c = shade(c, 0.86);
        set(x, y, rgb(...c));
      }
    }
  },

  smooth_stone: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.stone, PALETTE.stoneLight, 0.25 + n * 0.2)));
      }
    }
  },

  smooth_sandstone: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const n = rng.next();
        set(x, y, rgb(...mix(PALETTE.sandstone, PALETTE.sand, 0.3 + n * 0.25)));
      }
    }
  },

  /** Torch: a crossed-billboard stick with a flame, like the other plants. */
  torch: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    for (let y = 7; y < TILE; y++) {
      set(7, y, rgb(...mix(PALETTE.bark, PALETTE.barkDark, rng.next() * 0.6)));
      set(8, y, rgb(...shade(PALETTE.barkDark, 0.9)));
    }
    for (let y = 3; y <= 7; y++) {
      for (let x = 5; x <= 10; x++) {
        const d = Math.hypot((x - 7.5) / 3, (y - 5.2) / 3);
        if (d > 1) continue;
        const heat = 1 - d * 0.7;
        set(x, y, rgb(...mix(PALETTE.torchFlame, [255, 246, 208], heat)));
      }
    }
    set(7, 5, rgb(...[255, 252, 236]));
    set(8, 5, rgb(...[255, 252, 236]));
  },

  // -------------------------------------------------------------------------
  // Material item icons
  // -------------------------------------------------------------------------

  item_stick: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    for (let i = 0; i < 10; i++) {
      const x = 4 + i;
      const y = 12 - i;
      set(x, y, rgb(...mix(PALETTE.wood, PALETTE.woodDark, rng.next() * 0.5)));
      set(x, y + 1, rgb(...shade(PALETTE.woodDark, 0.85)));
      set(x + 1, y, rgb(...shade(PALETTE.wood, 0.9)));
    }
  },

  item_charcoal: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot((x - 7.5) * 1.0, (y - 8) * 1.05) + rng.next() * 1.6;
        if (d > 6.2) { set(x, y, null); continue; }
        // Charcoal is duller and browner than coal.
        const base = d > 5.2 ? [92, 78, 66] : [40, 36, 34];
        set(x, y, rgb(...shade(base, 0.8 + rng.next() * 0.6)));
      }
    }
  },

  item_iron_nugget: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const d = Math.hypot(x - 7.5, y - 8) + rng.next() * 1.2;
        if (d > 4.6) { set(x, y, null); continue; }
        set(x, y, rgb(...mix(PALETTE.iron, PALETTE.ironDark, d / 5 + rng.next() * 0.2)));
      }
    }
    set(6, 6, rgb(...PALETTE.ironLight));
    set(7, 6, rgb(...PALETTE.ironLight));
  },

  item_iron_ingot: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    // A trapezoid ingot: wider at the base, with a bright top face.
    for (let y = 5; y <= 12; y++) {
      const inset = Math.round((y - 5) * 0.22);
      for (let x = 3 + inset; x <= 12 - inset; x++) {
        set(x, y, rgb(...mix(PALETTE.iron, PALETTE.ironDark, (y - 5) / 10 + rng.next() * 0.18)));
      }
    }
    for (let x = 3; x <= 12; x++) set(x, 5, rgb(...PALETTE.ironLight));
    for (let x = 4; x <= 11; x++) set(x, 6, rgb(...mix(PALETTE.iron, PALETTE.ironLight, 0.6)));
  },

  item_bucket: (set, rng) => {
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) set(x, y, null);
    }
    for (let y = 5; y <= 13; y++) {
      const inset = y >= 12 ? 1 : 0;
      for (let x = 3 + inset; x <= 12 - inset; x++) {
        const edge = x === 3 + inset || x === 12 - inset;
        set(x, y, rgb(...mix(PALETTE.iron, PALETTE.ironDark, edge ? 0.55 : 0.2 + rng.next() * 0.25)));
      }
    }
    for (let x = 3; x <= 12; x++) set(x, 5, rgb(...PALETTE.ironLight));
    // Handle.
    for (let i = 0; i <= 6; i++) {
      const x = 4 + i;
      const y = 4 - Math.round(Math.sin((i / 6) * Math.PI) * 3);
      set(x, y, rgb(...PALETTE.ironDark));
    }
  },

  item_water_bucket: (set, rng) => {
    PAINTERS.item_bucket(set, rng);
    for (let y = 4; y <= 6; y++) {
      for (let x = 4; x <= 11; x++) {
        set(x, y, rgb(...mix(PALETTE.water, [150, 210, 255], (y - 4) * 0.3 + rng.next() * 0.2)));
      }
    }
  },

  // -------------------------------------------------------------------------
  // Tool icons — one painter per tier and family, generated from a shared
  // shape so a wooden pickaxe and an iron pickaxe stay recognisably related.
  // -------------------------------------------------------------------------

  item_wooden_pickaxe: (set, rng) => paintTool(set, rng, 'pickaxe', 1),
  item_wooden_axe: (set, rng) => paintTool(set, rng, 'axe', 1),
  item_wooden_shovel: (set, rng) => paintTool(set, rng, 'shovel', 1),
  item_wooden_sword: (set, rng) => paintTool(set, rng, 'sword', 1),
  item_stone_pickaxe: (set, rng) => paintTool(set, rng, 'pickaxe', 2),
  item_stone_axe: (set, rng) => paintTool(set, rng, 'axe', 2),
  item_stone_shovel: (set, rng) => paintTool(set, rng, 'shovel', 2),
  item_stone_sword: (set, rng) => paintTool(set, rng, 'sword', 2),
  item_iron_pickaxe: (set, rng) => paintTool(set, rng, 'pickaxe', 3),
  item_iron_axe: (set, rng) => paintTool(set, rng, 'axe', 3),
  item_iron_shovel: (set, rng) => paintTool(set, rng, 'shovel', 3),
  item_iron_sword: (set, rng) => paintTool(set, rng, 'sword', 3),

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
  },

  /**
   * The arm is built from the 4x12x4 player-model box, and at the scale the
   * view model puts it on screen one 16px tile stretches across a face that is
   * twelve model pixels long. A single tile therefore cannot serve every face:
   * the top and bottom of the box are a four-pixel cross-section while the
   * sides run the length of the forearm, so the sleeve has to sit where the
   * shoulder-end cross-section samples and the hand where the wrist-end does.
   * Three tiles, sampled per face, is what keeps the sleeve on the shoulder and
   * the skin on the hand.
   */
  arm_shoulder: (set, rng) => {
    // The cut end at the shoulder: cloth only, and darker at the rim.
    const sleeve = [122, 84, 58];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const rim = (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1) ? 0.78 : 1;
        const weave = 0.94 + rng.next() * 0.12;
        set(x, y, rgb(...shade(sleeve, rim * weave)));
      }
    }
  },

  arm_end: (set, rng) => {
    // The cut end at the wrist: the flat of the hand, held slightly lighter
    // than the sleeve so the two ends of the box never read as the same face.
    const skin = [214, 166, 130];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const rim = (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1) ? 0.8 : 1;
        const grain = 0.94 + rng.next() * 0.12;
        set(x, y, rgb(...shade(skin, rim * grain)));
      }
    }
    // Knuckle line across the end of the fist.
    for (const [kx, ky] of [[4, 6], [7, 5], [10, 7], [5, 11], [9, 10]]) {
      set(kx, ky, rgb(...shade(skin, 1.1)));
    }
  },

  arm_side: (set, rng) => {
    // The long faces, sampled across the arm's whole 12-pixel length: sleeve at
    // the shoulder, bare forearm, then the fist. Tone bands as well as colour
    // so the length of the arm reads even where it is cropped by the frame.
    const skin = [214, 166, 130];
    const sleeve = [122, 84, 58];
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const t = y / (TILE - 1);          // 0 = shoulder, 1 = fist
        let base = skin;
        if (t < 0.34) base = sleeve;
        else if (t < 0.42) base = mix(sleeve, skin, (t - 0.34) / 0.08); // cuff
        // A soft crease down the middle of the forearm, and a knuckle band.
        let fold = 1;
        if (Math.abs(x - 7.5) < 1.5 && t >= 0.42 && t < 0.86) fold = 0.88;
        if (t >= 0.86 && (x % 5 === 1)) fold = 1.1;
        const edge = (x === 0 || x === TILE - 1) ? 0.88 : 1;
        const grain = 0.95 + rng.next() * 0.1;
        set(x, y, rgb(...shade(base, fold * edge * grain)));
      }
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
