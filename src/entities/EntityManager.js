/**
 * EntityManager.js — owns every live entity, runs their updates, and handles
 * natural spawning and despawning.
 *
 * Entities are updated on the fixed timestep. Distant entities are frozen
 * (they keep their state but skip AI and physics) which keeps a busy world
 * cheap without anything visibly popping.
 */

import { ENTITIES } from '../core/Config.js';
import { BlockId, SOLID } from '../world/Blocks.js';
import { ItemEntity } from './ItemEntity.js';
import { Woolback } from './Woolback.js';
import { Gloomling } from './Gloomling.js';
import { Entity } from './Entity.js';

/** Horizontal radius searched when spawning a mob. */
const SPAWN_ATTEMPT_RADIUS = ENTITIES.spawnMaxDistance;

export class EntityManager {
  /**
   * @param {import('../world/World.js').World} world
   * @param {import('../core/EventBus.js').EventBus} bus
   */
  constructor(world, bus) {
    this.world = world;
    this.bus = bus;
    /** @type {Entity[]} */
    this.entities = [];
    /** @type {Map<string, Function>} type name -> factory, used when loading */
    this.factories = new Map();
    this.registerFactory('item', (data) => {
      const entity = new ItemEntity(data.x, data.y, data.z, data.data ? data.data.item : 'air', 1);
      return entity;
    });
    this.registerFactory('woolback', (data) => new Woolback(data.x, data.y, data.z));
    this.registerFactory('gloomling', (data) => new Gloomling(data.x, data.y, data.z));

    /** Spawn attempt accumulators (fractional spawns). */
    this.hostileSpawnAccumulator = 0;
    this.passiveSpawnAccumulator = 0;
    /** Set to false to stop all natural spawning (used by tests/debug). */
    this.spawningEnabled = true;

    this.stats = { items: 0, passive: 0, hostile: 0, updated: 0 };
  }

  /** Register a factory so entities of this type can be restored from a save. */
  registerFactory(type, factory) {
    this.factories.set(type, factory);
  }

  /** Number of live entities. */
  get count() {
    return this.entities.length;
  }

  // -------------------------------------------------------------------------
  // Spawning
  // -------------------------------------------------------------------------

  /** Add an entity to the world. */
  spawn(entity) {
    // Guard against anything that is not a well-formed entity: a single bad
    // object would otherwise throw on every frame from inside the update loop.
    if (!entity || typeof entity.update !== 'function' || typeof entity.distanceToXZ !== 'function') {
      console.warn('[EntityManager] refused to spawn a malformed entity:', entity);
      return null;
    }
    if (this.entities.length >= ENTITIES.maxEntities) {
      // Make room by dropping the oldest item stack, which is the least
      // disruptive thing to remove.
      const index = this.entities.findIndex((e) => e.type === 'item');
      if (index === -1) return null;
      this.entities.splice(index, 1);
    }
    this.entities.push(entity);
    return entity;
  }

  /**
   * Spawn a dropped item stack with a small outward pop.
   * @returns {ItemEntity|null}
   */
  spawnItem(x, y, z, item, count = 1) {
    if (!item || item === 'air' || count <= 0) return null;
    const entity = new ItemEntity(x, y, z, item, count);
    // Small random pop so stacks separate visually.
    entity.velocityX = (Math.random() - 0.5) * 2.2;
    entity.velocityY = 1.6 + Math.random() * 1.4;
    entity.velocityZ = (Math.random() - 0.5) * 2.2;
    return this.spawn(entity);
  }

