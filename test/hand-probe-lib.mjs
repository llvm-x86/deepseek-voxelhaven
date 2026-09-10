/**
 * hand-probe-lib.mjs — shared plumbing for the first-person hand probes.
 *
 * Both `probe-hand.mjs` (what does the shipped hand look like?) and
 * `probe-hand-variants.mjs` (which candidate transform looks right?) need the
 * same three things: a frozen simulation, a way to measure the hand's geometry
 * as it is built, and a way to isolate the hand's pixels.
 *
 * The traps documented here were all hit for real, and each produced a
 * confident, wrong measurement before it was found:
 *
 *   - `Renderer.render(camera, env, frame)` takes THREE arguments. Wrapping it
 *     and calling the original as `real(frame)` passes the frame as the camera
 *     and leaves `env` undefined, which throws inside render() and drops the
 *     game into its fatal-error state. Everything measured afterwards describes
 *     a dead game — this is how the first run of this probe reported "0 hand
 *     pixels" and an arm 285 px from where it actually is.
 *   - The held item is drawn with `frame.heldItem.projection`, which is
 *     `camera.projection` — NOT `camera.viewProjection`. The hand is built in
 *     view space and has no view matrix applied. Projecting its vertices with
 *     viewProjection transforms them twice.
 *   - `readPixels` returns the PRESENTED frame, so two reads only differ if two
 *     genuinely different frames were rendered. Mutating mesh data between two
 *     reads of the same frame measures nothing.
 *   - Freezing the input is not enough to freeze the picture: the player still
 *     falls, mobs still walk and chunks still stream. Differencing two frames
 *     without suppressing the update stages produced a 748x539 "hand" — it was
 *     measuring the whole scene drifting.
 *   - buildHeldItem's first statement eases `_heldSwing` toward live input, so a
 *     swing pinned before the call is immediately overwritten.
 */

/** Vertices per box, matching DynamicMesh.addBoxMulti. */
export const VERTS_PER_BOX = 24;

/**
 * The hand layout this project is aiming for, in view space.
 *
 * View space is x right, y up, forward -Z, with the screen edges at ±1. The
 * corner anchor is the point of the whole thing: the fist sits near the
 * bottom-right corner and both the fist and the forearm run off the frame, so
 * they read as attached to the camera rather than floating in the world.
 *
 * Sizes are in view-space units and are deliberately small: apparent size is
 * `size / |z| / (2 tan(fov/2))`, so a 0.16-unit cube at z = -0.95 already covers
 * a quarter of the screen height. The first draft of this layout used a
 * Minecraft-model-sized 0.45 cube, which rendered as 77% of the viewport.
 */
export const HAND_V2 = {
  fist: { x: 0.966, y: -0.469, z: -0.85, yaw: 0.62, pitch: -0.30, roll: 0.10, size: 0.20 },
  forearm: {
    x: 1.056, y: -0.989, z: -0.95, sizeXZ: 0.18, sizeY: 1.10,
    yaw: 0.42, pitch: 0.34, roll: 0.10
  },
  item: { x: 0.850, y: -0.400, z: -0.80, yaw: 0.62, pitch: -0.30, roll: 0.10, size: 0.20 },
  /**
   * The swing is a rigid translation of the whole hand, not a per-part
   * rotation. An earlier version rotated each box about a shoulder pivot, which
   * looked plausible but slid the fist and forearm apart by ~145 px over the
   * swing because a rotation moves boxes at different radii by different
   * amounts. Translating every part by the same delta is what a rigid hand
   * does, and it keeps the two welded together for free.
   */
  swing: { x: -0.036, y: -0.100 }
};

/** Parts of the hand, in the order they are appended to the mesh. */
export const HAND_PARTS = ['forearm', 'fist', 'item'];

/**
 * Resolve a layout into the view-space boxes for a given swing.
 * One function so the probes and the runtime cannot drift apart.
 *
 * @param {typeof HAND_V2} variant
 * @param {number} swing 0..0.35
 */
export function handBoxes(variant, swing) {
  const dx = swing * variant.swing.x;
  const dy = swing * variant.swing.y;

  const box = (part, sx, sy, sz) => ({
    x: part.x + dx, y: part.y + dy, z: part.z,
    yaw: part.yaw, pitch: part.pitch, roll: part.roll,
    sx, sy, sz
  });

  return {
    forearm: box(variant.forearm, variant.forearm.sizeXZ, variant.forearm.sizeY, variant.forearm.sizeXZ),
    fist: box(variant.fist, variant.fist.size, variant.fist.size, variant.fist.size),
    item: box(variant.item, variant.item.size, variant.item.size, variant.item.size)
  };
}

/**
 * Freeze the game's simulation in place.
 *
 * Two shapes need handling: subsystems that expose `update(dt)`, and Game's own
 * methods (`fixedUpdate`, `updateSurvival`) which run simulation directly.
 * `chunkManager` is included because streaming re-meshes chunks as the player
 * settles, which changes pixels between two captures.
 *
 * @param {object} game the live game handle (window.__VOXELHAVEN__)
 */
