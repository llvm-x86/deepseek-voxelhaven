/**
 * MeshBuilder.js — converts chunk voxels into GPU-ready geometry.
 *
 * Algorithm
 *  1. Sweep the chunk along each of the three axes, one slice at a time.
 *  2. For every cell in the slice decide whether a quad is needed and, if so,
 *     which block owns it and which way it faces (only visible faces are kept).
 *  3. Merge neighbouring quads that are *completely identical* — same block,
 *     same facing, same four corner ambient-occlusion values and same four
 *     corner light values — into one larger rectangle. Because the merge
 *     predicate includes the corner attributes, merging can never change how
 *     the surface is shaded; it only removes vertices.
 *  4. Emit each merged rectangle as two triangles.
 *
 * Per-vertex data (11 floats, 44 bytes):
 *   [0..2] world position
 *   [3..4] tile-space coordinate (0..w, 0..h) used for texture wrapping
 *   [5..6] atlas cell origin, so a merged quad can still sample a single tile
 *   [7..8] skylight and block light, normalised to 0..1
 *   [9]    baked ambient occlusion * face shading
 *   [10]   flags (VERTEX_FLAG_LIQUID for animated water surfaces)
 *
 * The builder allocates nothing per cell and reuses its masks and output
 * buffers between chunks, so meshing a chunk produces no steady-state garbage
 * beyond the final right-sized copies.
 */

import { CHUNK_SIZE, WORLD_HEIGHT, RENDER } from '../core/Config.js';
import { BlockId, OPAQUE, TRANSLUCENT, PLANT, FACE, BlockRegistry } from './Blocks.js';

/** Vertex layout constants shared with the renderer. */
export const VERTEX_FLOATS = 11;
export const VERTEX_BYTES = VERTEX_FLOATS * 4;

/**
 * Flag bits stored in vertex component 10 (aMisc.y) and interpreted by the
 * VOXEL fragment shader.
 *   LIQUID — animate the tile coordinate (water surfaces)
 *   FLASH  — tint the surface red (mob damage feedback)
 */
export const VERTEX_FLAG_LIQUID = 1.0;
export const VERTEX_FLAG_FLASH = 2.0;

/** Face shading multipliers in face-index order (east, west, top, bottom, south, north). */
const FACE_SHADE = new Float32Array([
  RENDER.faceShade.east,
  RENDER.faceShade.west,
  RENDER.faceShade.top,
  RENDER.faceShade.bottom,
  RENDER.faceShade.south,
  RENDER.faceShade.north
]);

/** Mask id packing: low 8 bits block id, then facing sign, then the surface bit. */
const MASK_SIGN_POSITIVE = 0x100;
const MASK_SIGN_NEGATIVE = 0x200;
const MASK_LIQUID_SURFACE = 0x400;

/** Growable Float32 buffer that avoids per-push boxing. */
class FloatBuffer {
  constructor(capacity = 4096) {
    this.data = new Float32Array(capacity);
    this.length = 0;
  }

  ensure(extra) {
    if (this.length + extra <= this.data.length) return;
    let next = this.data.length * 2;
    while (next < this.length + extra) next *= 2;
    const grown = new Float32Array(next);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  reset() { this.length = 0; }

  /** Copy the used prefix into a right-sized array. */
  toArray() { return this.data.slice(0, this.length); }
}

/** Growable Uint32 index buffer. */
class IndexBuffer {
  constructor(capacity = 4096) {
    this.data = new Uint32Array(capacity);
    this.length = 0;
  }

  ensure(extra) {
    if (this.length + extra <= this.data.length) return;
    let next = this.data.length * 2;
    while (next < this.length + extra) next *= 2;
    const grown = new Uint32Array(next);
    grown.set(this.data.subarray(0, this.length));
    this.data = grown;
  }

  reset() { this.length = 0; }

