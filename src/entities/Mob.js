/**
 * Mob.js — shared behaviour for living entities (health, damage, AI helpers).
 *
 * Two concrete mobs are built on it: Woolback (passive) and Gloomling
 * (hostile). Their AI is a small state machine driven by what the mob can see,
 * which is deliberately simple but produces believable behaviour: wander,
 * notice the player, chase, attack, flee when hurt.
 */

import { Entity } from './Entity.js';
import { boxIntersectsWorld } from '../player/Physics.js';
import { BlockId } from '../world/Blocks.js';

/** AI states shared by every mob. */
export const MobState = Object.freeze({
  IDLE: 'idle',
  WANDER: 'wander',
  CHASE: 'chase',
  FLEE: 'flee',
  ATTACK: 'attack'
});

export class Mob extends Entity {
  /**
   * @param {string} type
   * @param {number} x @param {number} y @param {number} z
   * @param {Object} config
   */
  constructor(type, x, y, z, config) {
    super(type, x, y, z);
    this.halfWidth = config.halfWidth;
    this.height = config.height;
    this.maxHealth = config.maxHealth;
    this.health = config.maxHealth;
    this.moveSpeed = config.moveSpeed;
    this.hostile = !!config.hostile;
    this.nocturnal = !!config.nocturnal;
    /** Damage dealt to the player per attack. */
    this.attackDamage = config.attackDamage || 0;
    /** Seconds between attacks. */
    this.attackCooldown = config.attackCooldown || 1.0;
    /** Distance at which the mob notices the player. */
    this.sightRange = config.sightRange || 16;
    /** Drops: [{ item, min, max, chance }] */
    this.drops = config.drops || [];
    /** Texture tile names used by the renderer. */
    this.tiles = config.tiles;

    this.state = MobState.IDLE;
    /** Seconds remaining in the current state. */
    this.stateTimer = 0;
    /** Random heading used while wandering. */
    this.wanderYaw = Math.random() * Math.PI * 2;
    /** Seconds until the next attack is allowed. */
    this.attackTimer = 0;
    /** Flash timer set when damaged, used to tint the model red. */
    this.hurtFlash = 0;
    /** Set for one step when the mob should hop over an obstacle. */
    this.jumpCooldown = 0;
    /** Whether the mob has been provoked. */
    this.angry = false;
    /** Accumulated walk-cycle phase, advanced by the renderer. */
    this.walkPhase = 0;
  }

  /** Current health as a 0..1 fraction. */
  get healthFraction() {
    return this.maxHealth > 0 ? this.health / this.maxHealth : 0;
  }

  /**
   * Apply damage from any source.
   * @param {number} amount in half-hearts
   * @param {object} ctx
   * @param {boolean} [provoke] whether this should anger a passive mob
   */
  hurt(amount, ctx, provoke = true) {
    if (this.dead || amount <= 0) return;
    this.health -= amount;
    this.hurtFlash = 0.35;
    if (provoke) {
      this.angry = true;
      this.state = MobState.FLEE;
      this.stateTimer = 3.5;
    }
    ctx.bus.emit('mobDamaged', { entity: this, amount });
    if (this.health <= 0) this.die(ctx, provoke ? 'player' : 'environment');
  }

  /**
   * Kill the mob, dropping its loot and emitting particles.
   * @param {object} ctx
   * @param {string} cause
   */
  die(ctx, cause) {
    if (this.dead) return;
    this.dead = true;
    ctx.bus.emit('mobDied', { entity: this, cause });
    for (const drop of this.drops) {
      if (drop.chance !== undefined && Math.random() > drop.chance) continue;
      const min = drop.min !== undefined ? drop.min : 1;
      const max = drop.max !== undefined ? drop.max : min;
      const count = min + Math.floor(Math.random() * (max - min + 1));
      if (count > 0 && ctx.entities) {
        ctx.entities.spawnItem(this.x, this.y + this.height * 0.5, this.z, drop.item, count);
      }
    }
  }