export function installFreeze(game) {
  const SUBSYSTEMS = ['chunkManager', 'interaction', 'particles', 'timeSystem', 'entityManager'];
  const GAME_METHODS = ['fixedUpdate', 'updateSurvival', 'updateHud'];

  return function freeze(on) {
    for (const key of SUBSYSTEMS) {
      const target = game[key];
      if (!target || typeof target.update !== 'function') continue;
      if (on) {
        if (!target.__realUpdate) {
          target.__realUpdate = target.update.bind(target);
          target.update = () => {};
        }
      } else if (target.__realUpdate) {
        target.update = target.__realUpdate;
        target.__realUpdate = null;
      }
    }
    for (const key of GAME_METHODS) {
      const slot = `__real_${key}`;
      if (on) {
        if (!game[slot]) {
          game[slot] = game[key].bind(game);
          game[key] = () => {};
        }
      } else if (game[slot]) {
        game[key] = game[slot];
        game[slot] = null;
      }
    }
    // updateSpawning is called on the entity manager under its own name, so the
    // generic `update` hook does not cover it.
    const em = game.entityManager;
    if (em) {
      if (on) {
        if (!em.__realSpawn) {
          em.__realSpawn = em.updateSpawning.bind(em);
          em.updateSpawning = () => {};
        }
      } else if (em.__realSpawn) {
        em.updateSpawning = em.__realSpawn;
        em.__realSpawn = null;
      }
    }
    if (on) {
      // Zero the player's motion so nothing drifts if a stage is ever missed.
      game.player.velocityX = 0;
      game.player.velocityY = 0;
      game.player.velocityZ = 0;
      game.player.onGround = true;
      // Park the entities out of frame; a wandering mob would show up as
      // changed pixels that are not the hand.
      game.entityManager.clear();
    }
  };
}

/**
 * Screen-space box for a view-space oriented box, using the game's own
 * projection matrix so the numbers are in the same space as the draw.
 *
 * A box with a corner behind the camera is genuinely visible — the classic
 * "hand smeared across the screen" bug — so corners are clipped against the
 * near plane rather than dropped, which is what the GPU's clipper does. An
 * earlier version skipped corners with w <= 0 and so quietly reported an
 * on-screen box for geometry that was actually partly behind the camera.
 *
 * @param {object} box {x,y,z,yaw,pitch,roll,sx,sy,sz}
 * @param {Float32Array} projection column-major projection matrix
 * @param {number} canvasW
 * @param {number} canvasH
 */
export function boxToScreen(box, projection, canvasW, canvasH) {
  const cy = Math.cos(box.yaw), sy = Math.sin(box.yaw);
  const cp = Math.cos(box.pitch), sp = Math.sin(box.pitch);
  const cr = Math.cos(box.roll), sr = Math.sin(box.roll);
  // R = Ry(yaw) * Rx(pitch) * Rz(roll), matching mat4Compose.
  const m00 = cy * cr + sy * sp * sr, m01 = cp * sr, m02 = -sy * cr + cy * sp * sr;
  const m10 = -cy * sr + sy * sp * cr, m11 = cp * cr, m12 = sy * sr + cy * sp * cr;
  const m20 = sy * cp, m21 = -sp, m22 = cy * cp;

  const hx = box.sx / 2, hy = box.sy / 2, hz = box.sz / 2;
  const corners = [];
  let nearZ = -Infinity, farZ = Infinity;
  for (const ix of [-1, 1]) {
    for (const iy of [-1, 1]) {
      for (const iz of [-1, 1]) {
        const lx = ix * hx, ly = iy * hy, lz = iz * hz;
        const vx = m00 * lx + m10 * ly + m20 * lz + box.x;
        const vy = m01 * lx + m11 * ly + m21 * lz + box.y;
        const vz = m02 * lx + m12 * ly + m22 * lz + box.z;
        corners.push([vx, vy, vz]);
        if (vz > nearZ) nearZ = vz;
        if (vz < farZ) farZ = vz;
      }
    }
  }

  // Project each corner, clipping edges that cross the near plane (w = -z = 0).
  const poly = [];
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % corners.length];
    const aIn = -a[2] > 1e-6;
    const bIn = -b[2] > 1e-6;
    if (aIn) poly.push(project(a, projection));
    if (aIn !== bIn) {
      const t = (-1e-6 - a[2]) / (b[2] - a[2]);
      const c = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      poly.push(project(c, projection));
    }
  }
  if (!poly.length) return null;

  // Projected coordinates are in NDC; convert once, here, to canvas pixels.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of poly) {
    const px = (p.x * 0.5 + 0.5) * canvasW;
    const py = (0.5 - p.y * 0.5) * canvasH;
    if (px < minX) minX = px; if (px > maxX) maxX = px;
    if (py < minY) minY = py; if (py > maxY) maxY = py;
  }
  return {
    left: +minX.toFixed(1), top: +minY.toFixed(1),
    right: +maxX.toFixed(1), bottom: +maxY.toFixed(1),
    w: +(maxX - minX).toFixed(1), h: +(maxY - minY).toFixed(1),
    // Distance to the screen edge; NEGATIVE means the box runs off that edge.
    insetRight: +(canvasW - maxX).toFixed(1),
    insetBottom: +(canvasH - maxY).toFixed(1),
    nearZ: +nearZ.toFixed(3),
    farZ: +farZ.toFixed(3),
    // A box this close would smear across the screen; the shipped near plane is
    // 0.06, so anything at or beyond it is a real defect rather than a close-up.
    crossesNearPlane: nearZ > -0.06
  };
}

/** Project a view-space point through a column-major projection matrix. */
function project(p, m) {
  const cx = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
  const cy = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
  const cw = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
  return { x: cx / cw, y: cy / cw };
}
