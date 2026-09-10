/**
 * DynamicMesh.js — a reusable CPU-built mesh in the chunk vertex layout.
 *
 * Dropped items, mobs, particles and the held item all rebuild their geometry
 * every frame. Rather than keeping a scene graph, they push boxes, quads and
 * billboards into this batcher, which reuses one ArrayBuffer and issues a
 * single draw call per category.
 */

import { createMeshVAO } from './GLUtils.js';
import { VOXEL_ATTRIBUTES, VOXEL_STRIDE_FLOATS } from './Shaders.js';
import { mat4Compose } from '../core/Math3D.js';
/** Flag bits shared with the mesh builder and the VOXEL fragment shader. */
export const FLAG_LIQUID = 1.0;
export const FLAG_FLASH = 2.0;

/** Unit cube face definitions: 4 corner offsets per face, in the shared order. */
const CUBE_FACES = [
  // +X (east)
  { corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], shade: 0.66 },
  // -X (west)
  { corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], shade: 0.66 },
  // +Y (top)
  { corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], shade: 1.0 },
  // -Y (bottom)
  { corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], shade: 0.52 },
  // +Z (south)
  { corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], shade: 0.78 },
  // -Z (north)
  { corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], shade: 0.78 }
];

// Module-level scratch corners: addQuad copies them immediately, so reusing
// these keeps dynamic geometry building free of per-primitive allocations.
const _boxCorners = [
  new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)
];
const _billboardCorners = [
  new Float32Array(3), new Float32Array(3), new Float32Array(3), new Float32Array(3)
];

