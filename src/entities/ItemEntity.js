/**
 * ItemEntity.js — a dropped item stack lying in the world.
 *
 * Items pop out of broken blocks, fall to the ground, bob and spin, and are
 * pulled into the player's inventory when they get close. They despawn after a
 * few minutes so the world does not accumulate junk.
 */

import { Entity } from './Entity.js';
import { INTERACTION, ENTITIES } from '../core/Config.js';
import { ItemRegistry } from '../world/Items.js';

export class ItemEntity extends Entity {
  /**
   * @param {number} x @param {number} y @param {number} z
   * @param {string} item item key
   * @param {number} count stack size
   */
  constructor(x, y, z, item, count = 1) {
    super('item', x, y, z);
    this.item = item;
    this.count = count;
    this.halfWidth = 0.14;
    this.height = 0.28;
    this.gravityScale = 1;
    /** Seconds before the stack can be collected. */
    this.pickupDelay = INTERACTION.pickupDelay;
    /** Spin and bob phase, randomised so stacks do not move in lockstep. */
    this.phase = Math.random() * Math.PI * 2;
    /** Set once the item has been absorbed, so the pickup is charged once. */
    this.collected = false;
  }

  update(dt, ctx) {
    this.age += dt;
    this.phase += dt * 2.4;
    if (this.pickupDelay > 0) this.pickupDelay -= dt;

    const player = ctx.player;

    // Magnet: once the pickup delay has elapsed, items within range drift
    // towards the player instead of waiting to be walked into.
    if (this.pickupDelay <= 0 && player && !player.dead) {
      const dx = player.x - this.x;
      const dy = (player.y + 0.9) - (this.y + this.height * 0.5);
      const dz = player.z - this.z;
      const distance = Math.hypot(dx, dy, dz);
      if (distance < INTERACTION.pickupRadius) {
        // Strong pull, scaled so it cannot overshoot the player.
        const pull = 26 * dt;
        const inv = distance > 1e-4 ? 1 / distance : 0;
        this.velocityX += dx * inv * pull;
        this.velocityY += dy * inv * pull * 0.6;
        this.velocityZ += dz * inv * pull;
        if (distance < 0.9) this.tryCollect(ctx);
      } else if (distance < 4.5) {
        // Gentle attraction from a bit further out.
        const inv = 1 / distance;
        this.velocityX += dx * inv * 4.0 * dt;
        this.velocityY += dy * inv * 2.0 * dt;
        this.velocityZ += dz * inv * 4.0 * dt;
      }
    }

    // Water makes items float so they do not sink into lakes forever.
    this.applyPhysics(dt, ctx.world, ctx.gravity);

    // Ground friction keeps dropped stacks from sliding away.
    if (this.onGround) {
      this.velocityX *= Math.pow(0.02, dt);
      this.velocityZ *= Math.pow(0.02, dt);
    }

    // Despawn old items, and anything that has fallen out of the world.
    if (this.age > ENTITIES.itemLifetimeSeconds || this.y < -12) {
      this.dead = true;
    }
  }

  /** Attempt to store this stack in the player's inventory. */
  tryCollect(ctx) {
    if (this.collected || this.count <= 0) return;
    const leftover = ctx.player.inventory.add(this.item, this.count);
    const taken = this.count - leftover;
    if (taken <= 0) return;
    this.count = leftover;
    this.collected = true;
    ctx.bus.emit('itemPickedUp', { item: this.item, count: taken });
    if (leftover <= 0) this.dead = true;
    else this.collected = false; // partial pickup: keep trying for the rest
  }

  serializeData() {
    return { item: this.item, count: this.count, pickupDelay: +this.pickupDelay.toFixed(2) };
  }

  deserializeData(data) {
    if (!data) return;
    if (typeof data.item === 'string' && ItemRegistry.isValid(data.item)) this.item = data.item;
    else this.dead = true;
    this.count = Math.max(1, Math.min(ItemRegistry.maxStack(this.item), data.count | 0 || 1));
    this.pickupDelay = Math.max(0, Number(data.pickupDelay) || INTERACTION.pickupDelay);
  }
}