  toArray() { return this.data.slice(0, this.length); }
}

/**
 * Decides whether the face of `selfId` that touches `neighbourId` is visible.
 * @param {number} selfId
 * @param {number} neighbourId
 * @returns {boolean}
 */
export function isFaceVisible(selfId, neighbourId) {
  if (selfId === BlockId.AIR) return false;
  if (neighbourId === BlockId.AIR) return true;
  if (OPAQUE[neighbourId] === 1) return false;
  // Identical non-opaque blocks hide their shared face (water, glass, leaves).
  if (selfId === neighbourId) return false;
  return true;
}

/** In-plane axes for a sweep axis, chosen so e_u x e_v = +e_axis. */
const U_AXIS = [1, 2, 0];
const V_AXIS = [2, 0, 1];
/** Slice dimensions for each sweep axis: [X, Y, Z] sizes. */
const DIMS = [CHUNK_SIZE, WORLD_HEIGHT, CHUNK_SIZE];

export class MeshBuilder {
  /**
   * @param {Object} atlas object exposing tileU(name) / tileV(name)
   */
  constructor(atlas) {
    this.atlas = atlas;

    // Per-block, per-face atlas origin, resolved once after the atlas exists.
    this.faceU = new Float32Array(256 * 6);
    this.faceV = new Float32Array(256 * 6);

    // Per-slice scratch masks (largest slice is 16 x 128 = 2048 cells).
    const maxCells = CHUNK_SIZE * WORLD_HEIGHT;
    this.maskId = new Int32Array(maxCells);
    this.maskAo = new Uint8Array(maxCells * 4);
    this.maskSky = new Uint8Array(maxCells * 4);
    this.maskBlock = new Uint8Array(maxCells * 4);
    // Indices written during the current mask pass, so the mask can be cleared
    // in proportion to the work done rather than to the plane size.
    this._written = new Int32Array(maxCells);
    this._writtenCount = 0;

    this.opaqueVerts = new FloatBuffer(32768);
    this.opaqueIndices = new IndexBuffer(16384);
    this.transparentVerts = new FloatBuffer(8192);
    this.transparentIndices = new IndexBuffer(4096);

    /** Diagnostics from the last build. */
    this.stats = { opaqueQuads: 0, transparentQuads: 0, culledFaces: 0, mergedCells: 0 };

    // Scratch registers, allocated once.
    this._ao = new Float32Array(4);
    this._sky = new Float32Array(4);
    this._block = new Float32Array(4);
    this._cell = new Int32Array(3);
    this._nCell = new Int32Array(3);
    this._front = new Int32Array(3);
    this._side1 = new Int32Array(3);
    this._side2 = new Int32Array(3);
    this._corner = new Int32Array(3);

    /** @type {import('./Chunk.js').Chunk|null} */
    this._chunk = null;
    /** @type {import('./World.js').World|null} */
    this._world = null;
  }

  /**
   * Resolve the atlas origins for every block face. Called once after the
   * texture atlas has been generated.
   * @param {(name:string)=>number} tileIndexOf maps tile name -> atlas index
   * @param {number} grid atlas grid dimension (16 for a 16x16 tile sheet)
   */
  buildFaceTable(tileIndexOf, grid) {
    const inv = 1 / grid;
    for (const def of BlockRegistry.all()) {
      const names = BlockRegistry.faceTiles(def.id);
      for (let face = 0; face < 6; face++) {
        const index = tileIndexOf(names[face]);
        const col = index % grid;
        const row = Math.floor(index / grid);
        this.faceU[def.id * 6 + face] = col * inv;
        this.faceV[def.id * 6 + face] = row * inv;
      }
    }
  }

