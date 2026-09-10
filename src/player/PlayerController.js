/**
 * PlayerController.js — first person movement, collision and camera placement.
 *
 * Movement model
 *  - The desired horizontal velocity comes from the WASD axes, rotated into
 *    world space by the yaw.
 *  - Velocity is accelerated towards that target at a fixed rate (high on the
 *    ground, low in the air), which gives responsive control without the
 *    ice-skating feel of pure friction.
 *  - Gravity, jumping, swimming and fall damage are applied every step.
 *  - Movement is resolved axis-by-axis against the voxel grid by Physics.js.
 *  - Finally the camera is placed at the player's eye with view bobbing.
 *
 * The controller runs on a fixed timestep (see Game.js) so behaviour does not
 * change with the frame rate.
 */

import { PLAYER, RENDER } from '../core/Config.js';
import { moveBox, isOnGround, boxIntersectsWorld, findSafeY } from './Physics.js';
import { BlockRegistry } from '../world/Blocks.js';
import { clamp } from '../core/Math3D.js';

/** Distance between footstep sounds while walking, in blocks. */
const STRIDE_LENGTH = 2.1;

/** Maximum slope of the eye-height animation while crouching, blocks/second. */
const CROUCH_SPEED = 4.0;

/**
 * Move `current` towards `target` by at most `maxDelta`.
 */
function approach(current, target, maxDelta) {
  const delta = target - current;
  if (delta > maxDelta) return current + maxDelta;
  if (delta < -maxDelta) return current - maxDelta;
  return target;
}

export class PlayerController {
  /**
   * @param {import('./Player.js').Player} player
   * @param {import('../world/World.js').World} world
   * @param {import('../player/Camera.js').Camera} camera
   * @param {import('../core/EventBus.js').EventBus} bus
   */
  constructor(player, world, camera, bus) {
    this.player = player;
    this.world = world;
    this.camera = camera;
    this.bus = bus;

    /** Highest Y reached since leaving the ground; drives fall damage. */
    this.fallStartY = player.y;
    /** Smoothed eye height so crouching animates instead of snapping. */
    this.targetEyeHeight = PLAYER.height - PLAYER.eyeOffset;
    /** Time spent walking, used for the bob phase. */
    this.bobPhase = 0;
    /** Amplitude of the current view bob, eased in and out. */
    this.bobAmount = 0;
    /** Set while the controller is frozen (menus, death screen). */
    this.frozen = true;
    /** Base field of view in degrees; the sprint boost is added on top. */
    this.baseFov = RENDER.fov;
    /** Extra look sensitivity multiplier from the settings screen. */
    this.sensitivityScale = 1;
    /** When true, vertical mouse movement is inverted. */
    this.invertY = false;
  }

