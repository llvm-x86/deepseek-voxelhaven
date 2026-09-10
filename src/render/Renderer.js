/**
 * Renderer.js — owns the WebGL2 context and draws one frame.
 *
 * Frame order
 *   1. Sky (depth test off, covers the whole viewport)
 *   2. Opaque chunk pass
 *   3. Dynamic opaque geometry: mobs, dropped items
 *   4. Particles (alpha tested)
 *   5. Translucent chunk pass (water, glass) — sorted back to front
 *   6. Held item, drawn last with a tight projection so it never clips walls
 *   7. Block selection outline
 *
 * All world geometry shares one shader program and one texture atlas, so the
 * entire visible world is drawn with a handful of draw calls.
 */

import { TextureAtlas } from './TextureAtlas.js';
import { ChunkRenderer } from './ChunkRenderer.js';
import { SkyRenderer } from './SkyRenderer.js';
import { HighlightRenderer } from './HighlightRenderer.js';
import { DynamicMesh } from './DynamicMesh.js';
import { createShaderProgram, resizeCanvasToDisplaySize, checkGLError } from './GLUtils.js';
import { VOXEL_VERT, VOXEL_FRAG } from './Shaders.js';
import { RENDER } from '../core/Config.js';

export class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      // Kept true so the F2 screenshot key and the automated tests can read the
      // canvas back after the frame has been presented. The cost is negligible
      // on every browser Voxelhaven targets.
      preserveDrawingBuffer: true,
      premultipliedAlpha: false
    });
    if (!gl) {
      throw new Error(
        'WebGL2 is not available in this browser. Voxelhaven needs WebGL2 ' +
        '(Chrome, Edge, Firefox or Safari 15+).'
      );
    }
    this.gl = gl;
    this.width = 1;
    this.height = 1;
    this.contextLost = false;

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
      console.error('[Renderer] WebGL context lost');
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      console.warn('[Renderer] WebGL context restored — reload the world to rebuild GPU state');
    });

    // ---- Atlas ------------------------------------------------------------
    this.atlas = new TextureAtlas().generate();
    this.atlas.upload(gl);

    // ---- Programs ---------------------------------------------------------
    const voxel = createShaderProgram(gl, VOXEL_VERT, VOXEL_FRAG, 'voxel');
    this.voxelProgram = voxel.program;
    this.voxelUniforms = voxel.uniforms;

    this.chunkRenderer = new ChunkRenderer(gl);
    this.skyRenderer = new SkyRenderer(gl);
    this.highlightRenderer = new HighlightRenderer(gl);

    // ---- Dynamic meshes ---------------------------------------------------
    this.entityMesh = new DynamicMesh(gl, 8192);
    this.particleMesh = new DynamicMesh(gl, 4096);
    this.heldItemMesh = new DynamicMesh(gl, 64);
    this.overlayMesh = new DynamicMesh(gl, 512);
    this.heldItemProjection = new Float32Array(16);

    // ---- Static GL state --------------------------------------------------
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clearColor(0.55, 0.72, 0.92, 1.0);

    /** Diagnostics. */
    this.stats = { drawCalls: 0, triangles: 0, entityTriangles: 0, particleTriangles: 0 };
  }

  /** Resize the drawing buffer to match the CSS size and pixel ratio. */
  resize() {
    const { width, height, changed } = resizeCanvasToDisplaySize(this.canvas, RENDER.maxPixelRatio);
    this.width = width;
    this.height = height;
    return changed;
  }

  /** Aspect ratio of the drawing buffer. */
  get aspect() {
    return this.height > 0 ? this.width / this.height : 1;
  }

  /**
   * Apply the shared VOXEL uniforms for this frame.
   * @param {object} env environment state from TimeSystem
   * @param {object} options { alphaCutoff, fogNear, fogFar, fogColor, tint, tintAmount, model, cull }
   */
  applyVoxelState(env, options = {}) {
    const gl = this.gl;
    const u = this.voxelUniforms;
    gl.useProgram(this.voxelProgram);
    gl.uniform1i(u.uAtlas, 0);
    gl.uniform1f(u.uCell, 1 / RENDER.atlasGrid);
    // Half a texel of inset, expressed in tile units, keeps linear filtering
    // inside the current atlas cell.
    gl.uniform1f(u.uInset, 0.5 / RENDER.tileSize);
    gl.uniform1f(u.uDayBrightness, env.dayBrightness);
    gl.uniform3fv(u.uSkyColor, env.skyLightColor);
    gl.uniform3fv(u.uBlockColor, env.blockLightColor);
    gl.uniform1f(u.uMinAmbient, env.minAmbient);
    gl.uniform3fv(u.uFogColor, options.fogColor || env.fogColor);
    gl.uniform1f(u.uFogNear, options.fogNear !== undefined ? options.fogNear : env.fogNear);
    gl.uniform1f(u.uFogFar, options.fogFar !== undefined ? options.fogFar : env.fogFar);
    gl.uniform1f(u.uAlphaCutoff, options.alphaCutoff !== undefined ? options.alphaCutoff : 0.5);
    gl.uniform1f(u.uTime, env.timeSeconds || 0);
    gl.uniform3f(u.uTint, 1, 1, 1);
    gl.uniform1f(u.uTintAmount, options.tintAmount || 0);
    gl.uniformMatrix4fv(u.uModel, false, options.model || IDENTITY);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.atlas.texture);
  }

  /**
   * Draw the whole world.
   * @param {import('../player/Camera.js').Camera} camera
   * @param {object} env
   * @param {object} frame extra geometry providers
   * @param {object} frame.entities DynamicMesh already filled and ended
   * @param {object} frame.particles DynamicMesh already filled and ended
   * @param {{x:number,y:number,z:number}|null} frame.highlight
   * @param {number} frame.breakProgress
   * @param {{mesh:DynamicMesh, projection:Float32Array}|null} frame.heldItem
   * @param {number} frame.underwater 0..1 how submerged the camera is
   */
  render(camera, env, frame) {
    if (this.contextLost) return;
    const gl = this.gl;
    this.stats.drawCalls = 0;
    this.stats.triangles = 0;

    gl.viewport(0, 0, this.width, this.height);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // Fog can be overridden per frame (underwater uses a much shorter range and
    // a blue tint); otherwise it comes from the day/night environment.
    const fogOptions = {
      fogColor: frame.fogColor || env.fogColor,
      fogNear: frame.fogNear !== undefined ? frame.fogNear : env.fogNear,
      fogFar: frame.fogFar !== undefined ? frame.fogFar : env.fogFar
    };

    // ---- Sky --------------------------------------------------------------
    this.skyRenderer.draw(camera, env, env.timeSeconds || 0);
    this.stats.drawCalls++;

    // ---- Opaque world -----------------------------------------------------
    this.applyVoxelState(env, { alphaCutoff: 0.5, ...fogOptions });
    gl.uniformMatrix4fv(this.voxelUniforms.uViewProj, false, camera.viewProjection);
    gl.disable(gl.BLEND);
    this.chunkRenderer.drawOpaque(camera);
    this.stats.triangles = this.chunkRenderer.stats.triangles;
    this.stats.drawCalls += this.chunkRenderer.stats.opaqueDrawn;

    // ---- Mobs and dropped items ------------------------------------------
    if (frame.entities && frame.entities.indexCount > 0) {
      frame.entities.end();
      this.stats.entityTriangles = frame.entities.draw();
      this.stats.drawCalls++;
    }
    // ---- Particles --------------------------------------------------------
    if (frame.particles && frame.particles.indexCount > 0) {
      frame.particles.end();
      this.stats.particleTriangles = frame.particles.draw();
      this.stats.drawCalls++;
    }

    // ---- Translucent world -----------------------------------------------
    // Blending is enabled here; the chunk renderer already re-sorted its
    // translucent meshes and turned depth writes off for that pass.
    this.applyVoxelState(env, { alphaCutoff: 0.0, ...fogOptions });
    gl.uniformMatrix4fv(this.voxelUniforms.uViewProj, false, camera.viewProjection);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Underwater: tint everything that is drawn behind the water plane.
    if (frame.underwater > 0.01) {
      gl.uniform3f(this.voxelUniforms.uTint, 0.32, 0.62, 0.95);
      gl.uniform1f(this.voxelUniforms.uTintAmount, frame.underwater * 0.75);
    }

    this.chunkRenderer.drawTransparent(camera);
    this.stats.triangles += this.chunkRenderer.stats.triangles;
    this.stats.drawCalls += this.chunkRenderer.stats.transparentDrawn;

    // ---- Held item --------------------------------------------------------
    if (frame.heldItem && frame.heldItem.mesh.indexCount > 0) {
      this.applyVoxelState(env, { alphaCutoff: 0.5 });
      gl.disable(gl.BLEND);
      // Clear the depth buffer so the held item is never clipped by geometry
      // the camera happens to be inside.
      gl.clear(gl.DEPTH_BUFFER_BIT);
      frame.heldItem.mesh.end();
      gl.uniformMatrix4fv(this.voxelUniforms.uViewProj, false, frame.heldItem.projection);
      this.stats.drawCalls++;
      this.stats.triangles += frame.heldItem.mesh.draw();
    }

    // ---- Block outline ----------------------------------------------------
    gl.disable(gl.BLEND);
    this.highlightRenderer.draw(camera, frame.highlight, frame.breakProgress);
    this.stats.drawCalls++;

    gl.bindVertexArray(null);
    checkGLError(gl, 'Renderer.render');
  }

  /** Drop all chunk meshes (used when unloading a world). */
  clearWorld() {
    this.chunkRenderer.clear();
  }

  /** Release everything. */
  dispose() {
    this.chunkRenderer.clear();
    this.skyRenderer.dispose();
    this.highlightRenderer.dispose();
    this.entityMesh.dispose();
    this.particleMesh.dispose();
    this.heldItemMesh.dispose();
    this.overlayMesh.dispose();
    this.atlas.dispose(this.gl);
    this.gl.deleteProgram(this.voxelProgram);
  }
}

/** Shared identity matrix for uniforms that are not transformed. */
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
