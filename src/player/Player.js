/**
 * Player.js — player state and everything derived from it (health, breath,
 * hunger-free survival rules, spawn point, inventory).
 *
 * This is a plain data object with small helpers: the movement maths lives in
 * PlayerController and the world edits live in Interaction, so each file stays
 * focused.
 */

import { PLAYER } from '../core/Config.js';
import { Inventory } from './Inventory.js';
import { ItemRegistry } from '../world/Items.js';

export class Player {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   */
  constructor(bus) {
    this.bus = bus;

    // ---- Position and orientation ----------------------------------------
    /** Feet-centre position (the collision box bottom centre). */
    this.x = 0;
    this.y = 80;
    this.z = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.yaw = 0;
    this.pitch = 0;

    // ---- Movement flags ---------------------------------------------------
    this.onGround = false;
    this.inWater = false;
    this.headInWater = false;
    this.sprinting = false;
    this.crouching = false;
    this.flying = false;
    /** Current eye height, animated while crouching. */
    this.eyeHeight = PLAYER.height - PLAYER.eyeOffset;
    /** Distance fallen since last touching ground; drives fall damage. */
    this.fallDistance = 0;
    /** Walk-cycle phase, drives footstep sounds and view bobbing. */
    this.walkPhase = 0;
    /** Horizontal distance travelled since the last footstep. */
    this.distanceSinceStep = 0;

    // ---- Survival ---------------------------------------------------------
    this.maxHealth = PLAYER.maxHealth;
    this.health = PLAYER.maxHealth;
    this.breath = PLAYER.maxBreathSeconds;
    this.dead = false;
    this.secondsSinceDamage = 999;

    // ---- Inventory --------------------------------------------------------
    this.inventory = new Inventory();
    this.selectedSlot = 0;

    // ---- Spawn ------------------------------------------------------------
    /** Where the player respawns after dying. */
    this.spawnX = 0;
    this.spawnY = 80;
    this.spawnZ = 0;

    // ---- Statistics -------------------------------------------------------
    this.blocksBroken = 0;
    this.blocksPlaced = 0;
    this.distanceWalked = 0;
    this.damageTaken = 0;
    this.deaths = 0;
  }

  /** Eye position (where the camera sits). */
  get eyeY() {
    return this.y + this.eyeHeight;
  }

  /** Half-width of the collision box. */
  get halfWidth() {
    return PLAYER.width / 2;
  }

  /** Current collision box height (shorter while crouching). */
  get height() {
    return this.crouching ? PLAYER.crouchHeight : PLAYER.height;
  }

