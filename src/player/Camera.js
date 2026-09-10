/**
 * Camera.js — the first-person camera.
 *
 * Owns the projection and view matrices plus the derived products the renderer
 * and the interaction raycast need. Keeping the matrices here (rather than in
 * the renderer) means the raycast always uses exactly the orientation the
 * player sees.
 */

import {
  mat4Identity, mat4Perspective, mat4ViewFromEuler, mat4Multiply,
  extractFrustumPlanes, DEG2RAD, clamp
} from '../core/Math3D.js';
import { RENDER } from '../core/Config.js';

/** Maximum pitch in radians, just shy of straight up/down. */
const MAX_PITCH = Math.PI / 2 - 0.001;

export class Camera {
  constructor() {
    /** Eye position in world space. */
    this.x = 0;
    this.y = 0;
    this.z = 0;
    /** Horizontal rotation in radians; 0 looks towards -Z. */
    this.yaw = 0;
    /** Vertical rotation in radians; positive looks up. */
    this.pitch = 0;
    /** Roll in radians, used for the subtle view bob while walking. */
    this.roll = 0;
    /** Vertical field of view in degrees (before any sprint boost). */
    this.fov = RENDER.fov;
    /** Current animated field of view, which chases `fov`. */
    this.currentFov = RENDER.fov;
    /** Aspect ratio, refreshed every frame by the renderer. */
    this.aspect = 1;

    this.view = mat4Identity(new Float32Array(16));
    this.projection = mat4Identity(new Float32Array(16));
    this.viewProjection = mat4Identity(new Float32Array(16));
    this.invViewProjection = mat4Identity(new Float32Array(16));
    /** Six frustum planes, filled by update(). */
    this.frustumPlanes = new Float32Array(24);

    /** Scratch matrix used while inverting; avoids per-frame allocation. */
    this._tmp = new Float32Array(16);
  }

  /** Set the camera position directly. */
  setPosition(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }

  /** Apply a mouse delta (already scaled) to the camera orientation. */
  rotate(deltaYaw, deltaPitch) {
    this.yaw += deltaYaw;
    this.pitch = clamp(this.pitch + deltaPitch, -MAX_PITCH, MAX_PITCH);
    // Keep yaw in a sane range so floating point precision stays high.
    if (this.yaw > Math.PI * 4) this.yaw -= Math.PI * 4;
    else if (this.yaw < -Math.PI * 4) this.yaw += Math.PI * 4;
  }

  /** Unit vector the camera is looking along. */
  forward() {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  /** Unit vector pointing to the camera's right. */
  right() {
    return { x: Math.cos(this.yaw), y: 0, z: -Math.sin(this.yaw) };
  }

  /** Unit vector pointing up relative to the camera. */
  up() {
    const f = this.forward();
    const r = this.right();
    return {
      x: r.y * f.z - r.z * f.y,
      y: r.z * f.x - r.x * f.z,
      z: r.x * f.y - r.y * f.x
    };
  }

  /**
   * Refresh the matrices. Must be called once per frame before rendering or
   * raycasting.
   * @param {number} aspect width / height
   */
  update(aspect) {
    this.aspect = aspect > 0 ? aspect : 1;
    mat4Perspective(this.projection, this.currentFov * DEG2RAD, this.aspect, RENDER.near, RENDER.far);
    mat4ViewFromEuler(this.view, this.x, this.y, this.z, this.yaw, this.pitch, this.roll);
    mat4Multiply(this.viewProjection, this.projection, this.view);
    invert(this.invViewProjection, this.viewProjection);
    extractFrustumPlanes(this.viewProjection, this.frustumPlanes);
  }
}

/**
 * General 4x4 matrix inverse (column-major). Returns the identity when the
 * matrix is singular, which keeps the sky pass from producing NaNs.
 * @param {Float32Array} out
 * @param {Float32Array} m
 */
export function invert(out, m) {
  const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
  const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
  const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
  const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (Math.abs(det) < 1e-12) {
    mat4Identity(out);
    return out;
  }
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}