export class DynamicMesh {
  /**
   * @param {WebGL2RenderingContext} gl
   * @param {number} maxVertices capacity hint; the buffer grows automatically
   */
  constructor(gl, maxVertices = 4096) {
    this.gl = gl;
    this.capacity = maxVertices;
    this.vertices = new Float32Array(maxVertices * VOXEL_STRIDE_FLOATS);
    this.indices = new Uint32Array(maxVertices * 2);
    this.vertexCount = 0;
    this.indexCount = 0;

    // The buffers are created empty and re-uploaded with bufferSubData each
    // frame, sized to the peak usage seen so far.
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.vertices.byteLength, gl.DYNAMIC_DRAW);
    const stride = VOXEL_STRIDE_FLOATS * 4;
    for (const attr of VOXEL_ATTRIBUTES) {
      gl.enableVertexAttribArray(attr.location);
      gl.vertexAttribPointer(attr.location, attr.size, gl.FLOAT, false, stride, attr.offsetFloats * 4);
    }
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.indices.byteLength, gl.DYNAMIC_DRAW);
    gl.bindVertexArray(null);

    this.vao = vao;
    this.vbo = vbo;
    this.ibo = ibo;
    /** Peak vertex usage, used to grow the buffers once and then never again. */
    this.peakVertices = 0;
    this._matrix = new Float32Array(16);
  }

  /** Clear the CPU-side geometry, keeping the capacity. */
  begin() {
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  /** Grow the CPU arrays when a frame needs more room than ever before. */
  ensure(extraVertices) {
    const needed = this.vertexCount + extraVertices;
    if (needed <= this.capacity) return;
    let next = this.capacity;
    while (next < needed) next *= 2;
    const verts = new Float32Array(next * VOXEL_STRIDE_FLOATS);
    verts.set(this.vertices.subarray(0, this.vertexCount * VOXEL_STRIDE_FLOATS));
    this.vertices = verts;
    const idx = new Uint32Array(next * 2);
    idx.set(this.indices.subarray(0, this.indexCount));
    this.indices = idx;
    this.capacity = next;
  }

  /**
   * Push one quad.
   * @param {number[][]} positions four world-space corners, anticlockwise from outside
   * @param {number} tileU atlas cell origin U
   * @param {number} tileV atlas cell origin V
   * @param {number} sky skylight 0..1
   * @param {number} blockLight block light 0..1
   * @param {number} shade combined ao * face shade
   * @param {number} flags vertex flags
   * @param {number} [texW] tile-space extent along U (default 1)
   * @param {number} [texH] tile-space extent along V (default 1)
   */
  addQuad(positions, tileU, tileV, sky, blockLight, shade, flags = 0, texW = 1, texH = 1) {
    this.ensure(4);
    const base = this.vertexCount;
    const data = this.vertices;
    // V runs from texH down to 0 so that "up" in the world samples the top of
    // the painted tile (see the matching note in MeshBuilder.emitQuad).
    const tex = [[0, texH], [texW, texH], [texW, 0], [0, 0]];
    let cursor = base * VOXEL_STRIDE_FLOATS;
    for (let i = 0; i < 4; i++) {
      const p = positions[i];
      data[cursor + 0] = p[0];
      data[cursor + 1] = p[1];
      data[cursor + 2] = p[2];
      data[cursor + 3] = tex[i][0];
      data[cursor + 4] = tex[i][1];
      data[cursor + 5] = tileU;
      data[cursor + 6] = tileV;
      data[cursor + 7] = sky;
      data[cursor + 8] = blockLight;
      data[cursor + 9] = shade;
      data[cursor + 10] = flags;
      cursor += VOXEL_STRIDE_FLOATS;
    }
    this.vertexCount += 4;

    this.ensureIndices(6);
    const out = this.indices;
    let ic = this.indexCount;
    out[ic++] = base; out[ic++] = base + 1; out[ic++] = base + 2;
    out[ic++] = base; out[ic++] = base + 2; out[ic++] = base + 3;
    this.indexCount = ic;
    return base;
  }

  ensureIndices(extra) {
    if (this.indexCount + extra <= this.indices.length) return;
    let next = this.indices.length * 2;
    while (next < this.indexCount + extra) next *= 2;
    const grown = new Uint32Array(next);
    grown.set(this.indices.subarray(0, this.indexCount));
    this.indices = grown;
  }

  /**
   * Push an axis-aligned box transformed by a model matrix.
   * @param {Float32Array} matrix column-major model matrix
   * @param {number} tileU atlas cell origin U
   * @param {number} tileV atlas cell origin V
   * @param {number} sky 0..1
   * @param {number} blockLight 0..1
   * @param {number} [aoShade] extra shade multiplier (1 = none)
   */
  addBox(matrix, tileU, tileV, sky, blockLight, aoShade = 1) {
    const corners = _boxCorners;
    for (const face of CUBE_FACES) {
      for (let i = 0; i < 4; i++) {
        const c = face.corners[i];
        const x = c[0], y = c[1], z = c[2];
        corners[i][0] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        corners[i][1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        corners[i][2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      }
      this.addQuad(corners, tileU, tileV, sky, blockLight, face.shade * aoShade, 0);
    }
  }

  /**
   * Push an axis-aligned box with a different atlas tile per face.
   * @param {Float32Array} matrix column-major model matrix
   * @param {Array<{u:number,v:number}>} tiles six entries in FACE order
   *        (east, west, top, bottom, south, north)
   */
  addBoxMulti(matrix, tiles, sky, blockLight, aoShade = 1, flags = 0) {
    const corners = _boxCorners;
    for (let f = 0; f < 6; f++) {
      const face = CUBE_FACES[f];
      for (let i = 0; i < 4; i++) {
        const c = face.corners[i];
        const x = c[0], y = c[1], z = c[2];
        corners[i][0] = matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12];
        corners[i][1] = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
        corners[i][2] = matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14];
      }
      this.addQuad(corners, tiles[f].u, tiles[f].v, sky, blockLight, face.shade * aoShade, flags);
    }
  }

  /**
   * Push a camera-facing billboard quad (particles).
   * @param {number} x @param {number} y @param {number} z centre
   * @param {number} size edge length
   * @param {number[]} right camera right vector
   * @param {number[]} up camera up vector
   */
  addBillboard(x, y, z, size, right, up, tileU, tileV, sky, blockLight, shade) {
    const h = size * 0.5;
    const p = _billboardCorners;
    p[0][0] = x - right[0] * h - up[0] * h;
    p[0][1] = y - right[1] * h - up[1] * h;
    p[0][2] = z - right[2] * h - up[2] * h;
    p[1][0] = x + right[0] * h - up[0] * h;
    p[1][1] = y + right[1] * h - up[1] * h;
    p[1][2] = z + right[2] * h - up[2] * h;
    p[2][0] = x + right[0] * h + up[0] * h;
    p[2][1] = y + right[1] * h + up[1] * h;
    p[2][2] = z + right[2] * h + up[2] * h;
    p[3][0] = x - right[0] * h + up[0] * h;
    p[3][1] = y - right[1] * h + up[1] * h;
    p[3][2] = z - right[2] * h + up[2] * h;
    this.addQuad(p, tileU, tileV, sky, blockLight, shade, 0);
  }

  /** Push a rotated box using position, rotation and size. */
  addTransformedBox(x, y, z, yaw, pitch, roll, sx, sy, sz, tileU, tileV, sky, blockLight, aoShade = 1) {
    mat4Compose(this._matrix, x, y, z, yaw, pitch, roll, sx, sy, sz);
    this.addBox(this._matrix, tileU, tileV, sky, blockLight, aoShade);
  }

  /** Upload the CPU geometry to the GPU. Call once per frame after filling. */
  end() {
    const gl = this.gl;
    if (this.vertexCount === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const needed = this.vertexCount * VOXEL_STRIDE_FLOATS * 4;
    if (needed > this.peakVertices * VOXEL_STRIDE_FLOATS * 4) {
      // Reallocate storage once for a new peak, then reuse it every frame.
      gl.bufferData(gl.ARRAY_BUFFER, Math.max(needed, this.vertices.byteLength), gl.DYNAMIC_DRAW);
      this.peakVertices = this.capacity;
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.vertices, 0, this.vertexCount * VOXEL_STRIDE_FLOATS);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, this.indices, 0, this.indexCount);
  }

  /** Draw the uploaded geometry. Assumes the VOXEL program is bound. */
  draw() {
    if (this.indexCount === 0) return 0;
    const gl = this.gl;
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);
    return this.indexCount / 3;
  }

  /** Release GPU resources. */
  dispose() {
    const gl = this.gl;
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
  }
}