  /**
   * Advance the player by one fixed step.
   * @param {number} dt seconds (typically 1/60)
   * @param {import('../systems/Input.js').Input} input
   */
  update(dt, input) {
    const player = this.player;
    if (player.dead) {
      // A dead player keeps falling so the death screen shows the body land.
      this.applyGravityOnly(dt);
      this.updateCamera(dt, 0);
      return;
    }

    // ---- Look -------------------------------------------------------------
    if (!this.frozen) {
      const look = input.consumeMouseDelta();
      if (look.yaw !== 0 || look.pitch !== 0) {
        const pitchDelta = this.invertY ? -look.pitch : look.pitch;
        player.yaw += look.yaw * this.sensitivityScale;
        player.pitch = clamp(
          player.pitch + pitchDelta * this.sensitivityScale,
          -Math.PI / 2 + 0.001, Math.PI / 2 - 0.001
        );
      }
    }

    // ---- Environment probes ----------------------------------------------
    const feetBlockY = Math.floor(player.y + 0.1);
    const midBlockY = Math.floor(player.y + player.height * 0.5);
    player.inWater = this.world.isLiquid(Math.floor(player.x), feetBlockY, Math.floor(player.z))
      || this.world.isLiquid(Math.floor(player.x), midBlockY, Math.floor(player.z));
    player.headInWater = this.world.isLiquid(Math.floor(player.x), Math.floor(player.eyeY), Math.floor(player.z));

    // ---- Wanted movement --------------------------------------------------
    let moveForward = 0;
    let moveRight = 0;
    if (!this.frozen) {
      if (input.isDown('forward')) moveForward += 1;
      if (input.isDown('back')) moveForward -= 1;
      if (input.isDown('right')) moveRight += 1;
      if (input.isDown('left')) moveRight -= 1;
    }

    const wantsSprint = !this.frozen && input.isDown('sprint') && moveForward > 0 && !player.crouching;
    player.sprinting = wantsSprint && !player.inWater;

    // Crouch: only shrink when nothing blocks the lower profile.
    const wantsCrouch = !this.frozen && input.isDown('crouch');
    if (wantsCrouch) player.crouching = true;
    else if (player.crouching && this.canStandUp()) player.crouching = false;

    // Normalise so diagonal movement is not faster.
    const magnitude = Math.hypot(moveForward, moveRight);
    let wishX = 0;
    let wishZ = 0;
    if (magnitude > 0) {
      const inv = 1 / magnitude;
      moveForward *= inv;
      moveRight *= inv;
      const sin = Math.sin(player.yaw);
      const cos = Math.cos(player.yaw);
      // yaw 0 looks towards -Z; strafing right moves towards +X.
      wishX = moveRight * cos - moveForward * sin;
      wishZ = -moveRight * sin - moveForward * cos;
    }

    let speed = player.sprinting ? PLAYER.sprintSpeed : player.crouching ? PLAYER.crouchSpeed : PLAYER.walkSpeed;
    if (player.inWater) speed *= PLAYER.swimSpeedMultiplier;

    // ---- Horizontal acceleration -----------------------------------------
    const accel = player.onGround ? PLAYER.groundAccel : (player.inWater ? PLAYER.groundAccel * 0.4 : PLAYER.airAccel);
    const targetX = wishX * speed;
    const targetZ = wishZ * speed;
    if (magnitude > 0) {
      player.velocityX = approach(player.velocityX, targetX, accel * dt);
      player.velocityZ = approach(player.velocityZ, targetZ, accel * dt);
    } else {
      const braking = (player.onGround ? PLAYER.groundFriction : PLAYER.airDrag) * dt;
      player.velocityX = approach(player.velocityX, 0, Math.max(braking, 0.0001));
      player.velocityZ = approach(player.velocityZ, 0, Math.max(braking, 0.0001));
    }
    // Hard clamp as a safety net against accumulating speed.
    const horizontal = Math.hypot(player.velocityX, player.velocityZ);
    if (horizontal > PLAYER.maxHorizontalSpeed) {
      const scale = PLAYER.maxHorizontalSpeed / horizontal;
      player.velocityX *= scale;
      player.velocityZ *= scale;
    }

    // ---- Vertical motion --------------------------------------------------
    const wantsJump = !this.frozen && input.isDown('jump');
    if (player.inWater) {
      // Swimming: buoyancy replaces gravity, jump swims up, otherwise sink slowly.
      const targetY = wantsJump ? PLAYER.swimUpVelocity : PLAYER.swimSinkVelocity;
      player.velocityY = approach(player.velocityY, targetY, PLAYER.gravity * 0.5 * dt);
    } else if (wantsJump && player.onGround) {
      player.velocityY = PLAYER.jumpVelocity;
      player.onGround = false;
      this.bus.emit('playerJumped');
    } else {
      player.velocityY -= PLAYER.gravity * dt;
      if (player.velocityY < -PLAYER.terminalVelocity) player.velocityY = -PLAYER.terminalVelocity;
    }

    // ---- Integrate and collide -------------------------------------------
    const startX = player.x;
    const startZ = player.z;

    const moved = moveBox(
      this.world,
      player.x, player.y, player.z,
      player.halfWidth, player.height,
      player.velocityX * dt, player.velocityY * dt, player.velocityZ * dt
    );

    player.x = moved.x;
    player.y = moved.y;
    player.z = moved.z;

    if (moved.hitX) player.velocityX = 0;
    if (moved.hitZ) player.velocityZ = 0;
    if (moved.hitY) {
      if (player.velocityY < 0) this.onLanded();
      player.velocityY = 0;
    }

    player.onGround = isOnGround(this.world, player.x, player.y, player.z, player.halfWidth);

    // ---- Fall tracking ----------------------------------------------------
    if (player.onGround) {
      this.fallStartY = player.y;
      player.fallDistance = 0;
    } else if (player.inWater) {
      // Water breaks the fall entirely.
      this.fallStartY = player.y;
      player.fallDistance = 0;
    } else if (player.y > this.fallStartY) {
      this.fallStartY = player.y;
    }

    // ---- Fall out of the world safety net --------------------------------
    if (player.y < -8) {
      player.damage(4, 'the void');
      this.respawnAtSpawn();
    }

    // ---- Statistics and footsteps ----------------------------------------
    const travelled = Math.hypot(player.x - startX, player.z - startZ);
    player.distanceWalked += travelled;
    if (player.onGround && travelled > 0) {
      player.distanceSinceStep += travelled;
      if (player.distanceSinceStep >= STRIDE_LENGTH) {
        player.distanceSinceStep = 0;
        this.emitFootstep();
      }
    }
    this.updateCamera(dt, travelled);
  }

