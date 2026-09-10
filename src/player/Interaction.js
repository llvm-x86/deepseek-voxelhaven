/**
 * Interaction.js — turning mouse input into world changes.
 *
 * Left mouse breaks the targeted block (taking time proportional to its
 * hardness), right mouse places the selected item against the targeted face,
 * middle mouse picks the targeted block into the hotbar.
 *
 * Breaking a block:
 *   1. removes it from the world (World emits blockChanged)
 *   2. the chunk manager rebuilds the affected meshes
 *   3. a dropped item entity is spawned
 *   4. particles and a sound play
 *
 * Placement is refused when the new block would intersect the player, when the
 * target cell is not replaceable, or when the player has nothing to place.
 */

import { BLOCK_ID_LIMIT, BlockRegistry, BlockId, SOLID, REPLACEABLE } from '../world/Blocks.js';
import { ItemRegistry } from '../world/Items.js';
import { pickBlock } from '../world/Raycast.js';
import { INTERACTION, PLAYER } from '../core/Config.js';

/** How long a break must be held before the block is destroyed, per hardness. */
const BREAK_SPEED = 1.0;

export class Interaction {
  /**
   * @param {import('../world/World.js').World} world
   * @param {import('../player/Player.js').Player} player
   * @param {import('../player/Camera.js').Camera} camera
   * @param {import('../entities/EntityManager.js').EntityManager} entities
   * @param {import('../render/ParticleSystem.js').ParticleSystem} particles
   * @param {import('../systems/AudioSystem.js').AudioSystem} audio
   * @param {import('../core/EventBus.js').EventBus} bus
   */
  constructor(world, player, camera, entities, particles, audio, bus) {
    this.world = world;
    this.player = player;
    this.camera = camera;
    this.entities = entities;
    this.particles = particles;
    this.audio = audio;
    this.bus = bus;

    /** Currently targeted block, or null. @type {{x:number,y:number,z:number,id:number,face:number,nx:number,ny:number,nz:number}|null} */
    this.target = null;

    /** Progress towards breaking the current target, 0..1. */
    this.breakProgress = 0;
    /** Block currently being broken (null when not breaking). */
    this.breakingKey = null;
    /** Timers enforcing the repeat rate while a button is held. */
    this.breakRepeatTimer = 0;
    this.placeRepeatTimer = 0;
    /** Set to true to break blocks instantly (used by the debug API/tests). */
    this.instantBreak = false;
    /** Reach in blocks. */
    this.reach = PLAYER.reach;
  }

  /**
   * Refresh the targeted block. Called once per frame before update().
   * @returns {object|null}
   */
  refreshTarget() {
    const isTargetable = (id) => BlockRegistry.isTargetable(id);
    const hit = pickBlock(this.world, this.camera, this.reach, isTargetable);
    if (!hit) {
      this.target = null;
      this.breakProgress = 0;
      this.breakingKey = null;
      return null;
    }
    // Copy out of the shared raycast record.
    this.target = {
      x: hit.x, y: hit.y, z: hit.z, id: hit.id,
      face: hit.face, nx: hit.nx, ny: hit.ny, nz: hit.nz,
      distance: hit.distance
    };
    return this.target;
  }

  /**
   * Handle break/place for this step.
   * @param {number} dt
   * @param {import('../systems/Input.js').Input} input
   */
  update(dt, input) {
    this.refreshTarget();

    const wantsBreak = input.isDown('break');
    const wantsPlace = input.isDown('place');

    if (this.breakRepeatTimer > 0) this.breakRepeatTimer -= dt;
    if (this.placeRepeatTimer > 0) this.placeRepeatTimer -= dt;

    if (wantsBreak) {
      // A fresh click attacks a mob when one is in reach; otherwise (and while
      // the button stays held) the click mines the targeted block.
      if (input.wasPressed('break') && this.attackMob()) {
        this.breakProgress = 0;
        this.breakingKey = null;
      } else {
        this.updateBreaking(dt);
      }
    } else {
      this.breakProgress = 0;
      this.breakingKey = null;
    }

    if (wantsPlace) {
      if (input.wasPressed('place') || this.placeRepeatTimer <= 0) {
        if (this.tryPlace()) this.placeRepeatTimer = INTERACTION.repeatPlaceDelay;
      }
    }

    if (input.wasPressed('pick')) this.pickBlockIntoHotbar();
    if (input.wasPressed('drop')) this.dropHeldItem();
  }

  /** Advance (and possibly complete) the current break. */
  updateBreaking(dt) {
    const target = this.target;
    if (!target) {
      this.breakProgress = 0;
      this.breakingKey = null;
      return;
    }
    if (BlockRegistry.isUnbreakable(target.id)) {
      this.breakProgress = 0;
      return;
    }

    const key = `${target.x},${target.y},${target.z}`;
    if (this.breakingKey !== key) {
      // Switched to a different block: start over.
      this.breakingKey = key;
      this.breakProgress = 0;
    }

    const hardness = Math.max(0, BlockRegistry.hardness(target.id));
    if (this.instantBreak || hardness <= 0) {
      this.breakBlock(target.x, target.y, target.z);
      this.breakProgress = 0;
      this.breakingKey = null;
      this.breakRepeatTimer = INTERACTION.repeatBreakDelay;
      return;
    }

    this.breakProgress += (dt * BREAK_SPEED) / hardness;
    if (this.breakProgress >= 1) {
      this.breakBlock(target.x, target.y, target.z);
      this.breakProgress = 0;
      this.breakingKey = null;
      this.breakRepeatTimer = INTERACTION.repeatBreakDelay;
    }
  }

