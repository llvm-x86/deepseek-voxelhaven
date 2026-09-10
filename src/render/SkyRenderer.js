/**
 * SkyRenderer.js — the sky, sun, moon, stars and clouds.
 *
 * Drawn first, with depth testing disabled, as a single full-screen triangle.
 * The fragment shader reconstructs a view ray per pixel from the inverse
 * view-projection matrix, so the sky is correct for any camera orientation
 * without needing a dome mesh.
 */

import { createShaderProgram, createMeshVAO } from './GLUtils.js';
import { SKY_VERT, SKY_FRAG } from './Shaders.js';

export class SkyRenderer {
  /** @param {WebGL2RenderingContext} gl */
  constructor(gl) {
    this.gl = gl;
    const { program, uniforms } = createShaderProgram(gl, SKY_VERT, SKY_FRAG, 'sky');
    this.program = program;
    this.uniforms = uniforms;

    // One oversized triangle covers the viewport with fewer vertices than a quad.
    const vertices = new Float32Array([-1, -1, 3, -1, -1, 3]);
    this.mesh = createMeshVAO(gl, [{ location: 0, size: 2, offsetFloats: 0 }], 2, vertices, null);
  }

  /**
   * @param {import('../player/Camera.js').Camera} camera
   * @param {object} env environment state from TimeSystem.getEnvironment()
   * @param {number} timeSeconds total elapsed seconds (drives cloud drift)
   */
  draw(camera, env, timeSeconds) {
    const gl = this.gl;
    const u = this.uniforms;

    gl.useProgram(this.program);
    gl.uniformMatrix4fv(u.uInvViewProj, false, camera.invViewProjection);
    gl.uniform3f(u.uCameraPos, camera.x, camera.y, camera.z);
    gl.uniform3fv(u.uSkyTop, env.skyTop);
    gl.uniform3fv(u.uSkyHorizon, env.skyHorizon);
    gl.uniform3fv(u.uSunColor, env.sunColor);
    gl.uniform3fv(u.uSunDir, env.sunDirection);
    gl.uniform3fv(u.uCloudColor, env.cloudColor);
    gl.uniform1f(u.uDayBrightness, env.dayBrightness);
    gl.uniform1f(u.uStarAmount, env.starAmount);
    gl.uniform1f(u.uTime, timeSeconds);
    gl.uniform1f(u.uCloudHeight, 118.0);
    gl.uniform1f(u.uFogFar, env.fogFar);

    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    // The sky is not a solid object: make sure it is never culled.
    gl.disable(gl.CULL_FACE);
    gl.bindVertexArray(this.mesh.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
  }

  dispose() {
    const gl = this.gl;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.mesh.vao);
    gl.deleteBuffer(this.mesh.vbo);
  }
}
