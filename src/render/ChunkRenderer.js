/**
 * ChunkRenderer.js — owns the GPU geometry for every loaded chunk.
 *
 * Each chunk owns up to two meshes: an opaque one (terrain, wood, leaves) and a
 * translucent one (water, glass). They are drawn in separate passes so water
 * blends correctly against the terrain behind it.
 *
 * Meshes are keyed by the chunk's "cx,cz" name. The renderer never generates
 * anything itself: ChunkManager hands it finished vertex data.
 */

import { createMeshVAO } from './GLUtils.js';
import { VOXEL_ATTRIBUTES, VOXEL_STRIDE_FLOATS } from './Shaders.js';
import { aabbInFrustum } from '../core/Math3D.js';
import { CHUNK_SIZE, WORLD_HEIGHT } from '../core/Config.js';

export class ChunkRenderer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    /** @type {Map<string, {opaque:object|null, transparent:object|null, cx:number, cz:number, minX:number,minZ:number}>} */
    this.meshes = new Map();
    /** Diagnostics for the debug overlay. */
    this.stats = { meshes: 0, opaqueDrawn: 0, transparentDrawn: 0, triangles: 0, gpuBytes: 0 };
    /** Reused array for distance sorting without allocating per frame. */
    this._transparentOrder = [];
  }

  /**
   * Upload (or replace) the geometry for a chunk.
   * @param {string} key chunk name "cx,cz"
   * @param {number} cx
   * @param {number} cz
   * @param {{opaque:object|null, transparent:object|null}} data
   */
  upload(key, cx, cz, data) {
    const gl = this.gl;
    this.remove(key);

    const entry = {
      opaque: null,
      transparent: null,
      cx,
      cz,
      // World-space AABB used for frustum culling.
      minX: cx * CHUNK_SIZE,
      minZ: cz * CHUNK_SIZE,
      maxX: cx * CHUNK_SIZE + CHUNK_SIZE,
      maxZ: cz * CHUNK_SIZE + CHUNK_SIZE,
      minY: 0,
      maxY: WORLD_HEIGHT
    };

    let bytes = 0;
    if (data.opaque) {
      entry.opaque = createMeshVAO(gl, VOXEL_ATTRIBUTES, VOXEL_STRIDE_FLOATS, data.opaque.vertices, data.opaque.indices);
      bytes += data.opaque.vertices.byteLength + data.opaque.indices.byteLength;
    }
    if (data.transparent) {
      entry.transparent = createMeshVAO(gl, VOXEL_ATTRIBUTES, VOXEL_STRIDE_FLOATS, data.transparent.vertices, data.transparent.indices);
      bytes += data.transparent.vertices.byteLength + data.transparent.indices.byteLength;
    }
    entry.gpuBytes = bytes;
    this.meshes.set(key, entry);
    this.stats.meshes = this.meshes.size;
    // Recompute total GPU memory lazily; it is only shown in the debug overlay.
    this.stats.gpuBytes += bytes;
  }

  /** Free the GPU buffers of one chunk. */
  remove(key) {
    const gl = this.gl;
    const entry = this.meshes.get(key);
    if (!entry) return;
    for (const mesh of [entry.opaque, entry.transparent]) {
      if (!mesh) continue;
      gl.deleteVertexArray(mesh.vao);
      gl.deleteBuffer(mesh.vbo);
      if (mesh.ibo) gl.deleteBuffer(mesh.ibo);
    }
    this.stats.gpuBytes -= entry.gpuBytes || 0;
    this.meshes.delete(key);
    this.stats.meshes = this.meshes.size;
  }

  /** True when a mesh exists for this chunk. */
  has(key) {
    return this.meshes.has(key);
  }

  /** Drop every mesh (used when leaving a world). */
  clear() {
    for (const key of Array.from(this.meshes.keys())) this.remove(key);
    this.stats.gpuBytes = 0;
    this.stats.meshes = 0;
  }

  /**
   * Draw every visible opaque chunk mesh.
   * @param {import('../player/Camera.js').Camera} camera
   */
  drawOpaque(camera) {
    const gl = this.gl;
    const planes = camera.frustumPlanes;
    this.stats.opaqueDrawn = 0;
    this.stats.triangles = 0;

    for (const entry of this.meshes.values()) {
      if (!entry.opaque) continue;
      if (!aabbInFrustum(planes, entry.minX, entry.minY, entry.minZ, entry.maxX, entry.maxY, entry.maxZ)) continue;
      gl.bindVertexArray(entry.opaque.vao);
      gl.drawElements(gl.TRIANGLES, entry.opaque.indexCount, gl.UNSIGNED_INT, 0);
      this.stats.opaqueDrawn++;
      this.stats.triangles += entry.opaque.indexCount / 3;
    }
    gl.bindVertexArray(null);
  }

  /**
   * Draw every visible translucent chunk mesh, sorted back to front.
   *
   * Depth writes are disabled for this pass so overlapping water surfaces do
   * not occlude one another; depth *testing* stays on so terrain still hides
   * the water behind it.
   * @param {import('../player/Camera.js').Camera} camera
   */
  drawTransparent(camera) {
    const gl = this.gl;
    const planes = camera.frustumPlanes;
    const camX = camera.x;
    const camZ = camera.z;
    this.stats.transparentDrawn = 0;

    const order = this._transparentOrder;
    order.length = 0;
    for (const entry of this.meshes.values()) {
      if (!entry.transparent) continue;
      if (!aabbInFrustum(planes, entry.minX, entry.minY, entry.minZ, entry.maxX, entry.maxY, entry.maxZ)) continue;
      const dx = entry.minX + CHUNK_SIZE * 0.5 - camX;
      const dz = entry.minZ + CHUNK_SIZE * 0.5 - camZ;
      order.push({ entry, distance: dx * dx + dz * dz });
    }
    order.sort((a, b) => b.distance - a.distance);

    gl.depthMask(false);
    for (const item of order) {
      const mesh = item.entry.transparent;
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.indexCount, gl.UNSIGNED_INT, 0);
      this.stats.transparentDrawn++;
      this.stats.triangles += mesh.indexCount / 3;
    }
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }
}