  /**
   * Build both meshes for a chunk.
   * @param {import('./Chunk.js').Chunk} chunk
   * @param {import('./World.js').World} world
   * @returns {{opaque: {vertices:Float32Array, indices:Uint32Array}|null,
   *            transparent: {vertices:Float32Array, indices:Uint32Array}|null,
   *            stats: object}}
   */
  build(chunk, world) {
    this.opaqueVerts.reset();
    this.opaqueIndices.reset();
    this.transparentVerts.reset();
    this.transparentIndices.reset();
    this.stats.opaqueQuads = 0;
    this.stats.transparentQuads = 0;
    this.stats.culledFaces = 0;
    this.stats.mergedCells = 0;

    this._chunk = chunk;
    this._world = world;

    for (let axis = 0; axis < 3; axis++) this.buildAxis(chunk, world, axis);
    this.buildPlants(chunk, world);

    this._chunk = null;
    this._world = null;

    const opaque = this.opaqueIndices.length > 0
      ? { vertices: this.opaqueVerts.toArray(), indices: this.opaqueIndices.toArray() }
      : null;
    const transparent = this.transparentIndices.length > 0
      ? { vertices: this.transparentVerts.toArray(), indices: this.transparentIndices.toArray() }
      : null;

    return { opaque, transparent, stats: { ...this.stats } };
  }

  /**
   * Sweep one axis and emit the visible faces of both of its directions.
   *
   * The mask holds a single face per (u,v) cell, so the two directions are
   * filled and merged as separate passes. That keeps the merge key implicit —
   * every cell in a pass shares the same face sign, so a greedy rectangle can
   * never fuse a +axis face with a -axis face.
   *
   * @param {number} axis 0=X, 1=Y, 2=Z
   */
  buildAxis(chunk, world, axis) {
    for (let slice = 0; slice < DIMS[axis]; slice++) {
      for (const sign of [1, -1]) {
        this._writtenCount = 0;
        if (this.fillMask(chunk, world, axis, slice, sign)) {
          this.consumeMask(chunk, axis, slice);
        }
      }
    }
  }

  /**
   * Rasterise the visible faces of one slice/direction into the 2D mask.
   *
   * Every face is decided by the block that owns it: a face is drawn when the
   * neighbour it faces into is transparent. Testing both directions here is
   * what makes interiors, overhangs, ceilings and isolated blocks correct —
   * relying on a neighbour's sweep to emit the opposite face silently loses
   * every -axis face whose owner has air behind it.
   *
   * @param {number} axis 0=X, 1=Y, 2=Z
   * @param {number} slice the plane index along `axis`
   * @param {number} sign +1 for the face at slice+1, -1 for the face at slice
   * @returns {boolean} true when at least one cell was written
   */
  fillMask(chunk, world, axis, slice, sign) {
    const uAxis = U_AXIS[axis];
    const vAxis = V_AXIS[axis];
    const uSize = DIMS[uAxis];
    const vSize = DIMS[vAxis];

    const { maskId } = this;
    const cell = this._cell;
    const nCell = this._nCell;

    let hasAny = false;

    for (let v = 0; v < vSize; v++) {
      for (let u = 0; u < uSize; u++) {
        cell[axis] = slice;
        cell[uAxis] = u;
        cell[vAxis] = v;
        const x = cell[0];
        const y = cell[1];
        const z = cell[2];

        const selfId = this.sampleBlock(chunk, world, x, y, z);
        if (selfId === BlockId.AIR) continue;
        // Plants are drawn as crossed billboards later, never as cubes.
        if (PLANT[selfId] === 1) continue;

        // The neighbour in the direction this face looks into. A neighbouring
        // chunk is sampled through the world, and an out-of-bounds -Y probe
        // reads as air, which correctly exposes the bottom of the world.
        nCell[0] = x; nCell[1] = y; nCell[2] = z;
        nCell[axis] += sign;
        const neighbourId = this.sampleBlock(chunk, world, nCell[0], nCell[1], nCell[2]);

        if (isFaceVisible(selfId, neighbourId)) {
          // Ownership stays with (x, y, z): the face is emitted at the block's
          // own coordinates, which is what keeps its texture and corner
          // shading on the right block.
          const maskIndex = v * uSize + u;
          this.writeMaskCell(chunk, world, maskIndex, x, y, z, selfId, axis, sign);
          this._written[this._writtenCount++] = maskIndex;
          hasAny = true;
        } else {
          this.stats.culledFaces++;
        }
      }
    }
    return hasAny;
  }

