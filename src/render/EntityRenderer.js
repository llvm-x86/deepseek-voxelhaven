/**
 * EntityRenderer.js — draws mobs and dropped items.
 *
 * Every entity is a small set of textured boxes. Their geometry is rebuilt into
 * one dynamic mesh each frame, so the entire population of the world costs a
 * single draw call. Lighting is sampled from the world at the entity's position
 * so mobs go dark in caves exactly like the terrain around them.
 */

import { mat4Compose } from '../core/Math3D.js';
import { ItemRegistry } from '../world/Items.js';
import { BlockRegistry } from '../world/Blocks.js';
import { FLAG_FLASH } from './DynamicMesh.js';

/** Scratch matrices/vectors reused every frame. */
const matrix = new Float32Array(16);
const tiles = [{ u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }, { u: 0, v: 0 }];

/**
 * Model definitions, in block units relative to the entity's feet position.
 * `tiles` are texture names; `front` marks which faces use the face texture.
 */
const MODELS = {
  woolback: {
    /** [offsetX, offsetY, offsetZ, sizeX, sizeY, sizeZ, useFaceTexture] */
    parts: [
      { x: 0, y: 0.42, z: 0, sx: 0.9, sy: 0.72, sz: 1.25, face: false },   // body
      { x: 0, y: 0.78, z: -0.74, sx: 0.55, sy: 0.5, sz: 0.5, face: true }, // head
      { x: -0.32, y: 0.0, z: -0.36, sx: 0.2, sy: 0.44, sz: 0.2, face: false, leg: true },
      { x: 0.32, y: 0.0, z: -0.36, sx: 0.2, sy: 0.44, sz: 0.2, face: false, leg: true },
      { x: -0.32, y: 0.0, z: 0.36, sx: 0.2, sy: 0.44, sz: 0.2, face: false, leg: true },
      { x: 0.32, y: 0.0, z: 0.36, sx: 0.2, sy: 0.44, sz: 0.2, face: false, leg: true }
    ]
  },
  gloomling: {
    parts: [
      { x: 0, y: 0.46, z: 0, sx: 0.6, sy: 1.0, sz: 0.42, face: false },   // torso
      { x: 0, y: 1.02, z: 0, sx: 0.52, sy: 0.48, sz: 0.48, face: true },  // head
      { x: -0.42, y: 0.5, z: 0, sx: 0.16, sy: 0.86, sz: 0.16, face: false, arm: true },
      { x: 0.42, y: 0.5, z: 0, sx: 0.16, sy: 0.86, sz: 0.16, face: false, arm: true },
      { x: -0.17, y: 0.0, z: 0, sx: 0.18, sy: 0.5, sz: 0.18, face: false, leg: true },
      { x: 0.17, y: 0.0, z: 0, sx: 0.18, sy: 0.5, sz: 0.18, face: false, leg: true }
    ]
  }
};

export class EntityRenderer {
  /** @param {import('../render/DynamicMesh.js').DynamicMesh} mesh */
  constructor(mesh, atlas) {
    this.mesh = mesh;
    this.atlas = atlas;
    /** Diagnostics. */
    this.stats = { items: 0, mobs: 0 };
  }

  /**
   * Rebuild the entity geometry for this frame.
   * @param {import('../entities/EntityManager.js').EntityManager} entityManager
   * @param {import('../world/World.js').World} world
   * @param {import('../player/Camera.js').Camera} camera
   * @param {number} timeSeconds
   */
  build(entityManager, world, camera, timeSeconds) {
    const mesh = this.mesh;
    mesh.begin();
    this.stats.items = 0;
    this.stats.mobs = 0;

    for (const entity of entityManager.entities) {
      const bx = Math.floor(entity.x);
      const by = Math.floor(entity.y + entity.height * 0.5);
      const bz = Math.floor(entity.z);
      // Entities outside the loaded area are simply not drawn.
      if (world.isUnloaded(bx, by, bz)) continue;

      const sky = world.getSkyLight(bx, by, bz) / 15;
      const blockLight = world.getBlockLight(bx, by, bz) / 15;

      if (entity.type === 'item') {
        this.buildItem(entity, sky, blockLight, timeSeconds);
      } else {
        this.buildMob(entity, sky, blockLight);
      }
    }
  }

