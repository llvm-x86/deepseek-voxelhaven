/**
 * Entity.js — the base class for everything that is not a block or the player.
 *
 * Entities are plain objects updated on a fixed timestep. They are rendered as
 * boxes and billboards by EntityRenderer rather than owning any scene node, so
 * having a few hundred alive costs almost nothing.
 */

import { moveBox, isOnGround } from '../player/Physics.js';

let nextEntityId = 1;

export class Entity {
  /**
   * @param {string} type short type name used by saves and the renderer
   * @param {number} x @param {number} y @param {number} z
   */
  constructor(type, x, y, z) {
    this.id = nextEntityId++;
    this.type = type;
    this.x = x;
    this.y = y;
    this.z = z;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.yaw = 0;
    this.pitch = 0;

    /** Collision box half-width. */
    this.halfWidth = 0.3;
    /** Collision box height. */
    this.height = 0.8;
    /** Gravity multiplier. */
    this.gravityScale = 1;

    this.onGround = false;
    this.inWater = false;
    /** Seconds since spawn. */
    this.age = 0;
    /** Set to true to have the manager remove this entity. */
    this.dead = false;
    /** Causes despawn once the player is far away. */
    this.despawnable = true;
    /** True for mobs that should only exist in the dark. */
    this.nocturnal = false;
  }

  /** Distance from a point in the XZ plane. */
  distanceToXZ(x, z) {
    return Math.hypot(this.x - x, this.z - z);
  }

  /** Full 3D distance from a point. */
  distanceTo(x, y, z) {
    return Math.hypot(this.x - x, this.y - y, this.z - z);
  }

  /** Centre of mass, used for aiming and pickup tests. */
  get centreY() {
    return this.y + this.height * 0.5;
  }

  /**
   * Apply gravity, integrate and resolve collisions.
   * @param {number} dt
   * @param {import('../world/World.js').World} world
   * @param {number} [gravity]
   */
  applyPhysics(dt, world, gravity) {
    this.inWater = world.isLiquid(Math.floor(this.x), Math.floor(this.y + this.height * 0.4), Math.floor(this.z));
    if (this.inWater) {
      // Buoyancy: slow the fall and drift upwards a little.
      this.velocityY += gravity * 0.35 * dt;
      this.velocityY = Math.max(this.velocityY, -2.2);
      this.velocityX *= 0.92;
      this.velocityZ *= 0.92;
    } else {
      this.velocityY -= gravity * this.gravityScale * dt;
      if (this.velocityY < -55) this.velocityY = -55;
    }

    const moved = moveBox(
      world, this.x, this.y, this.z, this.halfWidth, this.height,
      this.velocityX * dt, this.velocityY * dt, this.velocityZ * dt
    );
    this.x = moved.x;
    this.y = moved.y;
    this.z = moved.z;
    if (moved.hitX) this.velocityX = 0;
    if (moved.hitZ) this.velocityZ = 0;
    if (moved.hitY) {
      // Landing damage for mobs that fall a long way.
      if (this.velocityY < -18 && this.onFallDamage) this.onFallDamage(-this.velocityY);
      this.velocityY = 0;
    }
    this.onGround = isOnGround(world, this.x, this.y, this.z, this.halfWidth);
  }

  /**
   * Turn towards a target angle at a limited rate.
   * @param {number} targetYaw radians
   * @param {number} rate radians per second
   * @param {number} dt
   */
  turnTowards(targetYaw, rate, dt) {
    let delta = targetYaw - this.yaw;
    // Wrap into [-pi, pi] so the entity always turns the short way round.
    while (delta > Math.PI) delta -= Math.PI * 2;
    while (delta < -Math.PI) delta += Math.PI * 2;
    const maxStep = rate * dt;
    this.yaw += Math.max(-maxStep, Math.min(maxStep, delta));
  }

  /**
   * Per-step behaviour. Subclasses override this.
   * @param {number} dt
   * @param {object} ctx shared context: { world, player, bus, time, entities }
   */
  update(dt, ctx) {
    this.age += dt;
    this.applyPhysics(dt, ctx.world, ctx.gravity);
  }

  /** Serialise position and velocity for the save file. */
  serialize() {
    return {
      type: this.type,
      x: +this.x.toFixed(3),
      y: +this.y.toFixed(3),
      z: +this.z.toFixed(3),
      yaw: +this.yaw.toFixed(3),
      vx: +this.velocityX.toFixed(3),
      vy: +this.velocityY.toFixed(3),
      vz: +this.velocityZ.toFixed(3),
      data: this.serializeData ? this.serializeData() : undefined
    };
  }

  /** Restore from save data (position and velocity are handled by the manager). */
  deserialize(data) {
    if (this.deserializeData) this.deserializeData(data.data);
  }

  /** Reset the id counter (used when starting a brand new session). */
  static resetIds() {
    nextEntityId = 1;
  }
}