  /**
   * Destroy a block, spawn its drop and emit feedback.
   * @returns {boolean} true when a block was removed
   */
  breakBlock(x, y, z) {
    const previous = this.world.getBlock(x, y, z);
    if (previous === BlockId.AIR || BlockRegistry.isUnbreakable(previous)) return false;
    if (!this.world.setBlock(x, y, z, BlockId.AIR)) return false;

    // Drop the block's item.
    const drop = BlockRegistry.drops(previous);
    if (drop && drop.item && drop.item !== 'air') {
      const count = drop.min + Math.floor(Math.random() * (drop.max - drop.min + 1));
      if (count > 0) {
        this.entities.spawnItem(x + 0.5, y + 0.35, z + 0.5, drop.item, count);
      }
    }

    this.particles.spawnBlockBreak(x, y, z, previous, 14);
    this.audio.playBlockSound('break', BlockRegistry.sound(previous));
    this.player.blocksBroken++;
    this.bus.emit('blockBroken', { x, y, z, id: previous });
    return true;
  }

  /**
   * Place the held item against the targeted face.
   * @returns {boolean} true when a block was placed
   */
  tryPlace() {
    const target = this.target;
    if (!target) return false;

    const stack = this.player.heldStack();
    if (!stack) return false;
    const blockId = ItemRegistry.blockIdOf(stack.item);
    if (blockId === null || blockId === BlockId.AIR) return false;

    // If the targeted block is itself replaceable (a plant), overwrite it in
    // place; otherwise place against the face that was hit.
    let placeX = target.x;
    let placeY = target.y;
    let placeZ = target.z;
    if (!REPLACEABLE[target.id]) {
      placeX += target.nx;
      placeY += target.ny;
      placeZ += target.nz;
    }

    if (placeY < 0 || placeY >= 128) return false;

    const existing = this.world.getBlock(placeX, placeY, placeZ);
    if (!REPLACEABLE[existing]) return false;
    // Never place inside the block the player is standing in if it is solid.
    if (existing === blockId) return false;

    // Refuse to entomb the player in a solid block.
    if (SOLID[blockId] === 1 && this.wouldTrapPlayer(placeX, placeY, placeZ)) return false;

    if (!this.world.setBlock(placeX, placeY, placeZ, blockId)) return false;

    this.player.inventory.removeAt(this.player.selectedSlot, 1);
    this.particles.spawnBlockPlace(placeX, placeY, placeZ, blockId, 8);
    this.audio.playBlockSound('place', BlockRegistry.sound(blockId));
    this.player.blocksPlaced++;
    this.bus.emit('blockPlaced', { x: placeX, y: placeY, z: placeZ, id: blockId });
    return true;
  }

  /** True when placing a solid block at this cell would intersect the player. */
  wouldTrapPlayer(x, y, z) {
    const player = this.player;
    const half = player.halfWidth;
    const height = PLAYER.height;
    const minX = player.x - half;
    const maxX = player.x + half;
    const minY = player.y;
    const maxY = player.y + height;
    const minZ = player.z - half;
    const maxZ = player.z + half;
    // Standard AABB overlap test between the block cell and the player box.
    return (x + 1 > minX && x < maxX && y + 1 > minY && y < maxY && z + 1 > minZ && z < maxZ);
  }

  /** Middle click: select the hotbar slot holding the targeted block. */
  pickBlockIntoHotbar() {
    const target = this.target;
    if (!target) return;
    const itemKey = ItemRegistry.itemOfBlock(target.id);
    if (!itemKey) return;
    const index = this.player.inventory.slots
      .slice(0, 9)
      .findIndex((slot) => slot && slot.item === itemKey);
    if (index >= 0) {
      this.player.selectHotbar(index);
      this.bus.emit('hotbarPicked', { item: itemKey, slot: index });
    }
  }

  /** Q: drop one item from the selected slot into the world. */
  dropHeldItem() {
    const stack = this.player.heldStack();
    if (!stack) return;
    const direction = this.player.lookDirection();
    const removed = this.player.inventory.removeAt(this.player.selectedSlot, 1);
    if (removed <= 0) return;
    const entity = this.entities.spawnItem(
      this.player.x + direction.x * 0.6,
      this.player.eyeY - 0.3,
      this.player.z + direction.z * 0.6,
      stack.item, removed
    );
    if (entity) {
      entity.velocityX = direction.x * 5.2;
      entity.velocityY = direction.y * 5.2 + 1.2;
      entity.velocityZ = direction.z * 5.2;
      entity.pickupDelay = 1.2; // do not instantly re-collect it
    }
  }

  /**
   * Attack whatever mob is in front of the player.
   * @returns {boolean} true when something was hit
   */
  attackMob() {
    const direction = this.player.lookDirection();
    const hit = this.entities.raycastMob(
      this.camera.x, this.camera.y, this.camera.z,
      direction.x, direction.y, direction.z,
      this.reach
    );
    if (!hit) return false;
    // Skip the hit if a block is in the way.
    const blockHit = pickBlock(this.world, this.camera, hit.distance, (id) => BlockRegistry.isTargetable(id));
    if (blockHit) return false;

    const mob = hit.entity;
    mob.hurt(4, { world: this.world, bus: this.bus, entities: this.entities, player: this.player }, true);
    this.particles.spawnMobHit(mob.x, mob.y + mob.height * 0.6, mob.z, 8);
    this.audio.play('hit');
    this.bus.emit('playerAttacked', { entity: mob, damage: 4 });
    return true;
  }

  /** Reset transient state (used when pausing or changing worlds). */
  reset() {
    this.target = null;
    this.breakProgress = 0;
    this.breakingKey = null;
  }
}

/** Guard: keep block ids inside the byte range used by chunk storage. */
if (BlockId.AIR !== 0 || BlockRegistry.maxId >= BLOCK_ID_LIMIT) {
  throw new Error('[Interaction] block registry is inconsistent with chunk storage');
}
