/**
 * Physics.js — axis-aligned bounding box collision against the voxel grid.
 *
 * Used by both the player and every mob, so the rules are identical: an entity
 * is a box, the world is a grid of unit cubes, and movement is resolved one
 * axis at a time. Resolving per axis (rather than as a single swept vector) is
 * what produces the familiar "slide along the wall" behaviour.
 */

import { PLAYER } from '../core/Config.js';

/** Tolerance used so a box resting exactly on a block face does not overlap it. */
const EPSILON = 1e-4;

/** Maximum distance moved per collision substep, in blocks. */
const MAX_SUBSTEP = 0.2;

/**
 * Does an axis-aligned box overlap any solid voxel?
 *
 * @param {import('../world/World.js').World} world
 * @param {number} x centre X
 * @param {number} y bottom Y
 * @param {number} z centre Z
 * @param {number} halfWidth half extent along X and Z
 * @param {number} height extent along Y
 * @returns {boolean}
 */
export function boxIntersectsWorld(world, x, y, z, halfWidth, height) {
  const minX = Math.floor(x - halfWidth + EPSILON);
  const maxX = Math.floor(x + halfWidth - EPSILON);
  const minY = Math.floor(y + EPSILON);
  const maxY = Math.floor(y + height - EPSILON);
  const minZ = Math.floor(z - halfWidth + EPSILON);
  const maxZ = Math.floor(z + halfWidth - EPSILON);

  for (let by = minY; by <= maxY; by++) {
    for (let bz = minZ; bz <= maxZ; bz++) {
      for (let bx = minX; bx <= maxX; bx++) {
        if (world.isSolid(bx, by, bz)) return true;
      }
    }
  }
  return false;
}

/**
 * Move a box through the world, stopping at solid blocks.
 *
 * The motion is split into substeps no larger than MAX_SUBSTEP so that a fast
 * moving entity can never tunnel through a one-block-thick wall.
 *
 * @param {import('../world/World.js').World} world
 * @param {number} x start centre X
 * @param {number} y start bottom Y
 * @param {number} z start centre Z
 * @param {number} halfWidth
 * @param {number} height
 * @param {number} dx desired movement X
 * @param {number} dy desired movement Y
 * @param {number} dz desired movement Z
 * @returns {{x:number, y:number, z:number, hitX:boolean, hitY:boolean, hitZ:boolean}}
 */
export function moveBox(world, x, y, z, halfWidth, height, dx, dy, dz) {
  const out = { x, y, z, hitX: false, hitY: false, hitZ: false };

  const largest = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz));
  const steps = Math.max(1, Math.ceil(largest / MAX_SUBSTEP));
  const stepX = dx / steps;
  const stepY = dy / steps;
  const stepZ = dz / steps;

  for (let i = 0; i < steps; i++) {
    // Vertical first: landing before sliding along the floor avoids the box
    // catching on the lip of the block it is standing on.
    if (stepY !== 0) {
      out.y += stepY;
      if (boxIntersectsWorld(world, out.x, out.y, out.z, halfWidth, height)) {
        out.y -= stepY;
        out.hitY = true;
      }
    }
    if (stepX !== 0) {
      out.x += stepX;
      if (boxIntersectsWorld(world, out.x, out.y, out.z, halfWidth, height)) {
        out.x -= stepX;
        out.hitX = true;
      }
    }
    if (stepZ !== 0) {
      out.z += stepZ;
      if (boxIntersectsWorld(world, out.x, out.y, out.z, halfWidth, height)) {
        out.z -= stepZ;
        out.hitZ = true;
      }
    }
    // If every axis is blocked there is no point continuing.
    if (out.hitX && out.hitY && out.hitZ) break;
  }
  return out;
}

/**
 * Is the box standing on something? Checks a thin slab just below the feet.
 */
export function isOnGround(world, x, y, z, halfWidth) {
  const probeY = y - 0.02;
  const minX = Math.floor(x - halfWidth + EPSILON);
  const maxX = Math.floor(x + halfWidth - EPSILON);
  const minZ = Math.floor(z - halfWidth + EPSILON);
  const maxZ = Math.floor(z + halfWidth - EPSILON);
  const by = Math.floor(probeY);

  for (let bz = minZ; bz <= maxZ; bz++) {
    for (let bx = minX; bx <= maxX; bx++) {
      if (world.isSolid(bx, by, bz)) return true;
    }
  }
  return false;
}

/**
 * Find a safe Y position for a box at (x, z): the lowest Y at or above
 * `startY` that neither overlaps terrain nor leaves the entity floating more
 * than `maxDrop` blocks above the ground.
 *
 * Used when spawning the player and when a save places them inside terrain.
 *
 * @returns {number} a safe bottom Y, or -1 when no safe spot was found
 */
export function findSafeY(world, x, z, halfWidth, height, startY, maxDrop = 6) {
  const ceiling = Math.min(startY + 8, 250);
  // Search upwards first: being pushed out of the ground is friendlier than
  // being dropped into a cave.
  for (let y = Math.max(0, Math.floor(startY)); y <= ceiling; y++) {
    if (!boxIntersectsWorld(world, x, y, z, halfWidth, height)) {
      // Settle downwards onto the first supporting surface.
      let settled = y;
      for (let k = 0; k < maxDrop && settled > 0; k++) {
        if (boxIntersectsWorld(world, x, settled - 1, z, halfWidth, height)) break;
        settled--;
      }
      return settled;
    }
  }
  return -1;
}