  /** True when the mob can see the player (range, and not behind solid rock). */
  canSeePlayer(ctx) {
    const player = ctx.player;
    if (!player || player.dead) return false;
    const dx = player.x - this.x;
    const dy = (player.y + 0.9) - (this.y + this.height * 0.5);
    const dz = player.z - this.z;
    const distance = Math.hypot(dx, dy, dz);
    if (distance > this.sightRange) return false;
    // Cheap line-of-sight: sample a handful of points along the segment.
    const steps = Math.min(24, Math.ceil(distance * 2));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const px = Math.floor(this.x + dx * t);
      const py = Math.floor(this.y + this.height * 0.5 + dy * t);
      const pz = Math.floor(this.z + dz * t);
      const id = ctx.world.getBlock(px, py, pz);
      if (id !== BlockId.AIR && id !== BlockId.WATER) return false;
    }
    return true;
  }

  /**
   * Steer towards a point, hopping over one-block obstacles.
   * @param {number} targetX @param {number} targetZ
   * @param {number} dt
   * @param {object} ctx
   * @param {number} [speedScale]
   */
  moveTowards(targetX, targetZ, dt, ctx, speedScale = 1) {
    const dx = targetX - this.x;
    const dz = targetZ - this.z;
    const distance = Math.hypot(dx, dz);
    if (distance < 1e-4) return;

    const desiredYaw = Math.atan2(-dx, -dz);
    this.turnTowards(desiredYaw, 8, dt);

    const speed = this.moveSpeed * speedScale;
    const inv = 1 / distance;
    const accel = this.onGround ? 22 : 6;
    this.velocityX += (dx * inv * speed - this.velocityX) * Math.min(1, accel * dt);
    this.velocityZ += (dz * inv * speed - this.velocityZ) * Math.min(1, accel * dt);
  }

  /**
   * Jump if the mob is walking into a wall but there is room above it.
   * Called after physics so `hitX`/`hitZ` from the previous step are known.
   */
  tryHopObstacle(ctx) {
    if (!this.onGround || this.jumpCooldown > 0) return;
    const speed = Math.hypot(this.velocityX, this.velocityZ);
    if (speed < 0.4) return;

    const ahead = 0.55;
    const dirX = this.velocityX / speed;
    const dirZ = this.velocityZ / speed;
    const probeX = Math.floor(this.x + dirX * ahead);
    const probeZ = Math.floor(this.z + dirZ * ahead);
    const footY = Math.floor(this.y + 0.1);
    const headY = Math.floor(this.y + this.height + 0.2);

    const blocked = ctx.world.isSolid(probeX, footY, probeZ);
    const headFree = !ctx.world.isSolid(probeX, footY + 1, probeZ)
      && !ctx.world.isSolid(probeX, footY + 2, probeZ)
      && !ctx.world.isSolid(Math.floor(this.x), headY, Math.floor(this.z));
    if (blocked && headFree) {
      this.velocityY = 7.2;
      this.jumpCooldown = 0.6;
    }
  }

  /** True when the mob's box currently overlaps a solid block. */
  isStuck(ctx) {
    return boxIntersectsWorld(ctx.world, this.x, this.y, this.z, this.halfWidth, this.height);
  }

  /**
   * Daylight check used by nocturnal mobs: true when the sky is bright where
   * the mob stands.
   */
  isInDaylight(ctx) {
    const sky = ctx.world.getSkyLight(Math.floor(this.x), Math.floor(this.y + this.height * 0.5), Math.floor(this.z));
    return sky >= 12 && ctx.dayBrightness > 0.55;
  }

  update(dt, ctx) {
    this.age += dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt;
    if (this.attackTimer > 0) this.attackTimer -= dt;
    if (this.jumpCooldown > 0) this.jumpCooldown -= dt;
    if (this.stateTimer > 0) this.stateTimer -= dt;
  }

  serializeData() {
    return {
      health: +this.health.toFixed(2),
      state: this.state,
      angry: this.angry
    };
  }

  deserializeData(data) {
    if (!data) return;
    if (typeof data.health === 'number') {
      this.health = Math.max(1, Math.min(this.maxHealth, data.health));
    }
    if (typeof data.angry === 'boolean') this.angry = data.angry;
  }
}
