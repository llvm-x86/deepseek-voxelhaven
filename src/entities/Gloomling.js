/**
 * Gloomling.js — the hostile mob.
 *
 * Spawns in the dark (caves and the night surface), hunts the player on sight,
 * and attacks on contact. Bright daylight burns it away, so a lit base is a
 * genuine defence and lanterns have a purpose.
 */

import { Mob, MobState } from './Mob.js';
import { ENTITIES } from '../core/Config.js';

const TILES = {
  body: 'mob_gloomling',
  face: 'mob_gloomling_face'
};

/** Damage per second from standing in bright daylight. */
const SUNLIGHT_DAMAGE_PER_SECOND = 2.4;

export class Gloomling extends Mob {
  constructor(x, y, z) {
    super('gloomling', x, y, z, {
      halfWidth: 0.36,
      height: 1.5,
      maxHealth: 12,
      moveSpeed: 2.6,
      hostile: true,
      nocturnal: true,
      attackDamage: 3,
      attackCooldown: 1.1,
      sightRange: 20,
      tiles: TILES,
      drops: [
        { item: 'coal', min: 1, max: 2, chance: 0.85 }
      ]
    });
    /** Time since the mob last had line of sight, used to give up a chase. */
    this.lostSightTimer = 0;
    /** Last known player position while chasing. */
    this.lastKnownX = 0;
    this.lastKnownZ = 0;
  }

  update(dt, ctx) {
    super.update(dt, ctx);

    // Daylight is lethal: this is what stops the surface being overrun.
    if (this.nocturnal && this.isInDaylight(ctx)) {
      this.health -= SUNLIGHT_DAMAGE_PER_SECOND * dt;
      this.hurtFlash = Math.max(this.hurtFlash, 0.1);
      if (this.health <= 0) {
        this.die(ctx, 'sunlight');
        return;
      }
    }

    const player = ctx.player;
    const seesPlayer = this.canSeePlayer(ctx);

    if (seesPlayer) {
      this.lostSightTimer = 0;
      this.lastKnownX = player.x;
      this.lastKnownZ = player.z;
      this.angry = true;
    } else if (this.angry) {
      this.lostSightTimer += dt;
      if (this.lostSightTimer > 6) {
        // Give up after a few seconds without contact.
        this.angry = false;
        this.state = MobState.WANDER;
        this.stateTimer = 3;
        this.wanderYaw = Math.random() * Math.PI * 2;
      }
    }

    if (this.angry && player && !player.dead) {
      const dx = player.x - this.x;
      const dz = player.z - this.z;
      const distance = Math.hypot(dx, dz);
      const targetX = seesPlayer ? player.x : this.lastKnownX;
      const targetZ = seesPlayer ? player.z : this.lastKnownZ;

      this.moveTowards(targetX, targetZ, dt, ctx, distance < 2 ? 0.6 : 1);

      // Attack when close enough and roughly at the same height.
      const verticalGap = Math.abs((player.y + 0.9) - (this.y + this.height * 0.5));
      if (distance < 1.45 && verticalGap < 1.6 && this.attackTimer <= 0) {
        this.attackTimer = this.attackCooldown;
        this.state = MobState.ATTACK;
        player.damage(this.attackDamage, 'a Gloomling');
        ctx.bus.emit('mobAttacked', { entity: this, damage: this.attackDamage });
      }
    } else {
      // Idle wander when not hunting.
      this.stateTimer -= dt;
      if (this.stateTimer <= 0) {
        this.stateTimer = 2 + Math.random() * 4;
        this.wanderYaw = Math.random() * Math.PI * 2;
        this.state = Math.random() < 0.35 ? MobState.IDLE : MobState.WANDER;
      }
      if (this.state === MobState.WANDER) {
        this.moveTowards(
          this.x - Math.sin(this.wanderYaw) * 5,
          this.z - Math.cos(this.wanderYaw) * 5,
          dt, ctx, 0.5
        );
      } else {
        this.velocityX *= Math.pow(0.001, dt);
        this.velocityZ *= Math.pow(0.001, dt);
      }
    }

    this.applyPhysics(dt, ctx.world, ctx.gravity);
    this.tryHopObstacle(ctx);

    // Never let a mob get permanently wedged in terrain.
    if (this.isStuck(ctx)) {
      this.y += 1.5;
      this.velocityY = 0;
    }

    if (this.despawnable && player && this.distanceToXZ(player.x, player.z) > ENTITIES.despawnDistance) {
      this.dead = true;
    }
  }
}