  /** Gravity-only integration used while the player is dead. */
  applyGravityOnly(dt) {
    const player = this.player;
    player.velocityY -= PLAYER.gravity * dt;
    const moved = moveBox(
      this.world, player.x, player.y, player.z,
      player.halfWidth, player.height,
      0, player.velocityY * dt, 0
    );
    player.x = moved.x;
    player.y = moved.y;
    player.z = moved.z;
    if (moved.hitY) player.velocityY = 0;
  }

  /** Called when the player transitions from airborne to grounded. */
  onLanded() {
    const player = this.player;
    const fallDistance = this.fallStartY - player.y;
    player.fallDistance = fallDistance;
    if (fallDistance > PLAYER.safeFallDistance + 0.5) {
      const damage = Math.floor((fallDistance - PLAYER.safeFallDistance) * PLAYER.fallDamagePerBlock);
      if (damage > 0) {
        player.damage(damage, 'a hard landing');
        this.bus.emit('playerLanded', { fallDistance, damage });
      }
    } else {
      this.bus.emit('playerLanded', { fallDistance, damage: 0 });
    }
    this.fallStartY = player.y;
  }

  /** True when there is room for the standing-height box at the current spot. */
  canStandUp() {
    const player = this.player;
    const feet = Math.floor(player.y + 0.05);
    const head = Math.floor(player.y + PLAYER.height - 0.05);
    for (let y = feet; y <= head; y++) {
      if (this.world.isSolid(Math.floor(player.x), y, Math.floor(player.z))) return false;
    }
    return true;
  }

  /** Emit a footstep event carrying the block being walked on. */
  emitFootstep() {
    const player = this.player;
    const groundY = Math.floor(player.y - 0.15);
    const id = this.world.getBlock(Math.floor(player.x), groundY, Math.floor(player.z));
    this.bus.emit('footstep', { blockId: id, sound: BlockRegistry.sound(id) });
  }

  /**
   * Place the camera at the eye position, with crouch animation and view bob.
   * @param {number} dt
   * @param {number} travelled horizontal distance moved this step
   */
  updateCamera(dt, travelled) {
    const player = this.player;

    // Crouch height eases in and out rather than snapping.
    const wantedEye = (player.crouching ? PLAYER.crouchHeight : PLAYER.height) - PLAYER.eyeOffset;
    this.targetEyeHeight = approach(this.targetEyeHeight, wantedEye, CROUCH_SPEED * dt);
    player.eyeHeight = this.targetEyeHeight;

    // View bob: only while actually moving on the ground.
    const moving = player.onGround && travelled > 0.0005 && !player.crouching;
    const wantedBob = moving ? 1 : 0;
    this.bobAmount = approach(this.bobAmount, wantedBob, dt * 6);
    if (moving) {
      this.bobPhase += travelled * RENDER.viewBobFrequency * Math.PI;
      if (this.bobPhase > Math.PI * 1000) this.bobPhase -= Math.PI * 1000;
    }

    const bobVertical = Math.sin(this.bobPhase * 2) * RENDER.viewBobAmount * this.bobAmount;
    const bobRoll = Math.cos(this.bobPhase) * RENDER.viewBobAmount * 0.22 * this.bobAmount;

    this.camera.x = player.x;
    this.camera.y = player.eyeY + bobVertical;
    this.camera.z = player.z;
    this.camera.yaw = player.yaw;
    this.camera.pitch = player.pitch;
    this.camera.roll = bobRoll;

    // Sprinting widens the field of view slightly for a sense of speed.
    const wantedFov = this.baseFov + (player.sprinting ? RENDER.sprintFovBoost : 0);
    this.camera.fov = wantedFov;
    this.camera.currentFov += (wantedFov - this.camera.currentFov) * Math.min(1, dt * 8);
  }

  /**
   * Teleport the player to the spawn point, resolving a safe Y first.
   * Used on respawn and when a save would otherwise place them inside terrain.
   */
  respawnAtSpawn() {
    const player = this.player;
    const safeY = findSafeY(
      this.world, player.spawnX, player.spawnZ,
      player.halfWidth, PLAYER.height, player.spawnY + 1
    );
    player.teleport(player.spawnX, safeY >= 0 ? safeY : player.spawnY, player.spawnZ);
    this.fallStartY = player.y;
    this.bobPhase = 0;
  }

  /**
   * Push the player out of terrain if they ended up embedded in it (loading a
   * save after blocks changed, or a chunk streaming in around them).
   * @returns {boolean} true when the player was moved
   */
  resolveStuck() {
    const player = this.player;
    if (!boxIntersectsWorld(this.world, player.x, player.y, player.z, player.halfWidth, player.height)) {
      return false;
    }
    const safeY = findSafeY(
      this.world, player.x, player.z,
      player.halfWidth, player.height, Math.floor(player.y) + 1, 12
    );
    if (safeY < 0) return false;
    player.teleport(player.x, safeY, player.z);
    this.fallStartY = player.y;
    return true;
  }
}