  /**
   * Merge and emit a slice `fillMask` just populated, then reset the mask.
   *
   * The mask is cleared by walking only the cells that were actually written,
   * rather than `.fill(0)` over the whole plane. A plane is up to 2048 cells and
   * there are 256 plane/direction passes per chunk, so clearing eagerly costs
   * far more than the few faces most planes contain.
   */
  consumeMask(chunk, axis, slice) {
    this.mergeAndEmit(chunk, axis, slice);
    // mergeAndEmit already zeroes every cell it consumed; this catches anything
    // that survived the merge so no stale face can leak into the next pass.
    for (let i = 0; i < this._writtenCount; i++) this.maskId[this._written[i]] = 0;
    this._writtenCount = 0;
  }

  /**
   * Emit crossed billboards for every decorative plant in the chunk.
   *
   * A plant is two quads crossing at the block centre, each drawn twice with
   * opposite winding so it is visible from every direction without disabling
   * back-face culling for the rest of the world.
   */
  buildPlants(chunk, world) {
    const blocks = chunk.blocks;
    for (let y = 0; y < WORLD_HEIGHT; y++) {
      const layer = y * CHUNK_SIZE * CHUNK_SIZE;
      for (let z = 0; z < CHUNK_SIZE; z++) {
        for (let x = 0; x < CHUNK_SIZE; x++) {
          const id = blocks[layer + z * CHUNK_SIZE + x];
          if (id === BlockId.AIR || PLANT[id] !== 1) continue;

          // A plant is only worth drawing when it is not completely enclosed.
          const sky = this.sampleSky(chunk, world, x, y, z) / 15;
          const blockLight = this.sampleBlockLight(chunk, world, x, y, z) / 15;
          if (sky <= 0 && blockLight <= 0) continue;

          const cx = chunk.originX + x + 0.5;
          const cz = chunk.originZ + z + 0.5;
          const baseY = y;
          const topY = y + 1;
          const h = PLANT_HALF_WIDTH;

          // Diagonal A: (x-,z-) to (x+,z+). Diagonal B: (x-,z+) to (x+,z-).
          this.emitCrossQuad(id, cx - h, baseY, cz - h, cx + h, topY, cz + h, sky, blockLight);
          this.emitCrossQuad(id, cx - h, baseY, cz + h, cx + h, topY, cz - h, sky, blockLight);
          this.stats.opaqueQuads += 2;
        }
      }
    }
  }

  /** Emit one plant quad and its back face. */
  emitCrossQuad(id, ax, ay, az, bx, by, bz, sky, blockLight) {
    const face = FACE.NORTH;
    const tileU = this.faceU[id * 6 + face];
    const tileV = this.faceV[id * 6 + face];
    // Plants are self-lit a little so they stay readable in deep shade.
    const litSky = Math.max(sky, 0.25);

    const verts = this.opaqueVerts;
    const indices = this.opaqueIndices;
    const baseVertex = verts.length / VERTEX_FLOATS;
    verts.ensure(4 * VERTEX_FLOATS);
    const data = verts.data;
    let cursor = verts.length;

    // Corner order: bottom-a, bottom-b, top-b, top-a.
    const px = [ax, bx, bx, ax];
    const py = [ay, ay, by, by];
    const pz = [az, bz, bz, az];
    const texU = [0, 1, 1, 0];
    const texV = [1, 1, 0, 0];

    for (let i = 0; i < 4; i++) {
      data[cursor + 0] = px[i];
      data[cursor + 1] = py[i];
      data[cursor + 2] = pz[i];
      data[cursor + 3] = texU[i];
      data[cursor + 4] = texV[i];
      data[cursor + 5] = tileU;
      data[cursor + 6] = tileV;
      data[cursor + 7] = litSky;
      data[cursor + 8] = blockLight;
      data[cursor + 9] = 0.94; // plants are not shaded by face direction
      data[cursor + 10] = 0;
      cursor += VERTEX_FLOATS;
    }
    verts.length = cursor;

    indices.ensure(12);
    const out = indices.data;
    let ic = indices.length;
    // Front face.
    out[ic++] = baseVertex; out[ic++] = baseVertex + 1; out[ic++] = baseVertex + 2;
    out[ic++] = baseVertex; out[ic++] = baseVertex + 2; out[ic++] = baseVertex + 3;
    // Back face (reversed winding) so the plant is visible from both sides.
    out[ic++] = baseVertex; out[ic++] = baseVertex + 2; out[ic++] = baseVertex + 1;
    out[ic++] = baseVertex; out[ic++] = baseVertex + 3; out[ic++] = baseVertex + 2;
    indices.length = ic;
  }