  /** A dropped stack is a small rotating cube showing the item's texture. */
  buildItem(entity, sky, blockLight, timeSeconds) {
    const size = 0.28;
    // Items spin and bob so they read as pickups rather than props.
    const bob = Math.sin(timeSeconds * 2.4 + entity.phase) * 0.045;
    const rotation = timeSeconds * 1.4 + entity.phase;

    const blockId = ItemRegistry.blockIdOf(entity.item);
    let tileName;
    if (blockId !== null) {
      // Use the block's side texture so items look like the block they place.
      tileName = BlockRegistry.faceTileName(blockId, 0);
    } else {
      tileName = ItemRegistry.tile(entity.item);
    }
    const u = this.atlas.tileU(tileName);
    const v = this.atlas.tileV(tileName);
    for (let i = 0; i < 6; i++) { tiles[i].u = u; tiles[i].v = v; }

    mat4Compose(
      matrix,
      entity.x, entity.y + bob + size * 0.5 + 0.06, entity.z,
      rotation, 0, 0,
      size, size, size
    );
    this.mesh.addBoxMulti(matrix, tiles, sky, blockLight, 1);
    this.stats.items++;
  }

  /** A mob is its model parts, with a walk animation and a damage flash. */
  buildMob(entity, sky, blockLight) {
    const model = MODELS[entity.type];
    if (!model) return;

    // A damaged mob is tinted red by the shader via the FLASH vertex flag.
    const flags = entity.hurtFlash > 0 ? FLAG_FLASH : 0;
    const shade = 0.92;

    // Walk cycle: legs and arms swing based on distance travelled rather than
    // time, so the animation stops when the mob stops moving.
    const speed = Math.hypot(entity.velocityX, entity.velocityZ);
    entity.walkPhase += speed * 0.9;
    const swing = Math.sin(entity.walkPhase) * Math.min(0.55, speed * 0.22);
    const bob = Math.abs(Math.cos(entity.walkPhase)) * Math.min(0.05, speed * 0.02);

    const cos = Math.cos(entity.yaw);
    const sin = Math.sin(entity.yaw);

    for (const part of model.parts) {
      let offsetX = part.x;
      let offsetZ = part.z;
      let y = part.y + bob;

      // Legs and arms swing along the mob's facing direction.
      if (part.leg) {
        const direction = part.z < 0 ? 1 : -1;
        offsetZ += direction * swing * 0.28;
      } else if (part.arm) {
        offsetZ += (part.x < 0 ? -1 : 1) * swing * 0.35;
      }

      // The model is built facing -Z, so rotate offsets by the mob's yaw.
      const worldX = entity.x + (offsetX * cos - offsetZ * sin);
      const worldZ = entity.z + (offsetX * sin + offsetZ * cos);

      const bodyTile = entity.tiles ? entity.tiles.body : 'mob_woolback';
      const faceTile = part.face && entity.tiles ? entity.tiles.face : bodyTile;
      const uBody = this.atlas.tileU(bodyTile);
      const vBody = this.atlas.tileV(bodyTile);
      const uFace = this.atlas.tileU(faceTile);
      const vFace = this.atlas.tileV(faceTile);

      // FACE order is east, west, top, bottom, south, north. The model's front
      // faces -Z in local space, which maps to the north face.
      tiles[0].u = uBody; tiles[0].v = vBody;
      tiles[1].u = uBody; tiles[1].v = vBody;
      tiles[2].u = uBody; tiles[2].v = vBody;
      tiles[3].u = uBody; tiles[3].v = vBody;
      tiles[4].u = uBody; tiles[4].v = vBody;
      tiles[5].u = uFace; tiles[5].v = vFace;

      mat4Compose(
        matrix,
        worldX, entity.y + y, worldZ,
        entity.yaw, 0, 0,
        part.sx, part.sy, part.sz
      );
      this.mesh.addBoxMulti(matrix, tiles, sky, blockLight, shade, flags);
    }
    this.stats.mobs++;
  }
}
