/**
 * Woolback.js — the passive mob.
 *
 * A placid woolly grazer that wanders aimlessly, runs away when hurt, and
 * sheds Fiber when killed. It never attacks, which makes it the safe source of
 * early materials.
 */

import { Mob, MobState } from './Mob.js';
import { ENTITIES } from '../core/Config.js';

/** Texture tiles in FACE order (east, west, top, bottom, south, north). */
const TILES = {
  body: 'mob_woolback',
  face: 'mob_woolback_face'
};

export class Woolback extends Mob {
  constructor(x, y, z) {
    super('woolback', x, y, z, {
      halfWidth: 0.45,
      height: 1.15,
      maxHealth: 10,
      moveSpeed: 1.7,
      hostile: false,
      sightRange: 10,
      tiles: TILES,
      drops: [
        { item: 'fiber', min: 1, max: 2, chance: 1.0 }
      ]
    });
    // Reuse the body texture on five faces and the face texture on the front.
    this.faceTileSet = {
      body: TILES.body,
      face: TILES.face
    };
    this.grazingTimer = 2 + Math.random() * 4;
    this.modelScale = 1;
  }

  update(dt, ctx) {
    super.update(dt, ctx);

    // Passive mobs still take falling damage, but only from big drops.
    this.onFallDamage = (speed) => {
      if (speed > 22) this.hurt(Math.floor((speed - 22) / 6) + 1, ctx, false);
    };

    // Flee when provoked, otherwise wander slowly and graze.
    if (this.state === MobState.FLEE) {
      if (this.stateTimer <= 0) {
        this.state = MobState.WANDER;
        this.wanderYaw = Math.random() * Math.PI * 2;
      } else {
        const player = ctx.player;
        if (player) {
          // Run directly away from whoever hurt us.
          const dx = this.x - player.x;
          const dz = this.z - player.z;
          const distance = Math.hypot(dx, dz) || 1;
          this.moveTowards(this.x + (dx / distance) * 6, this.z + (dz / distance) * 6, dt, ctx, 1.5);
        }
      }
    } else {
      // Wander: pick a new heading every few seconds, pause to graze in between.
      this.grazingTimer -= dt;
      if (this.grazingTimer <= 0) {
        this.grazingTimer = 2 + Math.random() * 5;
        if (Math.random() < 0.55) {
          this.state = MobState.IDLE;
          this.stateTimer = 1 + Math.random() * 2;
          this.wanderYaw = Math.random() * Math.PI * 2;
        } else {
          this.state = MobState.WANDER;
          this.stateTimer = 2 + Math.random() * 3;
          this.wanderYaw = Math.random() * Math.PI * 2;
        }
      }
      if (this.state === MobState.WANDER && this.stateTimer > 0) {
        const distance = 4;
        const targetX = this.x - Math.sin(this.wanderYaw) * distance;
        const targetZ = this.z - Math.cos(this.wanderYaw) * distance;
        this.moveTowards(targetX, targetZ, dt, ctx, 0.75);
      } else {
        // Idle: come to a stop.
        this.velocityX *= Math.pow(0.001, dt);
        this.velocityZ *= Math.pow(0.001, dt);
      }
    }

    this.applyPhysics(dt, ctx.world, ctx.gravity);
    this.tryHopObstacle(ctx);

    // If it somehow ends up inside terrain, lift it out.
    if (this.isStuck(ctx)) {
      this.y += 2;
      this.velocityY = 0;
    }

    // Despawn once far from everyone.
    const player = ctx.player;
    if (this.despawnable && player && this.distanceToXZ(player.x, player.z) > ENTITIES.despawnDistance) {
      this.dead = true;
    }
  }
}