  /**
   * Fill one mask cell with the packed descriptor (block id, facing sign,
   * liquid-surface flag) and the four corner shading samples.
   */
  writeMaskCell(chunk, world, maskIndex, x, y, z, id, axis, sign) {
    this.computeCornerData(chunk, world, x, y, z, axis, sign);

    const { maskId, maskAo, maskSky, maskBlock, _ao, _sky, _block } = this;
    let packed = id | (sign > 0 ? MASK_SIGN_POSITIVE : MASK_SIGN_NEGATIVE);
    // Only a water surface with air above it gets the animated, lowered top.
    if (id === BlockId.WATER && axis === 1 && sign > 0) {
      const above = this.sampleBlock(chunk, world, x, y + 1, z);
      if (above !== BlockId.WATER) packed |= MASK_LIQUID_SURFACE;
    }
    maskId[maskIndex] = packed;

    const base = maskIndex * 4;
    for (let i = 0; i < 4; i++) {
      maskAo[base + i] = Math.round(_ao[i] * 255);
      maskSky[base + i] = Math.round(_sky[i] * 255);
      maskBlock[base + i] = Math.round(_block[i] * 255);
    }
  }

  /** Greedy rectangle merge over the mask, emitting each rectangle. */
  mergeAndEmit(chunk, axis, slice) {
    const { maskId, maskAo, maskSky, maskBlock } = this;
    // Row stride of the mask, derived from the swept axis so the caller does
    // not have to thread the dimensions through.
    const uSize = DIMS[U_AXIS[axis]];
    const vSize = DIMS[V_AXIS[axis]];
    const width = uSize;

    for (let v = 0; v < vSize; v++) {
      for (let u = 0; u < uSize;) {
        const index = v * width + u;
        const packed = maskId[index];
        if (packed === 0) { u++; continue; }

        const base = index * 4;
        const a0 = maskAo[base], a1 = maskAo[base + 1], a2 = maskAo[base + 2], a3 = maskAo[base + 3];
        const s0 = maskSky[base], s1 = maskSky[base + 1], s2 = maskSky[base + 2], s3 = maskSky[base + 3];
        const b0 = maskBlock[base], b1 = maskBlock[base + 1], b2 = maskBlock[base + 2], b3 = maskBlock[base + 3];

        // Extend along +u while the descriptor is byte-for-byte identical.
        let w = 1;
        while (u + w < uSize) {
          const nb = (v * width + (u + w)) * 4;
          if (maskId[v * width + (u + w)] !== packed) break;
          if (maskAo[nb] !== a0 || maskAo[nb + 1] !== a1 || maskAo[nb + 2] !== a2 || maskAo[nb + 3] !== a3) break;
          if (maskSky[nb] !== s0 || maskSky[nb + 1] !== s1 || maskSky[nb + 2] !== s2 || maskSky[nb + 3] !== s3) break;
          if (maskBlock[nb] !== b0 || maskBlock[nb + 1] !== b1 || maskBlock[nb + 2] !== b2 || maskBlock[nb + 3] !== b3) break;
          w++;
        }

        // Extend along +v while every cell of the candidate row matches.
        let h = 1;
        outer:
        while (v + h < vSize) {
          const rowStart = (v + h) * width + u;
          for (let k = 0; k < w; k++) {
            const nIndex = rowStart + k;
            if (maskId[nIndex] !== packed) break outer;
            const nb = nIndex * 4;
            if (maskAo[nb] !== a0 || maskAo[nb + 1] !== a1 || maskAo[nb + 2] !== a2 || maskAo[nb + 3] !== a3) break outer;
            if (maskSky[nb] !== s0 || maskSky[nb + 1] !== s1 || maskSky[nb + 2] !== s2 || maskSky[nb + 3] !== s3) break outer;
            if (maskBlock[nb] !== b0 || maskBlock[nb + 1] !== b1 || maskBlock[nb + 2] !== b2 || maskBlock[nb + 3] !== b3) break outer;
          }
          h++;
        }

        // Clear the consumed cells so they are not emitted twice.
        for (let dv = 0; dv < h; dv++) {
          const rowStart = (v + dv) * width + u;
          for (let du = 0; du < w; du++) maskId[rowStart + du] = 0;
        }

        if (w > 1 || h > 1) this.stats.mergedCells += w * h;

        this.emitQuad(chunk, axis, slice, u, v, w, h, packed,
          a0, a1, a2, a3, s0, s1, s2, s3, b0, b1, b2, b3);

        u += w;
      }
    }
  }

