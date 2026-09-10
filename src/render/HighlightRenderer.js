/**
 * HighlightRenderer.js — the wireframe box around the targeted block and the
 * break-progress box that shrinks as the block is destroyed.
 *
 * Both are drawn as GL_LINES from one shared unit-cube edge buffer, scaled and
 * translated by a per-block model matrix. Slight inflation avoids z-fighting
 * with the block surface.
 */

import { createShaderProgram, createMeshVAO } from './GLUtils.js';
import { LINE_VERT, LINE_FRAG } from './Shaders.js';
import { mat4Compose } from '../core/Math3D.js';

/** Unit cube edges as 12 line segments (24 vertices). */
function buildCubeEdges() {
  const c = [
    [0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1],
    [0, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 1]
  ];
  const edges = [
    [0, 1], [1, 2], [2, 3], [3, 0], // bottom
    [4, 5], [5, 6], [6, 7], [7, 4], // top
    [0, 4], [1, 5], [2, 6], [3, 7]  // verticals
  ];
  const data = new Float32Array(edges.length * 2 * 3);
  let i = 0;
  for (const [a, b] of edges) {
    data[i++] = c[a][0]; data[i++] = c[a][1]; data[i++] = c[a][2];
    data[i++] = c[b][0]; data[i++] = c[b][1]; data[i++] = c[b][2];
  }
  return data;
}

export class HighlightRenderer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    const { program, uniforms } = createShaderProgram(gl, LINE_VERT, LINE_FRAG, 'line');
    this.program = program;
    this.uniforms = uniforms;
    this.mesh = createMeshVAO(gl, [{ location: 0, size: 3, offsetFloats: 0 }], 3, buildCubeEdges(), null);
    this._matrix = new Float32Array(16);
  }

  /**
   * @param {import('../player/Camera.js').Camera} camera
   * @param {{x:number,y:number,z:number}|null} hit targeted block, or null
   * @param {number} breakProgress 0..1 progress towards destroying the block
   */
  draw(camera, hit, breakProgress = 0) {
    if (!hit) return;
    const gl = this.gl;
    const u = this.uniforms;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uViewProj, false, camera.viewProjection);

    // The outline is inflated a hair so it does not z-fight with the block.
    const inflate = 1.004;
    const offset = -(inflate - 1) * 0.5;
    // As the block breaks, a second, shrinking box appears inside the outline.
    const shrink = breakProgress > 0 ? breakProgress * 0.35 : 0;
    const scale = inflate - shrink;
    const centre = offset + shrink * 0.5;
    mat4Compose(this._matrix, hit.x + centre, hit.y + centre, hit.z + centre, 0, 0, 0, scale, scale, scale);
    gl.uniformMatrix4fv(u.uModel, false, this._matrix);
    if (breakProgress > 0) {
      // Blend towards white as the block nears destruction.
      const t = breakProgress;
      gl.uniform4f(u.uColor, 1.0, 1.0 - t * 0.45, 1.0 - t * 0.65, 0.95);
    } else {
      gl.uniform4f(u.uColor, 0.06, 0.06, 0.07, 0.85);
    }

    gl.bindVertexArray(this.mesh.vao);
    gl.drawArrays(gl.LINES, 0, 24);
    gl.bindVertexArray(null);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.mesh.vao);
    gl.deleteBuffer(this.mesh.vbo);
  }
}
