/**
 * ParticleSystem.js — small billboard particles for block breaking, placing,
 * footfalls and mob damage.
 *
 * Particles are simulated on the fixed timestep and rebuilt into one dynamic
 * mesh every frame. A hard cap keeps the cost bounded no matter how much is
 * happening.
 */

import { BlockRegistry } from '../world/Blocks.js';

/** Maximum number of simultaneously live particles. */
const MAX_PARTICLES = 420;

/** Particles bounce off the ground with this fraction of their speed. */
const BOUNCE_DAMPING = 0.28;

/** Ground friction applied to a particle resting on a surface. */
const GROUND_DRAG = 0.86;

class Particle {
  constructor() {
    this.active = false;
    this.x = 0; this.y = 0; this.z = 0;
    this.velocityX = 0; this.velocityY = 0; this.velocityZ = 0;
    this.life = 0;
    this.maxLife = 1;
    this.size = 0.1;
    this.tile = 'stone';
    this.gravity = 24;
    this.onGround = false;
    this.sky = 15;
    this.blockLight = 0;
  }
}

export class ParticleSystem {
  /**
   * @param {import('../core/Random.js').Random} rng deterministic stream
   */
  constructor(rng) {
    /** @type {Particle[]} */
    this.pool = new Array(MAX_PARTICLES);
    for (let i = 0; i < MAX_PARTICLES; i++) this.pool[i] = new Particle();
    this.nextIndex = 0;
    this.liveCount = 0;
    this.rng = rng;
    /** Texture atlas, set by the renderer wiring so tiles can be resolved. */
    this.atlas = null;
  }

  /** Attach the atlas used for particle textures. */
  setAtlas(atlas) {
    this.atlas = atlas;
  }

  /** Find a free particle slot, recycling the oldest when full. */
  _acquire() {
    for (let i = 0; i < MAX_PARTICLES; i++) {
      const index = (this.nextIndex + i) % MAX_PARTICLES;
      if (!this.pool[index].active) {
        this.nextIndex = (index + 1) % MAX_PARTICLES;
        return this.pool[index];
      }
    }
    // All busy: steal the next slot round-robin.
    const particle = this.pool[this.nextIndex];
    this.nextIndex = (this.nextIndex + 1) % MAX_PARTICLES;
    return particle;
  }

  /**
   * Emit a burst of block-coloured particles.
   * @param {number} x @param {number} y @param {number} z centre of the block
   * @param {number} blockId
   * @param {number} [count]
   */
  spawnBlockBreak(x, y, z, blockId, count = 14) {
    const tiles = BlockRegistry.faceTiles(blockId);
    const spread = 0.34;
    for (let i = 0; i < count; i++) {
      const particle = this._acquire();
      particle.active = true;
      particle.x = x + (this.rng.next() - 0.5) * 0.9;
      particle.y = y + this.rng.next() * 0.9;
      particle.z = z + (this.rng.next() - 0.5) * 0.9;
      particle.velocityX = (this.rng.next() - 0.5) * spread * 7;
      particle.velocityY = this.rng.next() * 3.6 + 1.0;
      particle.velocityZ = (this.rng.next() - 0.5) * spread * 7;
      particle.maxLife = 0.55 + this.rng.next() * 0.6;
      particle.life = particle.maxLife;
      particle.size = 0.07 + this.rng.next() * 0.07;
      // Use a side or top face tile so the debris matches the block.
      particle.tile = tiles[this.rng.int(0, 5)] || tiles[0];
      particle.gravity = 22;
      particle.onGround = false;
    }
  }

  /**
   * Emit a small burst for placing a block: debris flies out of the new block.
   */
  spawnBlockPlace(x, y, z, blockId, count = 8) {
    const tiles = BlockRegistry.faceTiles(blockId);
    for (let i = 0; i < count; i++) {
      const particle = this._acquire();
      particle.active = true;
      particle.x = x + 0.5 + (this.rng.next() - 0.5) * 0.9;
      particle.y = y + 0.5 + (this.rng.next() - 0.5) * 0.9;
      particle.z = z + 0.5 + (this.rng.next() - 0.5) * 0.9;
      particle.velocityX = (this.rng.next() - 0.5) * 2.4;
      particle.velocityY = this.rng.next() * 1.6;
      particle.velocityZ = (this.rng.next() - 0.5) * 2.4;
      particle.maxLife = 0.3 + this.rng.next() * 0.25;
      particle.life = particle.maxLife;
      particle.size = 0.05 + this.rng.next() * 0.05;
      particle.tile = tiles[this.rng.int(0, 5)] || tiles[0];
      particle.gravity = 14;
      particle.onGround = false;
    }
  }