  /**
   * Try to place one mob of the given kind at a random valid spot near the
   * player. Used by the spawner and by the debug API.
   *
   * @param {string} type 'woolback' | 'gloomling'
   * @param {number} playerX @param {number} playerY @param {number} playerZ
   * @returns {Entity|null} the spawned mob, or null when no spot was valid
   */
  spawnMobNear(type, playerX, playerY, playerZ) {
    for (let attempt = 0; attempt < 12; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = ENTITIES.spawnMinDistance
        + Math.random() * (SPAWN_ATTEMPT_RADIUS - ENTITIES.spawnMinDistance);
      const x = Math.floor(playerX + Math.cos(angle) * distance);
      const z = Math.floor(playerZ + Math.sin(angle) * distance);
      if (!this.world.isColumnLoaded(x, z)) continue;

      const surfaceY = this.world.heightAt(x, z);
      if (surfaceY < 0) continue;

      // Search downwards from a bit above the surface for a spot with two
      // blocks of headroom standing on something solid.
      for (let y = Math.min(surfaceY + 1, 200); y > surfaceY - 26 && y > 1; y--) {
        if (!this._isSpawnable(x, y, z)) continue;
        if (type === 'gloomling') {
          // Hostiles need darkness.
          const light = this.world.getLight(x, y, z);
          if (light > ENTITIES.hostileSpawnMaxLight) break;
          return this.spawn(new Gloomling(x + 0.5, y, z + 0.5));
        }
        // Passives need light and grass.
        const ground = this.world.getBlock(x, y - 1, z);
        if (ground !== BlockId.TURF) break;
        if (this.world.getLight(x, y, z) < 7) break;
        return this.spawn(new Woolback(x + 0.5, y, z + 0.5));
      }
    }
    return null;
  }

  /** True when a two-block-tall mob can stand at this voxel. */
  _isSpawnable(x, y, z) {
    const below = this.world.getBlock(x, y - 1, z);
    if (SOLID[below] !== 1) return false;
    const feet = this.world.getBlock(x, y, z);
    const head = this.world.getBlock(x, y + 1, z);
    return feet === BlockId.AIR && head === BlockId.AIR;
  }

