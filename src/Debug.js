/**
 * Debug.js — the automation and inspection surface.
 *
 * When Config.DEBUG.exposeDebugApi is on, these helpers are exposed as
 * `game.debug`, `window.VH` and as `window.__VOXELHAVEN__.debug`. They let the
 * integration tests drive a real session — create a world, walk, break and
 * place blocks, save, reload — without simulating raw mouse movement, and they
 * double as a console for manual debugging.
 *
 * Nothing here is required for normal play: the game behaves identically with
 * the API disabled.
 */

import { BlockRegistry } from './world/Blocks.js';
import { boxIntersectsWorld } from './player/Physics.js';
import { ItemRegistry } from './world/Items.js';
import { GameState } from './GameState.js';

/**
 * Attach the debug helpers to a Game instance.
 * @param {import('./Game.js').Game} game
 */
export function installDebugApi(game) {
  // The API is deliberately NOT merged into the Game instance: several names
  // (createWorld, saveNow, respawn, state...) would collide, and Object.assign
  // would flatten the `state` getter into a frozen string.
  // Bind the real Game methods up front so the API can call them even though
  // the API itself is reachable from the same object.
  const gameCreateWorld = game.createWorld.bind(game);
  const gameLoadWorld = game.loadWorld.bind(game);
  const gameSaveNow = game.saveNow.bind(game);
  const gameQuitToMenu = game.quitToMenu.bind(game);
  const gameRespawn = game.respawn.bind(game);

  const api = {
    /** The raw game instance. */
    game,
    /** Current GameState string (mirrors game.state). */
    get state() { return game.state; },

    // ---------------------------------------------------------------------
    // Session control
    // ---------------------------------------------------------------------

    /** Create a world and resolve once it is playable. */
    async createWorld(options = {}) {
      await gameCreateWorld({
        name: options.name || 'Test World',
        seed: options.seed !== undefined ? options.seed : 12345,
        peaceful: options.peaceful !== undefined ? options.peaceful : true
      });
      await api.waitForState([GameState.PLAYING], options.timeoutMs || 120000);
      return api.snapshot();
    },

    /** Load a stored world and resolve once it is playable. */
    async loadWorld(id, options = {}) {
      await gameLoadWorld(id);
      await api.waitForState([GameState.PLAYING], options.timeoutMs || 120000);
      return api.snapshot();
    },

    /** Save the world now. */
    saveNow() { return gameSaveNow({ announce: false }); },

    /** Save and return to the menu. */
    quit() { return gameQuitToMenu(); },

    /** Wait until the game enters one of these states. */
    async waitForState(states, timeoutMs = 60000) {
      const list = Array.isArray(states) ? states : [states];
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (list.includes(game.state)) return game.state;
        await new Promise((r) => setTimeout(r, 60));
      }
      throw new Error(`debug.waitForState timed out; state is "${game.state}", wanted ${list.join('|')}`);
    },

    /** Wait until the chunk streaming queue is empty. */
    async waitForChunks(timeoutMs = 90000) {
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (game.chunkManager && game.chunkManager.pendingChunks === 0
          && game.chunkManager.workQueue.size === 0) return true;
        await new Promise((r) => setTimeout(r, 80));
      }
      return false;
    },

    // ---------------------------------------------------------------------
    // Player
    // ---------------------------------------------------------------------

    /** Teleport the player (feet position). */
    teleport(x, y, z) {
      game.player.teleport(x, y, z);
      game.playerController.fallStartY = y;
      return api.snapshot();
    },

    /** Set the player's look angles (radians). */
    look(yaw, pitch) {
      game.player.yaw = yaw;
      game.player.pitch = pitch;
      return api.snapshot();
    },

    /** Point the camera at a block centre. */
    lookAt(x, y, z) {
      const player = game.player;
      const dx = (x + 0.5) - player.x;
      const dy = (y + 0.5) - (player.y + player.eyeHeight);
      const dz = (z + 0.5) - player.z;
      const horizontal = Math.hypot(dx, dz);
      player.yaw = Math.atan2(-dx, -dz);
      player.pitch = Math.atan2(dy, horizontal);
      return api.snapshot();
    },

    /** Give items directly to the inventory. */
    give(item, count = 1) {
      const leftover = game.player.inventory.add(item, count);
      game.hud.refreshHotbar(game.player);
      return { item, added: count - leftover, leftover };
    },

    /** Select a hotbar slot 0..8. */
    selectSlot(index) {
      game.player.selectHotbar(index);
      return game.player.selectedSlot;
    },

    /** Set health (for damage/respawn tests). */
    setHealth(value) {
      game.player.health = value;
      game.hud.refreshHealth(value);
      return game.player.health;
    },

    /** Force death. */
    kill() {
      game.player.damage(1000, 'the debug console');
      return api.snapshot();
    },

    /** Respawn after death. */
    respawn() {
      gameRespawn();
      return api.snapshot();
    },

    // ---------------------------------------------------------------------
    // World access
    // ---------------------------------------------------------------------

    /** Read a block by world coordinates; returns its registry key. */
    getBlock(x, y, z) {
      const id = game.world.getBlock(x, y, z);
      return BlockRegistry.get(id).key;
    },

    /** Raw numeric block id. */
    getBlockId(x, y, z) {
      return game.world.getBlock(x, y, z);
    },

    /**
     * Write a block directly (bypasses the inventory, still records an edit).
     * @returns {boolean} true when the world changed
     */
    setBlock(x, y, z, key) {
      const def = BlockRegistry.byKey(key);
      if (!def) throw new Error(`unknown block key "${key}"`);
      return game.world.setBlock(x, y, z, def.id);
    },

    /** Break a block through the normal interaction path (spawns a drop). */
    breakBlock(x, y, z) {
      return game.interaction.breakBlock(x, y, z);
    },

    /** Light levels at a position. */
    getLight(x, y, z) {
      return {
        sky: game.world.getSkyLight(x, y, z),
        block: game.world.getBlockLight(x, y, z),
        combined: game.world.getLight(x, y, z)
      };
    },

    /** The block currently under the crosshair, or null. */
    getTarget() {
      game.interaction.refreshTarget();
      const target = game.interaction.target;
      if (!target) return null;
      return { ...target, key: BlockRegistry.get(target.id).key };
    },

    /** Break whatever block the player is aiming at, ignoring break time. */
    breakTarget() {
      game.interaction.refreshTarget();
      const target = game.interaction.target;
      if (!target) return false;
      return game.interaction.breakBlock(target.x, target.y, target.z);
    },

    /** Place the held item against the targeted face. */
    placeAtTarget() {
      game.interaction.refreshTarget();
      return game.interaction.tryPlace();
    },

    /**
     * Spawn a mob at an exact position. Unlike spawnMobNear this ignores the
     * natural-spawn distance rules, which makes it usable inside a test arena.
     */
    async spawnMobAt(type, x, y, z) {
      const module = type === 'woolback'
        ? await import('./entities/Woolback.js')
        : await import('./entities/Gloomling.js');
      const EntityClass = type === 'woolback' ? module.Woolback : module.Gloomling;
      const entity = game.entityManager.spawn(new EntityClass(x, y, z));
      return entity ? { type: entity.type, x: entity.x, y: entity.y, z: entity.z, health: entity.health } : null;
    },

    /** Spawn a mob a few blocks in front of the player. */
    spawnMob(type) {
      const player = game.player;
      const direction = player.lookDirection();
      const x = player.x + direction.x * 4;
      const z = player.z + direction.z * 4;
      const y = player.y + 1;
      const entity = type === 'woolback'
        ? game.entityManager.spawnMobNear('woolback', player.x, player.y, player.z)
        : game.entityManager.spawnMobNear('gloomling', player.x, player.y, player.z);
      void x; void y; void z;
      return entity ? entity.type : null;
    },

    /** Spawn a dropped item at a position. */
    dropItem(x, y, z, item, count = 1) {
      const entity = game.entityManager.spawnItem(x, y, z, item, count);
      return !!entity;
    },

    /** Advance the world clock to a normalised time of day. */
    setTime(t) {
      game.timeSystem.setTime(t);
      return game.timeSystem.getEnvironment().dayBrightness;
    },

    /** Change the render distance (used by tests to keep runs short). */
    setRenderDistance(chunks) {
      game.setRenderDistance(chunks);
      return game.chunkManager ? game.chunkManager.renderDistance : chunks;
    },

    /**
     * Measure the view-space held-item mesh for the current frame.
     *
     * The mesh always contains the arm boxes, so the item's contribution is
     * derived by comparison: with a stack selected there is exactly one more
     * box than with the slot empty. Tests use this to prove the arm renders
     * even when the hand is empty, and that the item adds geometry only when
     * something is actually held.
     */
    heldMeshStats() {
      const mesh = game.renderer.heldItemMesh;
      const stride = 11;
      /** Every box contributes 6 faces of 4 vertices. */
      const VERTICES_PER_BOX = 24;
      const total = Math.round(mesh.vertexCount / VERTICES_PER_BOX);
      const v = mesh.vertices;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let minZ = Infinity, maxZ = -Infinity;
      for (let i = 0; i < mesh.vertexCount * stride; i += stride) {
        if (v[i] < minX) minX = v[i];
        if (v[i] > maxX) maxX = v[i];
        if (v[i + 1] < minY) minY = v[i + 1];
        if (v[i + 1] > maxY) maxY = v[i + 1];
        if (v[i + 2] < minZ) minZ = v[i + 2];
        if (v[i + 2] > maxZ) maxZ = v[i + 2];
      }
      const held = game.player.heldStack();
      return {
        boxes: total,
        itemBoxes: held ? 1 : 0,
        armBoxes: total - (held ? 1 : 0),
        vertices: mesh.vertexCount,
        indices: mesh.indexCount,
        capacity: mesh.capacity,
        hasItem: !!held,
        item: held ? held.item : null,
        bounds: total > 0 ? {
          minX: +minX.toFixed(3), maxX: +maxX.toFixed(3),
          minY: +minY.toFixed(3), maxY: +maxY.toFixed(3),
          minZ: +minZ.toFixed(3), maxZ: +maxZ.toFixed(3)
        } : null
      };
    },

    /** Change the day length in seconds. */
    setDayLength(seconds) {
      game.timeSystem.dayLengthSeconds = seconds;
    },

    // ---------------------------------------------------------------------
    // Input injection
    // ---------------------------------------------------------------------

    /**
     * Press or release a logical action without touching the DOM.
     * Actions are the names used by Input (forward, jump, break, place, ...).
     */
    setAction(action, down) {
      if (down) {
        if (!game.input.down.has(action)) game.input.pressed.add(action);
        game.input.down.add(action);
      } else {
        game.input.down.delete(action);
        game.input.released.add(action);
      }
      return [...game.input.down];
    },

    /** True while the action is considered held. */
    isActionDown(action) {
      return game.input.isDown(action);
    },

    /** Enable or disable instant block breaking. */
    setInstantBreak(enabled) {
      game.interaction.instantBreak = !!enabled;
    },

    /** Override the player's reach. */
    setReach(distance) {
      game.interaction.reach = distance;
    },

    // ---------------------------------------------------------------------
    // Inspection
    // ---------------------------------------------------------------------

    /** A compact JSON summary of the session, used by the tests. */
    snapshot() {
      const game_ = game;
      const player = game_.player;
      if (!player) {
        return { state: game_.state, world: null, player: null };
      }
      return {
        state: game_.state,
        worldId: game_.worldId,
        worldName: game_.worldName,
        peaceful: game_.peaceful,
        seed: game_.world ? game_.world.seed : null,
        time: game_.timeSystem ? game_.timeSystem.time : null,
        dayCount: game_.timeSystem ? game_.timeSystem.dayCount : null,
        player: {
          x: round(player.x), y: round(player.y), z: round(player.z),
          yaw: round(player.yaw), pitch: round(player.pitch),
          health: round(player.health),
          onGround: player.onGround,
          inWater: player.inWater,
          dead: player.dead,
          selectedSlot: player.selectedSlot,
          blocksBroken: player.blocksBroken,
          blocksPlaced: player.blocksPlaced
        },
        inventory: player.inventory.serialize(),
        chunks: game_.world ? game_.world.chunkCount : 0,
        pendingChunks: game_.chunkManager ? game_.chunkManager.pendingChunks : -1,
        entities: game_.entityManager ? game_.entityManager.count : 0,
        edits: game_.world ? game_.world.stats.edits : 0,
        fps: round(game_.fps)
      };
    },

    /** Convenience: the number of a given item in the inventory. */
    countItem(item) {
      return game.player.inventory.countOf(item);
    },

    /** Enumerate the block keys the registry knows about. */
    blockKeys() {
      return BlockRegistry.all().map((def) => def.key);
    },

    /** Enumerate the item keys the registry knows about. */
    itemKeys() {
      return ItemRegistry.keys();
    },

    /** Run a self-check over the loaded chunks and report any inconsistencies. */
    selfCheck() {
      const world = game.world;
      const issues = [];
      let checkedChunks = 0;
      let solidUnderPlayer = false;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const chunk = world.getChunk(
            Math.floor(game.player.x / 16) + dx,
            Math.floor(game.player.z / 16) + dz
          );
          if (!chunk || !chunk.hasData) continue;
          checkedChunks++;
          for (let i = 0; i < chunk.skyLight.length; i++) {
            if (chunk.skyLight[i] > 15 || chunk.blockLight[i] > 15) {
              issues.push(`light out of range in chunk ${chunk.key}`);
              break;
            }
          }
          for (let i = 0; i < chunk.blocks.length; i++) {
            if (!BlockRegistry.isValid(chunk.blocks[i])) {
              issues.push(`invalid block id ${chunk.blocks[i]} in chunk ${chunk.key}`);
              break;
            }
          }
        }
      }
      // Is the player standing on something solid?
      const feetY = Math.floor(game.player.y - 0.1);
      solidUnderPlayer = world.isSolid(Math.floor(game.player.x), feetY, Math.floor(game.player.z));
      if (!solidUnderPlayer && !game.player.inWater) issues.push('no solid block under the player');

      // Use exactly the collision routine the physics uses, so a player resting
      // a fraction of a millimetre above a block is not reported as embedded.
      const playerBoxBlocked = boxIntersectsWorld(
        world, game.player.x, game.player.y, game.player.z,
        game.player.halfWidth, game.player.height
      );
      if (playerBoxBlocked) issues.push('the player is embedded in solid blocks');

      return { ok: issues.length === 0, issues, checkedChunks, solidUnderPlayer, playerBoxBlocked };
    }
  };

  game.debug = api;
  window.__VOXELHAVEN__ = game;
  window.VH = api;
  return api;
}

/** Round to 3 decimals for readable test output. */
function round(value) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 1000) / 1000 : value;
}