  /** Emit a puff under the player's feet. */
  spawnFootstep(x, y, z, blockId) {
    const tiles = BlockRegistry.faceTiles(blockId);
    for (let i = 0; i < 3; i++) {
      const particle = this._acquire();
      particle.active = true;
      particle.x = x + (this.rng.next() - 0.5) * 0.5;
      particle.y = y + 0.06;
      particle.z = z + (this.rng.next() - 0.5) * 0.5;
      particle.velocityX = (this.rng.next() - 0.5) * 0.9;
      particle.velocityY = this.rng.next() * 0.8;
      particle.velocityZ = (this.rng.next() - 0.5) * 0.9;
      particle.maxLife = 0.35;
      particle.life = particle.maxLife;
      particle.size = 0.05 + this.rng.next() * 0.04;
      particle.tile = tiles[2] || tiles[0];
      particle.gravity = 9;
      particle.onGround = false;
    }
  }

  /** Emit a burst of red-tinted particles when a mob is hit. */
  spawnMobHit(x, y, z, count = 8) {
    for (let i = 0; i < count; i++) {
      const particle = this._acquire();
      particle.active = true;
      particle.x = x + (this.rng.next() - 0.5) * 0.5;
      particle.y = y + (this.rng.next() - 0.5) * 0.5;
      particle.z = z + (this.rng.next() - 0.5) * 0.5;
      particle.velocityX = (this.rng.next() - 0.5) * 3;
      particle.velocityY = this.rng.next() * 2.4;
      particle.velocityZ = (this.rng.next() - 0.5) * 3;
      particle.maxLife = 0.4 + this.rng.next() * 0.3;
      particle.life = particle.maxLife;
      particle.size = 0.06 + this.rng.next() * 0.05;
      particle.tile = 'mob_gloomling';
      particle.gravity = 18;
      particle.onGround = false;
    }
  }

  /** Remove every live particle. */
  clear() {
    for (const particle of this.pool) particle.active = false;
    this.liveCount = 0;
  }

  /**
   * Advance every particle.
   * @param {number} dt
   * @param {import('../world/World.js').World} world
   */
  update(dt, world) {
    let live = 0;
    for (const particle of this.pool) {
      if (!particle.active) continue;
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.active = false;
        continue;
      }

      particle.velocityY -= particle.gravity * dt;
      // Light drag so debris arcs nicely instead of flying straight.
      particle.velocityX *= Math.pow(0.86, dt * 12);
      particle.velocityZ *= Math.pow(0.86, dt * 12);

      const nextX = particle.x + particle.velocityX * dt;
      const nextY = particle.y + particle.velocityY * dt;
      const nextZ = particle.z + particle.velocityZ * dt;

      // Simple per-axis collision: particles settle on the ground instead of
      // falling through it.
      if (world.isSolid(Math.floor(nextX), Math.floor(particle.y), Math.floor(particle.z))) {
        particle.velocityX = 0;
      } else {
        particle.x = nextX;
      }
      if (world.isSolid(Math.floor(particle.x), Math.floor(nextY), Math.floor(particle.z))) {
        if (particle.velocityY < 0) {
          // Bounce, then slide.
          particle.onGround = true;
          particle.velocityX *= GROUND_DRAG;
          particle.velocityZ *= GROUND_DRAG;
          if (Math.abs(particle.velocityY) < 1.2) particle.velocityY = 0;
          else particle.velocityY = -particle.velocityY * BOUNCE_DAMPING;
        } else {
          particle.velocityY = 0;
        }
      } else {
        particle.y = nextY;
        particle.onGround = false;
      }
      if (world.isSolid(Math.floor(particle.x), Math.floor(particle.y), Math.floor(nextZ))) {
        particle.velocityZ = 0;
      } else {
        particle.z = nextZ;
      }

      live++;
    }
    this.liveCount = live;
  }

  /**
   * Rebuild the particle geometry into a dynamic mesh.
   * @param {import('./DynamicMesh.js').DynamicMesh} mesh
   * @param {import('../world/World.js').World} world
   * @param {import('../player/Camera.js').Camera} camera
   */
  buildMesh(mesh, world, camera) {
    mesh.begin();
    if (this.liveCount === 0) return;
    if (!this.atlas) return;

    const right = camera.right();
    const up = camera.up();
    const rightArray = [right.x, right.y, right.z];
    const upArray = [up.x, up.y, up.z];

    for (const particle of this.pool) {
      if (!particle.active) continue;
      // Fade out over the last part of the lifetime by shrinking the quad.
      const lifeFraction = particle.life / particle.maxLife;
      const scale = particle.size * Math.min(1, lifeFraction * 2.4);

      const bx = Math.floor(particle.x);
      const by = Math.floor(particle.y);
      const bz = Math.floor(particle.z);
      const sky = world.getSkyLight(bx, by, bz) / 15;
      const blockLight = world.getBlockLight(bx, by, bz) / 15;

      const tileU = this.atlas.tileU(particle.tile);
      const tileV = this.atlas.tileV(particle.tile);
      // Particles are lit by the block they came from, so they keep the block's
      // colour rather than turning black in the dark.
      mesh.addBillboard(
        particle.x, particle.y, particle.z, scale,
        rightArray, upArray,
        tileU, tileV,
        Math.max(sky, 0.35), blockLight,
        0.95
      );
    }
  }
}