  /**
   * Emit one (possibly merged) quad as two triangles into the opaque or the
   * translucent buffer, depending on the block.
   */
  emitQuad(chunk, axis, slice, u, v, w, h, packed,
    a0, a1, a2, a3, s0, s1, s2, s3, b0, b1, b2, b3) {
    const blockId = packed & 0xff;
    const sign = (packed & MASK_SIGN_POSITIVE) !== 0 ? 1 : -1;
    const liquidSurface = (packed & MASK_LIQUID_SURFACE) !== 0;
    const face = faceIndexFromAxisSign(axis, sign);

    const translucent = TRANSLUCENT[blockId] === 1;
    const verts = translucent ? this.transparentVerts : this.opaqueVerts;
    const indices = translucent ? this.transparentIndices : this.opaqueIndices;
    if (translucent) this.stats.transparentQuads++;
    else this.stats.opaqueQuads++;

    const uAxis = U_AXIS[axis];
    const vAxis = V_AXIS[axis];
    // The +axis face sits on the far side of the block, at slice + 1.
    let plane = sign > 0 ? slice + 1 : slice;
    if (liquidSurface) plane -= LIQUID_SURFACE_DROP;

    const tileU = this.faceU[blockId * 6 + face];
    const tileV = this.faceV[blockId * 6 + face];
    const flags = liquidSurface ? VERTEX_FLAG_LIQUID : 0;
    const shade = FACE_SHADE[face];
    const aoStrength = RENDER.aoStrength;

    const baseVertex = verts.length / VERTEX_FLOATS;
    verts.ensure(4 * VERTEX_FLOATS);
    const data = verts.data;
    let cursor = verts.length;

    // Corner order 0,1,2,3 runs anticlockwise seen from outside the +axis side,
    // matching the sign pairs used by computeCornerData.
    _qDu[0] = 0; _qDu[1] = w; _qDu[2] = w; _qDu[3] = 0;
    _qDv[0] = 0; _qDv[1] = 0; _qDv[2] = h; _qDv[3] = h;
    _qAo[0] = a0; _qAo[1] = a1; _qAo[2] = a2; _qAo[3] = a3;
    _qSky[0] = s0; _qSky[1] = s1; _qSky[2] = s2; _qSky[3] = s3;
    _qBlk[0] = b0; _qBlk[1] = b1; _qBlk[2] = b2; _qBlk[3] = b3;
    const normalised = 1 / 255;

    for (let i = 0; i < 4; i++) {
      const du = _qDu[i];
      const dv = _qDv[i];
      const posU = u + du;
      const posV = v + dv;
      const px = axis === 0 ? plane : (uAxis === 0 ? posU : posV);
      const py = axis === 1 ? plane : (uAxis === 1 ? posU : posV);
      const pz = axis === 2 ? plane : (uAxis === 2 ? posU : posV);

      // Texture coordinates.
      //
      // Vertical faces map the in-plane vertical axis to V so wood grain and
      // plank seams stay upright. V is measured downwards from the top of the
      // quad because WebGL texture row 0 sits at V = 0 while the tile painters
      // describe their art top-first; without this flip every texture would
      // appear upside down in the world.
      let texU;
      let texV;
      if (axis === 2) { texU = du; texV = h - dv; } else { texU = dv; texV = w - du; }

      data[cursor + 0] = chunk.originX + px;
      data[cursor + 1] = py;
      data[cursor + 2] = chunk.originZ + pz;
      data[cursor + 3] = texU;
      data[cursor + 4] = texV;
      data[cursor + 5] = tileU;
      data[cursor + 6] = tileV;
      data[cursor + 7] = _qSky[i] * normalised;
      data[cursor + 8] = _qBlk[i] * normalised;
      data[cursor + 9] = (1 - (1 - _qAo[i] * normalised) * aoStrength) * shade;
      data[cursor + 10] = flags;
      cursor += VERTEX_FLOATS;
    }
    verts.length = cursor;

    indices.ensure(6);
    const out = indices.data;
    let ic = indices.length;
    if (sign > 0) {
      out[ic++] = baseVertex; out[ic++] = baseVertex + 1; out[ic++] = baseVertex + 2;
      out[ic++] = baseVertex; out[ic++] = baseVertex + 2; out[ic++] = baseVertex + 3;
    } else {
      out[ic++] = baseVertex; out[ic++] = baseVertex + 3; out[ic++] = baseVertex + 2;
      out[ic++] = baseVertex; out[ic++] = baseVertex + 2; out[ic++] = baseVertex + 1;
    }
    indices.length = ic;
  }