  /** Look direction as a unit vector. */
  lookDirection() {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  /** Move the player to a spawn point and reset motion. */
  teleport(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.fallDistance = 0;
  }

  /** Record the respawn point. */
  setSpawn(x, y, z) {
    this.spawnX = x;
    this.spawnY = y;
    this.spawnZ = z;
  }

  /**
   * Apply damage, respecting invulnerability while already dead.
   * @param {number} amount in half-hearts
   * @param {string} [cause] shown in the death message
   */
  damage(amount, cause = 'the world') {
    if (this.dead || amount <= 0) return false;
    this.health = Math.max(0, this.health - amount);
    this.damageTaken += amount;
    this.secondsSinceDamage = 0;
    this.bus.emit('playerDamaged', { amount, health: this.health, cause });
    if (this.health <= 0) {
      this.dead = true;
      this.deaths++;
      this.bus.emit('playerDied', { cause });
    }
    return true;
  }

  /** Restore health. */
  heal(amount) {
    if (this.dead) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
    this.bus.emit('playerHealed', { amount, health: this.health });
  }

  /** Full reset used on respawn: health, breath and motion. */
  respawn() {
    this.dead = false;
    this.health = this.maxHealth;
    this.breath = PLAYER.maxBreathSeconds;
    this.secondsSinceDamage = 999;
    this.fallDistance = 0;
    this.velocityX = 0;
    this.velocityY = 0;
    this.velocityZ = 0;
    this.teleport(this.spawnX, this.spawnY, this.spawnZ);
    this.bus.emit('playerRespawned', { x: this.spawnX, y: this.spawnY, z: this.spawnZ });
  }

  /** The item stack in the currently selected hotbar slot, or null. */
  heldStack() {
    return this.inventory.get(this.selectedSlot);
  }

  /**
   * Tool behaviour of the held item, or null when it is not a tool.
   * @returns {import('../world/Items.js').ToolStats|null}
   */
  heldTool() {
    const stack = this.heldStack();
    return stack ? ItemRegistry.tool(stack.item) : null;
  }

  /**
   * Spend uses of the held tool, breaking it when its durability runs out.
   * @param {number} amount
   * @returns {boolean} true when the tool broke on this use
   */
  damageHeldTool(amount = 1) {
    const stack = this.heldStack();
    if (!stack) return false;
    const max = ItemRegistry.durability(stack.item);
    if (max <= 0) return false;
    const current = stack.durability === undefined ? max : stack.durability;
    const next = current - amount;
    if (next <= 0) {
      this.inventory.set(this.selectedSlot, null);
      this.bus.emit('toolBroke', { item: stack.item, slot: this.selectedSlot });
      return true;
    }
    stack.durability = next;
    this.bus.emit('toolDamaged', { item: stack.item, durability: next, max });
    return false;
  }

  /** Attack damage of the held item, in half-hearts (1 for a bare fist). */
  attackDamage() {
    const tool = this.heldTool();
    return tool ? tool.damage : 1;
  }

  /**
   * Advance the selected hotbar slot.
   * @param {number} direction +1 or -1
   */
  cycleHotbar(direction) {
    const next = ((this.selectedSlot + direction) % 9 + 9) % 9;
    if (next === this.selectedSlot) return;
    this.selectedSlot = next;
    this.bus.emit('hotbarChanged', this.selectedSlot);
  }

  /** Choose a hotbar slot directly (0..8). */
  selectHotbar(index) {
    if (index < 0 || index > 8 || index === this.selectedSlot) return;
    this.selectedSlot = index;
    this.bus.emit('hotbarChanged', index);
  }

  /** Serialise the parts of the player the save system stores. */
  serialize() {
    return {
      x: this.x, y: this.y, z: this.z,
      yaw: this.yaw, pitch: this.pitch,
      health: this.health,
      breath: this.breath,
      selectedSlot: this.selectedSlot,
      spawn: { x: this.spawnX, y: this.spawnY, z: this.spawnZ },
      inventory: this.inventory.serialize(),
      stats: {
        blocksBroken: this.blocksBroken,
        blocksPlaced: this.blocksPlaced,
        distanceWalked: Math.round(this.distanceWalked),
        deaths: this.deaths
      }
    };
  }

  /**
   * Restore from a save. Every field is validated so a corrupt save cannot
   * put the player in an impossible state.
   * @param {object} data
   * @param {import('../world/World.js').World} world used to verify the position
   * @returns {{warnings:string[]}}
   */
  deserialize(data, world) {
    const warnings = [];
    if (!data || typeof data !== 'object') return { warnings: ['no player data'] };

    const finite = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

    this.x = finite(data.x, this.x);
    this.y = finite(data.y, this.y);
    this.z = finite(data.z, this.z);
    this.yaw = finite(data.yaw, 0);
    this.pitch = finite(data.pitch, 0);
    if (this.y < 0 || this.y > 400) {
      warnings.push('player position was out of range and has been reset');
      this.y = 90;
    }

    this.health = Math.max(1, Math.min(this.maxHealth, finite(data.health, this.maxHealth)));
    this.breath = Math.max(0, Math.min(PLAYER.maxBreathSeconds, finite(data.breath, PLAYER.maxBreathSeconds)));
    this.dead = false;

    const slot = finite(data.selectedSlot, 0) | 0;
    this.selectedSlot = slot >= 0 && slot < 9 ? slot : 0;

    if (data.spawn && typeof data.spawn === 'object') {
      this.spawnX = finite(data.spawn.x, this.x);
      this.spawnY = finite(data.spawn.y, this.y);
      this.spawnZ = finite(data.spawn.z, this.z);
    } else {
      this.setSpawn(this.x, this.y, this.z);
    }

    const inv = this.inventory.deserialize(data.inventory);
    if (inv.skipped > 0) warnings.push(`${inv.skipped} inventory slot(s) were invalid and skipped`);

    if (data.stats && typeof data.stats === 'object') {
      this.blocksBroken = finite(data.stats.blocksBroken, 0);
      this.blocksPlaced = finite(data.stats.blocksPlaced, 0);
      this.distanceWalked = finite(data.stats.distanceWalked, 0);
      this.deaths = finite(data.stats.deaths, 0);
    }
    return { warnings };
  }
}
