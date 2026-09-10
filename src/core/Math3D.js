/**
 * Math3D.js — minimal, allocation-conscious linear algebra for the renderer.
 *
 * Matrices are column-major Float32Array(16), matching WebGL's expectations,
 * so they can be handed to uniformMatrix4fv without transposition.
 */

export const DEG2RAD = Math.PI / 180;

/** Clamp a number to [min,max]. */
export function clamp(v, min, max) {
  return v < min ? min : v > max ? max : v;
}

/** Linear interpolation, unclamped. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Create a new identity matrix. */
export function mat4Identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

/**
 * Build a right-handed perspective projection with a [-1,1] depth range.
 * @param {Float32Array} out
 * @param {number} fovYRadians
 * @param {number} aspect
 * @param {number} near
 * @param {number} far
 */
export function mat4Perspective(out, fovYRadians, aspect, near, far) {
  const f = 1.0 / Math.tan(fovYRadians / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

/**
 * Build a view matrix from an eye position and yaw/pitch (radians).
 * yaw 0 looks down -Z; positive yaw turns left (counter-clockwise seen from above).
 * pitch is positive looking up.
 */
export function mat4ViewFromEuler(out, eyeX, eyeY, eyeZ, yaw, pitch, roll = 0) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // Camera basis: right, up, forward (forward points where the camera looks).
  const fx = -sy * cp;
  const fy = sp;
  const fz = -cy * cp;

  let rx = cy;
  const ry = 0;
  let rz = -sy;

  // up = cross(right, forward), which evaluates to +Y when pitch is zero.
  let ux = ry * fz - rz * fy;
  let uy = rz * fx - rx * fz;
  let uz = rx * fy - ry * fx;

  // Optional roll (view bob): rotate right/up about the forward axis.
  if (roll !== 0) {
    const cr = Math.cos(roll);
    const sr = Math.sin(roll);
    const nrx = rx * cr + ux * sr;
    const nry = ry * cr + uy * sr;
    const nrz = rz * cr + uz * sr;
    const nux = ux * cr - rx * sr;
    const nuy = uy * cr - ry * sr;
    const nuz = uz * cr - rz * sr;
    rx = nrx; ux = nux;
    rz = nrz; uz = nuz;
    void nry; void nuy;
  }

  out[0] = rx; out[1] = ux; out[2] = -fx; out[3] = 0;
  out[4] = ry; out[5] = uy; out[6] = -fy; out[7] = 0;
  out[8] = rz; out[9] = uz; out[10] = -fz; out[11] = 0;
  out[12] = -(rx * eyeX + ry * eyeY + rz * eyeZ);
  out[13] = -(ux * eyeX + uy * eyeY + uz * eyeZ);
  out[14] = fx * eyeX + fy * eyeY + fz * eyeZ;
  out[15] = 1;
  return out;
}

/**
 * Forward direction vector for a yaw/pitch pair.
 * @returns {{x:number,y:number,z:number}}
 */
export function eulerForward(yaw, pitch) {
  const cp = Math.cos(pitch);
  return { x: -Math.sin(yaw) * cp, y: Math.sin(pitch), z: -Math.cos(yaw) * cp };
}

/** out = a * b (both column-major). Safe when out aliases a or b. */
export function mat4Multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

/**
 * Build a translation+rotation+scale model matrix (YXZ rotation order,
 * matching the entity yaw/pitch convention).
 */
export function mat4Compose(out, x, y, z, yaw, pitch, roll, sx, sy, sz) {
  const cy = Math.cos(yaw), sy_ = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);

  // R = Ry(yaw) * Rx(pitch) * Rz(roll)
  const m00 = cy * cr + sy_ * sp * sr;
  const m01 = cp * sr;
  const m02 = -sy_ * cr + cy * sp * sr;

  const m10 = -cy * sr + sy_ * sp * cr;
  const m11 = cp * cr;
  const m12 = sy_ * sr + cy * sp * cr;

  const m20 = sy_ * cp;
  const m21 = -sp;
  const m22 = cy * cp;

  out[0] = m00 * sx; out[1] = m01 * sx; out[2] = m02 * sx; out[3] = 0;
  out[4] = m10 * sy; out[5] = m11 * sy; out[6] = m12 * sy; out[7] = 0;
  out[8] = m20 * sz; out[9] = m21 * sz; out[10] = m22 * sz; out[11] = 0;
  out[12] = x; out[13] = y; out[14] = z; out[15] = 1;
  return out;
}

/**
 * Extract the six frustum planes (ax+by+cz+d=0, normals pointing inward) from a
 * view-projection matrix for chunk culling.
 * @param {Float32Array} m view-projection matrix (column-major)
 * @param {Float32Array} outPlanes 24 floats: 6 planes of 4 components
 */
export function extractFrustumPlanes(m, outPlanes) {
  // Row-major access helpers: element (row r, col c) is m[c*4 + r].
  const m0 = m[0], m4 = m[4], m8 = m[8], m12 = m[12];
  const m1 = m[1], m5 = m[5], m9 = m[9], m13 = m[13];
  const m2 = m[2], m6 = m[6], m10 = m[10], m14 = m[14];
  const m3 = m[3], m7 = m[7], m11 = m[11], m15 = m[15];

  const planes = [
    [m3 + m0, m7 + m4, m11 + m8, m15 + m12],   // left
    [m3 - m0, m7 - m4, m11 - m8, m15 - m12],   // right
    [m3 + m1, m7 + m5, m11 + m9, m15 + m13],   // bottom
    [m3 - m1, m7 - m5, m11 - m9, m15 - m13],   // top
    [m3 + m2, m7 + m6, m11 + m10, m15 + m14],  // near
    [m3 - m2, m7 - m6, m11 - m10, m15 - m14]   // far
  ];

  for (let i = 0; i < 6; i++) {
    const p = planes[i];
    const len = Math.hypot(p[0], p[1], p[2]) || 1;
    outPlanes[i * 4] = p[0] / len;
    outPlanes[i * 4 + 1] = p[1] / len;
    outPlanes[i * 4 + 2] = p[2] / len;
    outPlanes[i * 4 + 3] = p[3] / len;
  }
  return outPlanes;
}

/**
 * Conservative axis-aligned box vs frustum test.
 * @param {Float32Array} planes 24 floats from extractFrustumPlanes
 * @param {number} minX @param {number} minY @param {number} minZ
 * @param {number} maxX @param {number} maxY @param {number} maxZ
 * @returns {boolean} true when the box is at least partially inside
 */
export function aabbInFrustum(planes, minX, minY, minZ, maxX, maxY, maxZ) {
  for (let i = 0; i < 6; i++) {
    const a = planes[i * 4];
    const b = planes[i * 4 + 1];
    const c = planes[i * 4 + 2];
    const d = planes[i * 4 + 3];
    // Test the box corner furthest along the plane normal; if even that corner
    // is behind the plane, the whole box is outside.
    const px = a >= 0 ? maxX : minX;
    const py = b >= 0 ? maxY : minY;
    const pz = c >= 0 ? maxZ : minZ;
    if (a * px + b * py + c * pz + d < 0) return false;
  }
  return true;
}