  /**
   * Compute ambient occlusion and smooth light for the four corners of a face.
   *
   * For a face of the block at (x,y,z) with outward normal n, the corner in
   * the (su, sv) direction of the face plane is occluded by the blocks at
   * n+su*e_u, n+sv*e_v and their diagonal. Light is averaged over the four
   * non-opaque cells around the corner, which produces soft gradients under
   * overhangs and beside walls.
   *
   * @param {number} axis 0..2
   * @param {number} sign +1 or -1, the face direction along `axis`
   */
  computeCornerData(chunk, world, x, y, z, axis, sign) {
    const uAxis = U_AXIS[axis];
    const vAxis = V_AXIS[axis];
    const { _ao, _sky, _block, _front, _side1, _side2, _corner } = this;

    // Fallback when every neighbouring cell is opaque.
    const selfSky = this.sampleSky(chunk, world, x, y, z);
    const selfBlock = this.sampleBlockLight(chunk, world, x, y, z);

    // Corner sign pairs in vertex order: (-,-), (+,-), (+,+), (-,+).
    const signU = [-1, 1, 1, -1];
    const signV = [-1, -1, 1, 1];

    for (let i = 0; i < 4; i++) {
      const su = signU[i];
      const sv = signV[i];

      _front[0] = x; _front[1] = y; _front[2] = z;
      _front[axis] += sign;

      _side1[0] = _front[0]; _side1[1] = _front[1]; _side1[2] = _front[2];
      _side1[uAxis] += su;
      _side2[0] = _front[0]; _side2[1] = _front[1]; _side2[2] = _front[2];
      _side2[vAxis] += sv;
      _corner[0] = _front[0]; _corner[1] = _front[1]; _corner[2] = _front[2];
      _corner[uAxis] += su;
      _corner[vAxis] += sv;

      const o1 = this.opaqueAt(chunk, world, _side1[0], _side1[1], _side1[2]) ? 1 : 0;
      const o2 = this.opaqueAt(chunk, world, _side2[0], _side2[1], _side2[2]) ? 1 : 0;
      const oc = this.opaqueAt(chunk, world, _corner[0], _corner[1], _corner[2]) ? 1 : 0;

      // Classic voxel AO: two solid sides -> fully dark, otherwise count blockers.
      _ao[i] = (o1 && o2) ? 0 : (3 - (o1 + o2 + oc)) / 3;

      let skySum = 0;
      let blockSum = 0;
      let samples = 0;
      if (!this.opaqueAt(chunk, world, _front[0], _front[1], _front[2])) {
        skySum += this.sampleSky(chunk, world, _front[0], _front[1], _front[2]);
        blockSum += this.sampleBlockLight(chunk, world, _front[0], _front[1], _front[2]);
        samples++;
      }
      if (!o1) {
        skySum += this.sampleSky(chunk, world, _side1[0], _side1[1], _side1[2]);
        blockSum += this.sampleBlockLight(chunk, world, _side1[0], _side1[1], _side1[2]);
        samples++;
      }
      if (!o2) {
        skySum += this.sampleSky(chunk, world, _side2[0], _side2[1], _side2[2]);
        blockSum += this.sampleBlockLight(chunk, world, _side2[0], _side2[1], _side2[2]);
        samples++;
      }
      if (!oc) {
        skySum += this.sampleSky(chunk, world, _corner[0], _corner[1], _corner[2]);
        blockSum += this.sampleBlockLight(chunk, world, _corner[0], _corner[1], _corner[2]);
        samples++;
      }

      if (samples > 0) {
        _sky[i] = (skySum / samples) / 15;
        _block[i] = (blockSum / samples) / 15;
      } else {
        _sky[i] = selfSky / 15;
        _block[i] = selfBlock / 15;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Sampling helpers (fast in-chunk path, world fallback across borders)
  // -------------------------------------------------------------------------

  /** Block id at local coordinates, reading neighbouring chunks when needed. */
  sampleBlock(chunk, world, x, y, z) {
    if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y >= 0 && y < WORLD_HEIGHT) {
      return chunk.blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
    }
    return world.getBlock(chunk.originX + x, y, chunk.originZ + z);
  }

  /** Skylight at local coordinates (0..15). */
  sampleSky(chunk, world, x, y, z) {
    if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y >= 0 && y < WORLD_HEIGHT) {
      return chunk.skyLight[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
    }
    if (y >= WORLD_HEIGHT) return 15; // open sky above the build limit
    return world.getSkyLight(chunk.originX + x, y, chunk.originZ + z);
  }

  /** Block light at local coordinates (0..15). */
  sampleBlockLight(chunk, world, x, y, z) {
    if (x >= 0 && x < CHUNK_SIZE && z >= 0 && z < CHUNK_SIZE && y >= 0 && y < WORLD_HEIGHT) {
      return chunk.blockLight[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x];
    }
    if (y >= WORLD_HEIGHT) return 0;
    return world.getBlockLight(chunk.originX + x, y, chunk.originZ + z);
  }

  /** True when the block at local coordinates is fully opaque. */
  opaqueAt(chunk, world, x, y, z) {
    return OPAQUE[this.sampleBlock(chunk, world, x, y, z)] === 1;
  }
}

/** How far the water surface sits below the top of its block. */
const LIQUID_SURFACE_DROP = 0.12;

/** Half width of a plant billboard, in blocks. */
const PLANT_HALF_WIDTH = 0.42;

// Module-level scratch for quad emission: reusing these keeps meshing free of
// per-quad allocations. Safe because emitQuad is never reentrant.
const _qDu = new Int32Array(4);
const _qDv = new Int32Array(4);
const _qAo = new Float32Array(4);
const _qSky = new Float32Array(4);
const _qBlk = new Float32Array(4);

/**
 * Face index (see Blocks.FACE) from a swept axis and direction sign.
 * Axis 0 -> east/west, 1 -> top/bottom, 2 -> south/north.
 */
export function faceIndexFromAxisSign(axis, sign) {
  if (axis === 0) return sign > 0 ? FACE.EAST : FACE.WEST;
  if (axis === 1) return sign > 0 ? FACE.TOP : FACE.BOTTOM;
  return sign > 0 ? FACE.SOUTH : FACE.NORTH;
}
