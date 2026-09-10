/**
 * Raycast.js — voxel ray traversal (Amanatides & Woo).
 *
 * Walks the voxel grid one cell at a time along the ray, which is exact and
 * never misses a block regardless of the step size. Used for block targeting
 * and for the "is there anything between me and there" checks in mob AI.
 */

import { FACE } from './Blocks.js';

/** Reused result record; callers must copy anything they need to keep. */
const result = {
  x: 0, y: 0, z: 0,
  /** Face of the hit block that the ray entered through (a Blocks.FACE value). */
  face: FACE.TOP,
  /** Outward normal of the hit face. */
  nx: 0, ny: 0, nz: 0,
  /** Distance along the ray to the hit. */
  distance: 0,
  /** Block id that was hit. */
  id: 0
};

/**
 * Cast a ray through the voxel grid.
 *
 * @param {import('./World.js').World} world
 * @param {number} ox ray origin X
 * @param {number} oy ray origin Y
 * @param {number} oz ray origin Z
 * @param {number} dx normalised direction X
 * @param {number} dy normalised direction Y
 * @param {number} dz normalised direction Z
 * @param {number} maxDistance maximum travel distance
 * @param {(id:number)=>boolean} isHit predicate deciding which blocks stop the ray
 * @returns {typeof result|null} a shared record, or null when nothing was hit
 */
export function raycastVoxels(world, ox, oy, oz, dx, dy, dz, maxDistance, isHit) {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  // Distance along the ray between successive grid planes on each axis.
  const tDeltaX = dx !== 0 ? Math.abs(1 / dx) : Infinity;
  const tDeltaY = dy !== 0 ? Math.abs(1 / dy) : Infinity;
  const tDeltaZ = dz !== 0 ? Math.abs(1 / dz) : Infinity;

  // Distance to the first grid plane on each axis.
  let tMaxX = dx !== 0 ? ((stepX > 0 ? x + 1 - ox : ox - x) * tDeltaX) : Infinity;
  let tMaxY = dy !== 0 ? ((stepY > 0 ? y + 1 - oy : oy - y) * tDeltaY) : Infinity;
  let tMaxZ = dz !== 0 ? ((stepZ > 0 ? z + 1 - oz : oz - z) * tDeltaZ) : Infinity;

  let face = FACE.TOP;
  let distance = 0;
  // Bound the loop so a degenerate ray can never spin forever.
  const maxSteps = Math.ceil(maxDistance * 3) + 8;

  for (let step = 0; step < maxSteps; step++) {
    if (y >= 0) {
      const id = world.getBlock(x, y, z);
      if (isHit(id)) {
        result.x = x;
        result.y = y;
        result.z = z;
        result.face = face;
        result.distance = distance;
        result.id = id;
        if (face === FACE.EAST) { result.nx = 1; result.ny = 0; result.nz = 0; }
        else if (face === FACE.WEST) { result.nx = -1; result.ny = 0; result.nz = 0; }
        else if (face === FACE.TOP) { result.nx = 0; result.ny = 1; result.nz = 0; }
        else if (face === FACE.BOTTOM) { result.nx = 0; result.ny = -1; result.nz = 0; }
        else if (face === FACE.SOUTH) { result.nx = 0; result.ny = 0; result.nz = 1; }
        else { result.nx = 0; result.ny = 0; result.nz = -1; }
        return result;
      }
    }
    if (distance > maxDistance) break;

    // Advance to the next cell across the nearest grid plane.
    if (tMaxX < tMaxY) {
      if (tMaxX < tMaxZ) {
        distance = tMaxX;
        x += stepX;
        tMaxX += tDeltaX;
        face = stepX > 0 ? FACE.WEST : FACE.EAST;
      } else {
        distance = tMaxZ;
        z += stepZ;
        tMaxZ += tDeltaZ;
        face = stepZ > 0 ? FACE.NORTH : FACE.SOUTH;
      }
    } else {
      if (tMaxY < tMaxZ) {
        distance = tMaxY;
        y += stepY;
        tMaxY += tDeltaY;
        face = stepY > 0 ? FACE.BOTTOM : FACE.TOP;
      } else {
        distance = tMaxZ;
        z += stepZ;
        tMaxZ += tDeltaZ;
        face = stepZ > 0 ? FACE.NORTH : FACE.SOUTH;
      }
    }

    if (y < 0 || y >= 256) break; // outside the world vertically
  }
  return null;
}

/**
 * Convenience wrapper: cast from a camera and return the targeted block, using
 * the registry's "targetable" flag to decide what stops the ray (water and air
 * are see-through, plants are selectable).
 *
 * @param {import('./World.js').World} world
 * @param {{x:number,y:number,z:number,yaw:number,pitch:number}} camera
 * @param {number} reach
 * @param {(id:number)=>boolean} isTargetable
 * @returns {typeof result|null}
 */
export function pickBlock(world, camera, reach, isTargetable) {
  const cp = Math.cos(camera.pitch);
  const dx = -Math.sin(camera.yaw) * cp;
  const dy = Math.sin(camera.pitch);
  const dz = -Math.cos(camera.yaw) * cp;
  return raycastVoxels(world, camera.x, camera.y, camera.z, dx, dy, dz, reach, isTargetable);
}