  /**
   * Drive natural spawning.
   * @param {number} dt
   * @param {import('../player/Player.js').Player} player
   * @param {number} dayBrightness
   */
  updateSpawning(dt, player, dayBrightness) {
    if (!this.spawningEnabled || player.dead) return;
    if (this.count >= ENTITIES.maxEntities) return;

    this.hostileSpawnAccumulator += dt * ENTITIES.hostileSpawnAttemptsPerSecond;
    this.passiveSpawnAccumulator += dt * ENTITIES.passiveSpawnAttemptsPerSecond;

    if (this.hostileSpawnAccumulator >= 1) {
      this.hostileSpawnAccumulator -= 1;
      if (this.stats.hostile < ENTITIES.maxHostile) {
        this.spawnMobNear('gloomling', player.x, player.y, player.z);
      }
    }
    if (this.passiveSpawnAccumulator >= 1) {
      this.passiveSpawnAccumulator -= 1;
      if (this.stats.passive < ENTITIES.maxPassive && dayBrightness > 0.4) {
        this.spawnMobNear('woolback', player.x, player.y, player.z);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Update
  // -------------------------------------------------------------------------

  /**
   * Update every entity.
   * @param {number} dt
   * @param {object} context { player, bus, time, gravity, dayBrightness }
   */
  update(dt, context) {
    const player = context.player;
    const ctx = {
      world: this.world,
      player,
      bus: this.bus,
      entities: this,
      gravity: ENTITIES.gravity,
      dayBrightness: context.dayBrightness
    };

    let items = 0;
    let passive = 0;
    let hostile = 0;
    let updated = 0;

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const entity = this.entities[i];
      const distance = player ? entity.distanceToXZ(player.x, player.z) : 0;

      // Distant entities are frozen rather than removed, so the world does not
      // visibly "reset" when the player walks back.
      if (distance <= ENTITIES.simulationDistance) {
        entity.update(dt, ctx);
        updated++;
      } else {
        entity.age += dt;
      }

      if (entity.dead) {
        this.entities.splice(i, 1);
        continue;
      }
      // Items are never culled by distance: they despawn on their own timer.
      if (entity.type === 'item') items++;
      else if (entity.hostile) hostile++;
      else passive++;
    }

    this.stats.items = items;
    this.stats.passive = passive;
    this.stats.hostile = hostile;
    this.stats.updated = updated;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  /**
   * Iterate entities within a radius of a point.
   * @param {number} x @param {number} y @param {number} z @param {number} radius
   * @param {(entity:Entity, distance:number)=>void} callback
   */
  forEachNear(x, y, z, radius, callback) {
    for (const entity of this.entities) {
      const distance = entity.distanceTo(x, y, z);
      if (distance <= radius) callback(entity, distance);
    }
  }

  /**
   * First mob whose bounding box is hit by a ray. Used for attacking.
   * @returns {{entity:Mob, distance:number}|null}
   */
  raycastMob(originX, originY, originZ, dirX, dirY, dirZ, maxDistance) {
    let best = null;
    for (const entity of this.entities) {
      if (entity.type === 'item') continue;
      const hit = rayBoxIntersection(
        originX, originY, originZ, dirX, dirY, dirZ,
        entity.x - entity.halfWidth, entity.y, entity.z - entity.halfWidth,
        entity.x + entity.halfWidth, entity.y + entity.height, entity.z + entity.halfWidth
      );
      if (hit === null || hit > maxDistance) continue;
      if (!best || hit < best.distance) best = { entity, distance: hit };
    }
    return best;
  }

  /** Remove every entity. */
  clear() {
    this.entities.length = 0;
  }

  // -------------------------------------------------------------------------
  // Persistence
  // -------------------------------------------------------------------------

  /** Only dropped items and named mobs are saved; wandering mobs are not. */
  serialize() {
    const out = [];
    for (const entity of this.entities) {
      if (entity.type === 'item') out.push(entity.serialize());
    }
    return out;
  }

  /**
   * Restore saved entities. Unloaded positions are kept — the entity simply
   * waits until the player walks over and its chunks exist.
   * @param {Array} data
   * @returns {{restored:number, skipped:number}}
   */
  deserialize(data) {
    let restored = 0;
    let skipped = 0;
    if (!Array.isArray(data)) return { restored, skipped };
    for (const entry of data) {
      try {
        if (!entry || typeof entry.type !== 'string') { skipped++; continue; }
        const factory = this.factories.get(entry.type);
        if (!factory) { skipped++; continue; }
        const x = Number(entry.x);
        const y = Number(entry.y);
        const z = Number(entry.z);
        if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { skipped++; continue; }
        const entity = factory({ ...entry, x, y, z });
        if (!entity) { skipped++; continue; }
        entity.x = x; entity.y = y; entity.z = z;
        entity.yaw = Number(entry.yaw) || 0;
        entity.velocityX = Number(entry.vx) || 0;
        entity.velocityY = Number(entry.vy) || 0;
        entity.velocityZ = Number(entry.vz) || 0;
        entity.deserialize(entry);
        if (entity.dead) { skipped++; continue; }
        this.spawn(entity);
        restored++;
      } catch (err) {
        console.warn('[EntityManager] could not restore entity:', err);
        skipped++;
      }
    }
    return { restored, skipped };
  }
}

/**
 * Ray vs axis-aligned box (slab method).
 * @returns {number|null} distance along the ray, or null when it misses
 */
function rayBoxIntersection(ox, oy, oz, dx, dy, dz, minX, minY, minZ, maxX, maxY, maxZ) {
  let tMin = 0;
  let tMax = Infinity;

  const axes = [[ox, dx, minX, maxX], [oy, dy, minY, maxY], [oz, dz, minZ, maxZ]];
  for (const [origin, direction, lo, hi] of axes) {
    if (Math.abs(direction) < 1e-8) {
      if (origin < lo || origin > hi) return null;
      continue;
    }
    const inv = 1 / direction;
    let t1 = (lo - origin) * inv;
    let t2 = (hi - origin) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }
  return tMin;
}

/** Reset entity ids (used when a brand new world is created). */
export function resetEntityIds() {
  Entity.resetIds();
}
