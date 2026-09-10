/**
 * Game.js — the orchestrator.
 *
 * Owns every subsystem and defines the session lifecycle:
 *
 *   menu -> create/load -> generate terrain -> spawn player -> play
 *        -> save -> quit -> load -> restore
 *
 * The frame loop runs physics and entity simulation on a fixed timestep (so
 * behaviour is frame-rate independent) and everything else — input edges,
 * interaction, particles, rendering — once per displayed frame.
 *
 * Game is the only module that knows about all the others; every subsystem
 * stays unaware of its siblings, which is what keeps them individually
 * testable and replaceable.
 */

import { CHUNK_SIZE, TIME, SAVE, PLAYER } from './core/Config.js';
import { bus } from './core/EventBus.js';
import { Random } from './core/Random.js';

import { BlockRegistry } from './world/Blocks.js';
import { ItemRegistry } from './world/Items.js';
import { TerrainGenerator, BIOME_NAMES } from './world/TerrainGenerator.js';
import { World } from './world/World.js';
import { ChunkManager } from './world/ChunkManager.js';

import { Renderer } from './render/Renderer.js';
import { EntityRenderer } from './render/EntityRenderer.js';
import { ParticleSystem } from './render/ParticleSystem.js';

import { Camera } from './player/Camera.js';
import { Player } from './player/Player.js';
import { PlayerController } from './player/PlayerController.js';
import { Interaction } from './player/Interaction.js';

import { EntityManager } from './entities/EntityManager.js';

import { TimeSystem } from './systems/TimeSystem.js';
import { Input } from './systems/Input.js';
import { AudioSystem } from './systems/AudioSystem.js';
import { SaveSystem } from './systems/SaveSystem.js';

import { HUD } from './ui/HUD.js';
import { Menus } from './ui/Menus.js';
import { InventoryUI } from './ui/InventoryUI.js';

import { GameState, isWorldIdleState } from './GameState.js';
import { DEBUG } from './core/Config.js';
import { installDebugApi } from './Debug.js';

/** Physics step, in seconds. 60 Hz keeps collision resolution reliable. */
const FIXED_DT = 1 / 60;

/**
 * Never simulate more than this many fixed steps in one frame. Eight steps
 * cover 133 ms of simulation, so the world keeps real-time pace even on a
 * machine dropping to ~8 fps; beyond that the simulation slows down rather
 * than spiralling into an unrecoverable frame-time hole.
 */
const MAX_FIXED_STEPS = 8;

/** Longest delta the loop will accept, to survive tab switches. */
const MAX_FRAME_DT = 0.15;

/**
 * How many consecutive frames may throw before the game gives up and shows the
 * error screen. A single bad frame should never kill the render loop.
 */
const MAX_CONSECUTIVE_FRAME_ERRORS = 30;

export class Game {
  /** @param {HTMLCanvasElement} canvas */
  constructor(canvas) {
    this.canvas = canvas;
    this.bus = bus;
    /** @type {string} see GameState */
    this.state = GameState.BOOT;

    // ---- Persistent services ---------------------------------------------
    this.saveSystem = new SaveSystem(bus);
    this.audio = new AudioSystem(bus);
    this.input = new Input(canvas, bus);
    this.rng = new Random(Date.now() & 0xffffffff);

    // ---- Renderer ---------------------------------------------------------
    this.renderer = new Renderer(canvas);
    this.particles = new ParticleSystem(new Random(0x5eed));
    this.particles.setAtlas(this.renderer.atlas);
    this.entityRenderer = new EntityRenderer(this.renderer.entityMesh, this.renderer.atlas);

    // ---- UI ---------------------------------------------------------------
    this.hud = new HUD(bus, this.renderer.atlas);
    this.inventoryUI = new InventoryUI(bus, this.renderer.atlas, this.audio);
    this.menus = new Menus(bus, this.saveSystem, {
      onCreateWorld: (options) => this.createWorld(options),
      onLoadWorld: (id) => this.loadWorld(id),
      onResume: () => this.resume(),
      onSave: () => this.saveNow({ announce: true }),
      onQuit: (options) => this.quitToMenu(options),
      onRespawn: () => this.respawn(),
      onSettingsChanged: (settings) => this.applySettings(settings)
    });

    // ---- Session state (created by createWorld / loadWorld) ---------------
    /** @type {World|null} */
    this.world = null;
    /** @type {ChunkManager|null} */
    this.chunkManager = null;
    /** @type {Player|null} */
    this.player = null;
    /** @type {PlayerController|null} */
    this.playerController = null;
    /** @type {Camera|null} */
    this.camera = null;
    /** @type {Interaction|null} */
    this.interaction = null;
    /** @type {EntityManager|null} */
    this.entityManager = null;
    /** @type {TimeSystem|null} */
    this.timeSystem = null;

    this.worldId = null;
    this.worldName = 'World';
    this.worldCreatedAt = Date.now();
    this.peaceful = false;
    this.playTimeSeconds = 0;
    this.autosaveTimer = 0;
    /** Spawn position chosen at world creation, used by the loading screen. */
    this.pendingSpawn = null;

    // ---- Loop bookkeeping -------------------------------------------------
    this.lastFrameTime = 0;
    this.accumulator = 0;
    this.running = false;
    this.frameCount = 0;
    this.fps = 0;
    this._fpsAccumulator = 0;
    this._fpsFrames = 0;
    this.underwaterAmount = 0;

    // Held-item scratch: reused every frame so building the view-space hand and
    // item allocates nothing. One matrix per box, plus the per-face tile origin
    // list that DynamicMesh.addBoxMulti consumes.
    this._heldSwing = 0;
    this._heldItemMatrix = new Float32Array(16);
    this._heldFistMatrix = new Float32Array(16);
    this._heldArmMatrix = new Float32Array(16);
    this._heldArmTiles = [];
    for (let i = 0; i < 6; i++) this._heldArmTiles.push({ u: 0, v: 0 });
    this._heldItemTiles = [];
    for (let i = 0; i < 6; i++) this._heldItemTiles.push({ u: 0, v: 0 });

    this.applySettings(this.menus.settings);
    this.wireEvents();

    // Automation / console surface. Enabled by default in Config.DEBUG and
    // inert for normal play.
    if (DEBUG.exposeDebugApi) installDebugApi(this);
  }

  // =========================================================================
  // Setup
  // =========================================================================

  /** Connect the event bus to cross-system reactions. */
  wireEvents() {
    this.bus.on('playerDamaged', () => {
      this.hud.flashDamage();
      this.audio.play('hurt');
    });
    this.bus.on('playerDied', ({ cause }) => {
      this.onPlayerDied(cause);
    });
    this.bus.on('mobDamaged', () => this.audio.play('mobHurt'));
    this.bus.on('itemPickedUp', () => {
      this.audio.play('pickup');
      this.hud.refreshHotbar(this.player);
    });
    this.bus.on('hotbarChanged', () => {
      this.hud.refreshHotbar(this.player);
      this.audio.play('click');
    });
    this.bus.on('hotbarRefresh', () => {
      if (this.player) this.hud.refreshHotbar(this.player);
    });
    this.bus.on('footstep', ({ sound }) => this.audio.playBlockSound('step', sound));
    this.bus.on('playerJumped', () => this.audio.play('jump'));
    this.bus.on('playerLanded', ({ damage }) => {
      if (damage > 0) this.audio.play('land');
    });
    this.bus.on('pointerLockChanged', (locked) => {
      // Losing the pointer while playing opens the pause menu, which is the
      // behaviour players expect from Escape.
      if (!locked && this.state === GameState.PLAYING) this.pause();
    });
    this.bus.on('requestCloseInventory', () => this.closeInventory());
    this.bus.on('craftFailed', ({ reason }) => this.hud.toast(reason, 'warn'));
    this.bus.on('saveWarnings', (warnings) => {
      for (const warning of warnings) this.hud.toast(warning, 'warn', 5);
    });
    this.bus.on('chunkGenerationFailed', ({ cx, cz }) => {
      this.hud.toast(`Chunk ${cx},${cz} failed to generate; using a fallback`, 'error', 5);
    });
    this.bus.on('keyAction', (action) => this.onKeyAction(action));

    window.addEventListener('resize', () => this.onResize());
    window.addEventListener('beforeunload', () => {
      // Best-effort final save so closing the tab does not lose progress.
      if (this.state === GameState.PLAYING || this.state === GameState.PAUSED
        || this.state === GameState.INVENTORY) {
        this.saveNow({ announce: false, synchronous: true });
      }
    });
  }

  /** Apply user settings to the live systems. */
  applySettings(settings) {
    this.input.sensitivity = 0.0022 * settings.sensitivity;
    if (this.playerController) {
      this.playerController.baseFov = settings.fov;
      this.playerController.invertY = settings.invertY;
    }
    if (this.chunkManager) this.chunkManager.setRenderDistance(settings.renderDistance);
    this.audio.setVolume(settings.volume);
    this.audio.setEnabled(!settings.muted);
    if (this.timeSystem) {
      this.timeSystem.dayLengthSeconds = settings.dayLengthMinutes * 60;
    }
  }

  /** Called once at startup. */
  async boot() {
    // Resolved once the main menu is usable; world creation awaits it so an
    // early call can never race the boot sequence.
    let resolveBooted;
    this.booted = new Promise((resolve) => { resolveBooted = resolve; });
    this.menus.show('boot');
    this.menus.setBootProgress(0.1, 'Starting the renderer');

    // Yield to the browser so the boot screen paints before heavy work starts.
    await nextFrame();
    this.menus.setBootProgress(0.4, 'Generating textures');
    await nextFrame();

    this.menus.setBootProgress(0.7, 'Checking world storage');
    await this.saveSystem.probe();
    this.menus.setStorageNote(storageNote(this.saveSystem));

    this.menus.setBootProgress(1.0, 'Ready');
    this.menus.syncSettingsControls();
    this.applySettings(this.menus.settings);

    // Automation can legitimately ask for a world before boot finishes; in
    // that case the loading screen is already up and must not be replaced.
    if (this.state === GameState.BOOT) {
      this.state = GameState.MENU;
      this.menus.show('menu');
    }
    resolveBooted();
    this.startLoop();
  }

  // =========================================================================
  // World lifecycle
  // =========================================================================

  /**
   * Create a brand new world.
   * @param {{name:string, seed:number, peaceful:boolean}} options
   */
  async createWorld(options) {
    if (this.state === GameState.BOOT) await this.booted;
    try {
      this.menus.showLoading('Generating world…', 'Preparing terrain generator');
      this.teardownSession();

      this.worldId = SaveSystem.makeId(options.name);
      this.worldName = options.name;
      this.worldCreatedAt = Date.now();
      this.peaceful = !!options.peaceful;

      const generator = new TerrainGenerator(options.seed | 0);
      this.setupSession(generator, options.seed | 0);

      // Pick a spawn before any chunk exists: the generator can answer
      // "what is the surface height here" without generating anything.
      const spawn = generator.findSpawn(8, 8);
      this.pendingSpawn = spawn;
      this.player.setSpawn(spawn.x, spawn.y, spawn.z);
      this.player.teleport(spawn.x, spawn.y + 1, spawn.z);

      // A small starter kit so building is possible immediately, but not so
      // much that gathering is pointless.
      for (const entry of ItemRegistry.startingLoadout()) {
        this.player.inventory.add(entry.item, entry.count);
      }

      this.beginLoading('Generating terrain', 'Building chunks around the spawn point');
    } catch (err) {
      this.fail('Could not create the world', err);
    }
  }

  /**
   * Load a world from storage.
   * @param {string} id
   */
  async loadWorld(id) {
    if (this.state === GameState.BOOT) await this.booted;
    try {
      this.menus.showLoading('Loading world…', 'Reading save file');
      this.teardownSession();

      const document = await this.saveSystem.read(id);
      this.worldId = id;
      this.worldName = typeof document.name === 'string' ? document.name : 'Unnamed World';
      this.worldCreatedAt = document.createdAt || Date.now();
      this.peaceful = !!document.peaceful;

      const generator = new TerrainGenerator(document.seed | 0);
      this.setupSession(generator, document.seed | 0);

      // Restore the stored block deltas before any chunk is meshed.
      const edits = this.world.loadEdits(document.edits, (blockId) => BlockRegistry.isValid(blockId));

      const playerWarnings = [];
      if (document.player) {
        const result = this.player.deserialize(document.player, this.world);
        playerWarnings.push(...result.warnings);
      }

      if (document.time) {
        this.timeSystem.setTime(Number(document.time.timeOfDay) || 0);
        this.timeSystem.dayCount = Number(document.time.dayCount) || 0;
        this.timeSystem.elapsedSeconds = Number(document.time.elapsedSeconds) || 0;
      }

      const entityResult = this.entityManager.deserialize(document.entities);

      this.pendingSpawn = { x: this.player.x, y: this.player.y, z: this.player.z };

      // Report what was restored, including anything that had to be repaired.
      this.hud.toast(`Loaded "${this.worldName}"`, 'info', 3);
      if (edits.rejected > 0) {
        this.hud.toast(`${edits.rejected} invalid block change(s) were skipped`, 'warn', 5);
      }
      for (const warning of playerWarnings) this.hud.toast(warning, 'warn', 5);
      if (entityResult.skipped > 0) {
        this.hud.toast(`${entityResult.skipped} item drop(s) could not be restored`, 'warn', 5);
      }

      this.beginLoading('Loading terrain', 'Rebuilding chunks from the world seed');
    } catch (err) {
      this.fail('Could not load that world', err);
    }
  }

  /** Create the per-session subsystems for a generator. */
  setupSession(generator, seed) {
    this.world = new World(this.bus, generator);
    this.chunkManager = new ChunkManager(this.world, this.bus, {
      upload: (key, cx, cz, data) => this.renderer.chunkRenderer.upload(key, cx, cz, data),
      remove: (key) => this.renderer.chunkRenderer.remove(key)
    }, this.renderer.atlas);
    this.chunkManager.setRenderDistance(this.menus.settings.renderDistance);

    this.player = new Player(this.bus);
    this.camera = new Camera();
    this.camera.fov = this.menus.settings.fov;
    this.camera.currentFov = this.camera.fov;

    this.playerController = new PlayerController(this.player, this.world, this.camera, this.bus);
    this.playerController.baseFov = this.menus.settings.fov;
    this.playerController.frozen = true;

    this.entityManager = new EntityManager(this.world, this.bus);
    this.entityManager.spawningEnabled = !this.peaceful;

    this.interaction = new Interaction(
      this.world, this.player, this.camera,
      this.entityManager, this.particles, this.audio, this.bus
    );

    this.timeSystem = new TimeSystem(this.bus, TIME.startTime);
    this.timeSystem.dayLengthSeconds = this.menus.settings.dayLengthMinutes * 60;

    this.playTimeSeconds = 0;
    this.autosaveTimer = 0;
    this.hud.setWorldInfo(this.worldName, seed);
    if (this.peaceful) this.hud.setWorldNote(`seed ${seed} · peaceful`);
  }

  /** Switch to the loading state and wait for the spawn area to stream in. */
  beginLoading(title, message) {
    this.state = GameState.LOADING;
    this.menus.showLoading(title, message);
    this.hud.hide();
    this.input.enabled = false;
    this.input.exitPointerLock();
  }

  /** Called from the loop once the spawn area is fully generated and lit. */
  finishLoading() {
    const spawn = this.pendingSpawn || { x: this.player.x, y: this.player.y, z: this.player.z };

    // Put the player on solid ground. The saved position is preferred on load;
    // findSafeY only intervenes when it is inside terrain.
    const safeY = this.findSpawnY(spawn.x, spawn.z, spawn.y);
    this.player.teleport(spawn.x, safeY, spawn.z);
    this.player.setSpawn(spawn.x, safeY, spawn.z);
    this.playerController.fallStartY = safeY;
    this.playerController.frozen = false;

    this.state = GameState.PLAYING;
    this.menus.show(null);
    this.hud.show();
    this.hud.refreshHotbar(this.player);
    this.hud.refreshHealth(this.player.health);
    this.input.enabled = true;
    this.input.requestPointerLock();
    this.audio.unlock();
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
    this.bus.emit('worldReady', { id: this.worldId, name: this.worldName, seed: this.world.seed });
  }

  /**
   * Find a safe standing Y at a column, falling back progressively.
   * Handles the "saved position is now inside a block" case without ever
   * dropping the player through the world.
   */
  findSpawnY(x, z, preferredY) {
    const half = PLAYER.width / 2;
    const height = PLAYER.height;

    // Search downwards from a little above the preferred spot.
    const top = Math.min(126, Math.floor(preferredY) + 2);
    const columnLoaded = this.world.isColumnLoaded(Math.floor(x), Math.floor(z));
    for (let y = top; y >= 1; y--) {
      if (!columnLoaded) break;
      const blocked = this.isBoxBlocked(x, y, z, half, height);
      if (blocked) continue;
      const groundBlocked = this.isBoxBlocked(x, y - 1, z, half, height);
      if (!groundBlocked) continue;
      return y;
    }
    // Fall back to the terrain surface height.
    const surface = this.world.heightAt(Math.floor(x), Math.floor(z));
    if (surface >= 0) return surface + 1;
    // Last resort: the generator's pure height function, which needs no chunks.
    const generated = this.world.generator.surfaceHeight(Math.floor(x), Math.floor(z));
    return generated + 1;
  }

  /** Local AABB overlap test used by findSpawnY. */
  isBoxBlocked(x, y, z, half, height) {
    const minX = Math.floor(x - half + 1e-4);
    const maxX = Math.floor(x + half - 1e-4);
    const minZ = Math.floor(z - half + 1e-4);
    const maxZ = Math.floor(z + half - 1e-4);
    const minY = Math.floor(y + 1e-4);
    const maxY = Math.floor(y + height - 1e-4);
    for (let by = minY; by <= maxY; by++) {
      for (let bz = minZ; bz <= maxZ; bz++) {
        for (let bx = minX; bx <= maxX; bx++) {
          if (this.world.isSolid(bx, by, bz)) return true;
        }
      }
    }
    return false;
  }

  /** Release every per-session object and GPU resource. */
  teardownSession() {
    if (this.chunkManager) this.chunkManager.dispose();
    this.renderer.clearWorld();
    if (this.world) this.world.clear();
    if (this.entityManager) this.entityManager.clear();
    this.particles.clear();
    this.chunkManager = null;
    this.world = null;
    this.player = null;
    this.playerController = null;
    this.camera = null;
    this.interaction = null;
    this.entityManager = null;
    this.timeSystem = null;
    this.worldId = null;
    this.pendingSpawn = null;
  }

  // =========================================================================
  // Session actions
  // =========================================================================

  /** Pause the game and open the pause menu. */
  pause() {
    if (this.state !== GameState.PLAYING) return;
    this.state = GameState.PAUSED;
    this.input.enabled = false;
    this.input.exitPointerLock();
    if (this.playerController) this.playerController.frozen = true;
    const env = this.timeSystem.getEnvironment();
    this.menus.openPause(
      `${this.worldName} · seed ${this.world.seed} · day ${this.timeSystem.dayCount + 1} · ${this.timeSystem.formatClock()}`
    );
    this.menus.show('pause');
    // A pause is a natural moment to persist progress.
    this.saveNow({ announce: false });
    void env;
  }

  /** Leave the pause menu and return to play. */
  resume() {
    if (this.state !== GameState.PAUSED && this.state !== GameState.SETTINGS) return;
    this.state = GameState.PLAYING;
    this.menus.show(null);
    this.hud.show();
    this.input.enabled = true;
    this.input.requestPointerLock();
    if (this.playerController) this.playerController.frozen = false;
    this.lastFrameTime = performance.now();
    this.accumulator = 0;
  }

  /** Open the inventory / crafting screen. */
  openInventory() {
    if (this.state !== GameState.PLAYING) return;
    this.state = GameState.INVENTORY;
    this.input.enabled = false;
    this.input.exitPointerLock();
    if (this.playerController) this.playerController.frozen = true;
    this.hud.hide();
    this.inventoryUI.open(this.player);
  }

  /** Close the inventory screen. */
  closeInventory() {
    if (this.state !== GameState.INVENTORY) return;
    this.inventoryUI.close();
    this.state = GameState.PLAYING;
    this.menus.show(null);
    this.hud.show();
    this.hud.refreshHotbar(this.player);
    this.input.enabled = true;
    this.input.requestPointerLock();
    if (this.playerController) this.playerController.frozen = false;
  }

  /** Respawn the player at their spawn point. */
  respawn() {
    if (!this.player) return;
    this.player.respawn();
    this.playerController.respawnAtSpawn();
    // Clear anything that wandered onto the spawn point.
    this.entityManager.forEachNear(this.player.x, this.player.y, this.player.z, 3, (entity) => {
      if (entity.hostile) entity.velocityY = 6;
    });
    this.state = GameState.PLAYING;
    this.menus.show(null);
    this.hud.show();
    this.hud.refreshHealth(this.player.health);
    this.input.enabled = true;
    this.input.requestPointerLock();
    this.playerController.frozen = false;
    this.audio.play('respawn');
    this.hud.toast('Respawned at your spawn point', 'info');
  }

  /** React to the player's death. */
  onPlayerDied(cause) {
    this.state = GameState.DEAD;
    this.input.enabled = false;
    this.input.exitPointerLock();
    if (this.playerController) this.playerController.frozen = true;
    this.audio.play('death');
    this.menus.openDeath(cause);
    // Save immediately: a death should never cost the player their progress.
    this.saveNow({ announce: false });
  }

  /** Save the current world. */
  async saveNow(options = {}) {
    const { announce = true, synchronous = false } = options;
    if (!this.world || !this.player || !this.worldId) return { ok: false, error: 'no world loaded' };

    const document = SaveSystem.createDocument({
      id: this.worldId,
      name: this.worldName,
      seed: this.world.seed,
      createdAt: this.worldCreatedAt,
      timeOfDay: this.timeSystem.time,
      dayCount: this.timeSystem.dayCount,
      elapsedSeconds: this.timeSystem.elapsedSeconds,
      player: this.player.serialize(),
      edits: this.world.serializeEdits(),
      entities: this.entityManager.serialize(),
      stats: {
        playTimeMs: Math.round(this.playTimeSeconds * 1000),
        blocksBroken: this.player.blocksBroken,
        blocksPlaced: this.player.blocksPlaced
      }
    });
    document.peaceful = this.peaceful;

    const result = await this.saveSystem.write(this.worldId, document);
    if (result.ok) {
      if (announce) {
        const size = (SaveSystem.documentSize(document) / 1024).toFixed(1);
        this.hud.toast(`Saved "${this.worldName}" (${size} KB, ${result.backend})`, 'info');
      }
      this.menus.setPauseStatus(`Saved at ${new Date().toLocaleTimeString()} (${result.backend})`);
    } else {
      this.hud.toast(result.error || 'Could not save the world', 'error', 6);
      this.menus.setPauseStatus(result.error || 'Save failed');
    }
    void synchronous;
    return result;
  }

  /** Save (unless skipped) and return to the main menu. */
  async quitToMenu(options = {}) {
    if (!options.skipSave && this.world && this.worldId) {
      await this.saveNow({ announce: false });
    }
    this.teardownSession();
    this.state = GameState.MENU;
    this.hud.hide();
    this.input.enabled = false;
    this.input.exitPointerLock();
    this.menus.show('menu');
    this.menus.setStorageNote(storageNote(this.saveSystem));
  }

  // =========================================================================
  // Input reactions
  // =========================================================================

  /** Handle one-shot key actions that are not movement. */
  onKeyAction(action) {
    switch (action) {
      case 'inventory':
        if (this.state === GameState.PLAYING) this.openInventory();
        else if (this.state === GameState.INVENTORY) this.closeInventory();
        break;
      case 'craft':
        if (this.state === GameState.PLAYING) this.openInventory();
        break;
      case 'pause':
        if (this.state === GameState.PLAYING) this.pause();
        else if (this.state === GameState.INVENTORY) this.closeInventory();
        else if (this.state === GameState.PAUSED) this.resume();
        break;
      case 'debug':
        this.hud.toggleDebug();
        break;
      case 'screenshot':
        this.saveScreenshot();
        break;
      case 'mute': {
        const enabled = this.audio.toggle();
        this.hud.toast(enabled ? 'Audio on' : 'Audio muted', 'info', 1.4);
        break;
      }
      default:
        // Number keys select hotbar slots.
        if (action.startsWith('hotbar') && this.player) {
          const index = Number(action.slice(6)) - 1;
          if (Number.isInteger(index) && index >= 0 && index < 9) {
            this.player.selectHotbar(index);
          }
        }
        break;
    }
  }

  // =========================================================================
  // Frame loop
  // =========================================================================

  /** Start the requestAnimationFrame loop. */
  startLoop() {
    if (this.running) return;
    this.running = true;
    this.lastFrameTime = performance.now();
    const frame = (now) => {
      if (!this.running) return;
      // A subsystem throwing must not stop the animation loop: without this
      // guard a single bad entity would freeze the whole game permanently.
      try {
        this.tick(now);
        this._frameErrors = 0;
      } catch (err) {
        this._frameErrors = (this._frameErrors || 0) + 1;
        console.error('[Game] frame error:', err);
        if (this._frameErrors === 1) {
          this.hud.toast('A game system reported an error; see the console', 'error', 5);
        }
        if (this._frameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS) {
          this.running = false;
          this.fail('The game hit a repeated error and stopped.', err);
          return;
        }
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  /** Stop the loop (used when tearing the game down). */
  stopLoop() {
    this.running = false;
  }

  /**
   * One displayed frame.
   * @param {number} now high-resolution timestamp from requestAnimationFrame
   */
  tick(now) {
    const rawDt = Math.min(MAX_FRAME_DT, Math.max(0, (now - this.lastFrameTime) / 1000));
    this.lastFrameTime = now;
    this.frameCount++;

    // Rolling average frame rate for the debug overlay.
    this._fpsAccumulator += rawDt;
    this._fpsFrames++;
    if (this._fpsAccumulator >= 0.5) {
      this.fps = this._fpsFrames / this._fpsAccumulator;
      this._fpsAccumulator = 0;
      this._fpsFrames = 0;
    }

    switch (this.state) {
      case GameState.LOADING:
        this.updateLoading(rawDt, now);
        break;
      case GameState.PLAYING:
        this.updatePlaying(rawDt, now);
        break;
      default:
        if (isWorldIdleState(this.state)) {
          // The world keeps streaming and animating while menus are open, but
          // gameplay simulation is frozen.
          this.updateIdle(rawDt, now);
        } else {
          this.renderMenuBackground(now);
        }
        break;
    }

    this.input.endFrame();
  }

  /** Advance generation while the loading screen is up, then start playing. */
  updateLoading(dt, now) {
    if (!this.chunkManager) {
      this.renderMenuBackground(now);
      return;
    }
    const spawn = this.pendingSpawn || { x: 0, z: 0 };
    this.chunkManager.update(spawn.x, spawn.z);

    const total = this.chunkManager.pendingChunks + this.chunkManager.stats.generationQueueLength;
    const loaded = this.world.chunkCount;
    const expected = Math.max(1, loaded + total);
    const progress = 1 - total / expected;
    this.menus.setLoadingProgress(progress, `${loaded} chunks ready · ${total} to generate`);

    // Wait until the chunks immediately around the spawn are lit and meshed.
    if (this.chunkManager.isAreaReady(spawn.x, spawn.z, 1)
      && this.world.isColumnLoaded(Math.floor(spawn.x), Math.floor(spawn.z))
      && this.chunkManager.pendingChunks < 4) {
      this.finishLoading();
      return;
    }
    this.renderWorldPreview(now, dt);
  }

  /** Full gameplay update: fixed-step simulation then per-frame systems. */
  updatePlaying(dt, now) {
    this.playTimeSeconds += dt;

    // ---- Fixed-step simulation -------------------------------------------
    this.accumulator += dt;
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_FIXED_STEPS) {
      this.fixedUpdate(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
    // Guarantee at least one simulation step per displayed frame so
    // edge-triggered input is never dropped on very fast displays.
    if (steps === 0) {
      this.fixedUpdate(Math.max(dt, 1 / 240));
      this.accumulator = 0;
    }

    // ---- Streaming --------------------------------------------------------
    this.chunkManager.update(this.player.x, this.player.z);

    // ---- Interaction ------------------------------------------------------
    this.interaction.update(dt, this.input);

    // ---- Particles --------------------------------------------------------
    this.particles.update(dt, this.world);

    // ---- Autosave ---------------------------------------------------------
    this.autosaveTimer += dt;
    if (this.autosaveTimer >= SAVE.autosaveIntervalSeconds) {
      this.autosaveTimer = 0;
      this.saveNow({ announce: false });
      this.hud.toast('Autosaved', 'info', 1.6);
    }

    // ---- Audio ambience ---------------------------------------------------
    this.audio.updateAmbience(this.timeSystem.getEnvironment().dayBrightness);

    // ---- Presentation -----------------------------------------------------
    this.updateHud(dt);
    this.renderWorld(now, dt);
  }

  /** Simulation-only update used while a menu is open. */
  updateIdle(dt, now) {
    if (!this.world) {
      this.renderMenuBackground(now);
      return;
    }
    // Keep the world streaming and the cycle running so the scene behind the
    // menu stays alive, but do not simulate the player or mobs.
    this.chunkManager.update(this.player.x, this.player.z);
    this.timeSystem.update(dt);
    this.particles.update(dt, this.world);
    this.renderWorld(now, dt);
  }

  /** One fixed simulation step. */
  fixedUpdate(dt) {
    this.timeSystem.update(dt);
    this.playerController.update(dt, this.input);
    this.entityManager.update(dt, {
      player: this.player,
      dayBrightness: this.timeSystem.getEnvironment().dayBrightness
    });
    this.entityManager.updateSpawning(dt, this.player, this.timeSystem.getEnvironment().dayBrightness);

    // Survival: drowning and slow regeneration.
    this.updateSurvival(dt);

    // If a chunk streamed in around the player and left them embedded, lift
    // them out rather than letting them suffocate inside the terrain.
    if (this.playerController.resolveStuck()) {
      this.hud.toast('Moved to a safe position', 'warn', 2);
    }
  }

  /** Breath, drowning and health regeneration. */
  updateSurvival(dt) {
    const player = this.player;
    player.secondsSinceDamage += dt;

    if (player.headInWater) {
      player.breath -= dt;
      if (player.breath <= 0) {
        player.breath = 0;
        // Drowning damage ticks once per second.
        this._drownTimer = (this._drownTimer || 0) + dt;
        if (this._drownTimer >= 1) {
          this._drownTimer = 0;
          player.damage(PLAYER.drowningDamagePerSecond, 'drowning');
        }
      }
    } else if (player.breath < PLAYER.maxBreathSeconds) {
      player.breath = Math.min(PLAYER.maxBreathSeconds, player.breath + dt * 3.5);
    }

    if (!player.dead && player.secondsSinceDamage > PLAYER.regenDelaySeconds
      && player.health < player.maxHealth) {
      player.health = Math.min(player.maxHealth, player.health + PLAYER.healthRegenPerSecond * dt);
    }
  }

  // =========================================================================
  // Rendering
  // =========================================================================

  /** Build and draw a world frame. */
  renderWorld(now, dt) {
    const renderer = this.renderer;
    renderer.resize();
    const env = this.timeSystem.getEnvironment();
    this.camera.update(renderer.aspect);

    // Underwater tint eases in and out rather than snapping.
    const targetUnderwater = this.player.headInWater ? 1 : 0;
    this.underwaterAmount += (targetUnderwater - this.underwaterAmount) * Math.min(1, dt * 6);

    this.entityRenderer.build(this.entityManager, this.world, this.camera, this.timeSystem.elapsedSeconds);

    // Particles follow the camera; the mesh is built in world space.
    this.particles.buildMesh(renderer.particleMesh, this.world, this.camera);

    const highlight = this.interaction ? this.interaction.target : null;
    const breakProgress = this.interaction ? this.interaction.breakProgress : 0;

    const underwater = this.underwaterAmount > 0.01;
    const fogFar = underwater ? TIME.fogFarUnderwater : env.fogFar;
    const fogNear = underwater ? 0 : env.fogNear;

    renderer.render(this.camera, env, {
      entities: renderer.entityMesh,
      particles: renderer.particleMesh,
      highlight,
      breakProgress,
      heldItem: this.buildHeldItem(dt),
      underwater: this.underwaterAmount,
      fogFar,
      fogNear,
      fogColor: underwater ? UNDERWATER_FOG : env.fogColor
    });
    void now;
  }

  /** Draw only the chunk streaming progress while loading (no player yet). */
  renderWorldPreview(now, dt) {
    if (!this.camera) return;
    const renderer = this.renderer;
    renderer.resize();
    const env = this.timeSystem.getEnvironment();

    // Look down at the spawn point from a pleasant angle while loading.
    const spawn = this.pendingSpawn || { x: 0, y: 80, z: 0 };
    const angle = (now / 1000) * 0.12;
    this.camera.setPosition(spawn.x + Math.cos(angle) * 18, spawn.y + 12, spawn.z + Math.sin(angle) * 18);
    this.camera.yaw = -angle + Math.PI / 2;
    this.camera.pitch = -0.35;
    this.camera.update(renderer.aspect);

    renderer.entityMesh.begin();
    renderer.particleMesh.begin();
    renderer.render(this.camera, env, {
      entities: renderer.entityMesh,
      particles: renderer.particleMesh,
      highlight: null,
      breakProgress: 0,
      heldItem: null,
      underwater: 0
    });
    void dt;
  }

  /** The menu shows a slowly drifting world once one has been visited. */
  renderMenuBackground(now) {
    const renderer = this.renderer;
    renderer.resize();
    const gl = renderer.gl;
    gl.viewport(0, 0, renderer.width, renderer.height);
    // A simple gradient clear keeps the menu from flashing black.
    const t = (now / 6000) % 1;
    gl.clearColor(0.06 + t * 0.02, 0.08 + t * 0.03, 0.12 + t * 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
  }

  /**
   * Build the held-item mesh in view space.
   * Drawn with the camera's projection only (no view matrix), so the item sits
   * fixed in front of the camera like a hand.
   *
   * The item is anchored to the lower-right corner and partly cropped by the
   * screen edge, with a forearm rising from the corner to meet it. Without the
   * arm the item reads as a stray cube floating in the world rather than
   * something the player is holding, and without the corner anchor it is both
   * oversized and ambiguous about distance.
   */
  buildHeldItem(dt) {
    const mesh = this.renderer.heldItemMesh;
    mesh.begin();

    // The arm is drawn whether or not an item is held: an empty fist still
    // tells the player where their hand is.
    const using = this.input.isDown('break') || this.input.isDown('place');
    this._heldSwing += ((using ? 1 : 0) - this._heldSwing) * Math.min(1, dt * 9);
    const swing = Math.sin(this._heldSwing * Math.PI) * 0.35;

    this.appendHeldArm(mesh, swing);

    const stack = this.player.heldStack();
    if (!stack) return { mesh, projection: this.camera.projection };

    const blockId = ItemRegistry.blockIdOf(stack.item);
    let tileName;
    if (blockId !== null) tileName = BlockRegistry.faceTileName(blockId, 0);
    else tileName = ItemRegistry.tile(stack.item);

    const tileU = this.renderer.atlas.tileU(tileName);
    const tileV = this.renderer.atlas.tileV(tileName);

    // View-space placement: the lower-right corner, so the item is cropped by
    // the screen edge the way a held object is. These distances are chosen from
    // the projection (apparent size is size / (|z| * 2 * tan(fov/2))), which
    // puts the item's centre near (859, 204) px on a 1280x720 view.
    const bob = Math.sin(this.player.walkPhase * 2) * 0.006 * (this.player.onGround ? 1 : 0);
    const x = 0.45 - swing * 0.05;
    const y = -0.34 + bob - swing * 0.08;
    const z = -0.95;
    const scale = 0.13;

    // Yawed so the player sees two faces of the cube rather than a flat side.
    composeViewMatrix(this._heldItemMatrix, x, y, z,
      0.62 + swing * 0.55, -0.30 + swing * 0.5, 0.1, scale, scale, scale);

    const tiles = this._heldItemTiles;
    for (let i = 0; i < 6; i++) { tiles[i].u = tileU; tiles[i].v = tileV; }
    mesh.addBoxMulti(this._heldItemMatrix, tiles, 1.0, 0.55, 1.0);

    return { mesh, projection: this.camera.projection };
  }

  /**
   * Append the forearm and fist to the held-item mesh, in view space.
   *
   * Built from two boxes: a sleeve running down and out of frame, and a fist
   * at the top of it that the held item sits against. The pitch tilts the far
   * end of the arm away from the camera so it foreshortens naturally instead
   * of looking like a plank laid across the screen.
   * @param {import('./render/DynamicMesh.js').DynamicMesh} mesh
   * @param {number} swing current swing amount, 0..0.35
   */
  appendHeldArm(mesh, swing) {
    const atlas = this.renderer.atlas;
    const tiles = this._heldArmTiles;
    const armU = atlas.tileU('hand');
    const armV = atlas.tileV('hand');
    for (let i = 0; i < 6; i++) { tiles[i].u = armU; tiles[i].v = armV; }

    const spec = HELD_ARM;
    for (let i = 0; i < spec.length; i++) {
      const part = spec[i];
      composeViewMatrix(this._heldArmMatrix,
        part.x - swing * 0.05, part.y - swing * 0.08, part.z,
        part.yaw, part.pitch, part.roll,
        part.sx, part.sy, part.sz);
      mesh.addBoxMulti(this._heldArmMatrix, tiles, 1.0, 0.55, 1.0);
    }
  }

  // =========================================================================
  // HUD
  // =========================================================================

  /** Refresh the heads-up display and debug overlay. */
  updateHud(dt) {
    this.hud.update(this.player, dt, {
      breakProgress: this.interaction ? this.interaction.breakProgress : 0,
      underwater: this.player.headInWater
    });

    if (this.hud.debugVisible) this.hud.setDebugRows(this.collectDebugRows());
  }

  /** Assemble the F3 overlay contents. */
  collectDebugRows() {
    const world = this.world;
    const player = this.player;
    const px = Math.floor(player.x);
    const py = Math.floor(player.y);
    const pz = Math.floor(player.z);
    const cx = Math.floor(player.x / CHUNK_SIZE);
    const cz = Math.floor(player.z / CHUNK_SIZE);
    const biome = world.generator ? world.generator.biomeAt(px, pz) : 0;
    const held = player.heldStack();
    const cm = this.chunkManager;
    const rs = this.renderer.stats;

    const rows = [
      ['FPS', `${this.fps.toFixed(0)}  frame ${(1000 / Math.max(1, this.fps)).toFixed(1)} ms`],
      ['Position', `${player.x.toFixed(1)} ${player.y.toFixed(1)} ${player.z.toFixed(1)}`],
      ['Chunk', `${cx},${cz}  block ${((px % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE},${((pz % CHUNK_SIZE) + CHUNK_SIZE) % CHUNK_SIZE}`],
      ['Biome', BIOME_NAMES[biome] || 'unknown'],
      ['Seed', String(world.seed)],
      ['Time', `${this.timeSystem.formatClock()}  day ${this.timeSystem.dayCount + 1}  light ${this.timeSystem.getEnvironment().dayBrightness.toFixed(2)}`],
      ['Local light', `sky ${world.getSkyLight(px, py, pz)} block ${world.getBlockLight(px, py, pz)}`],
      ['Chunks', `${world.chunkCount} loaded · ${cm ? cm.pendingChunks : 0} pending · ${cm ? cm.stats.unloaded : 0} unloaded`],
      ['Workers', cm && cm.stats.usingWorkers ? `${cm.stats.workers} active` : 'main thread'],
      ['Mesh', cm ? `${cm.stats.meshed} built · ${cm.stats.lastMeshMs.toFixed(1)} ms last` : '—'],
      ['Draws', `${rs.drawCalls} calls · ${(rs.triangles / 1000).toFixed(1)}k tris`],
      ['Entities', `${this.entityManager.count} (${this.entityManager.stats.items} items, ${this.entityManager.stats.passive + this.entityManager.stats.hostile} mobs)`],
      ['Particles', String(this.particles.liveCount)],
      ['Memory', `${(world.memoryFootprint() / 1048576).toFixed(1)} MB voxels · ${(this.renderer.chunkRenderer.stats.gpuBytes / 1048576).toFixed(1)} MB GPU`],
      ['Edits', String(world.stats.edits)],
      ['Target', this.interaction && this.interaction.target
        ? `${BlockRegistry.get(this.interaction.target.id).name} @ ${this.interaction.target.x},${this.interaction.target.y},${this.interaction.target.z}`
        : 'none'],
      ['Held', held ? `${ItemRegistry.name(held.item)} ×${held.count}` : 'empty'],
      ['Health', `${player.health.toFixed(1)} / ${player.maxHealth}`],
      ['Audio', this.audio.ready ? 'on' : 'silent']
    ];
    return rows;
  }

  // =========================================================================
  // Failure handling
  // =========================================================================

  /** Show a fatal error without losing the ability to return to the menu. */
  fail(message, error) {
    console.error(`[Game] ${message}:`, error);
    this.state = GameState.ERROR;
    this.hud.hide();
    this.input.enabled = false;
    this.menus.showError(message, error && error.stack ? error.stack : String(error));
  }

  /**
   * Save the current frame as a PNG download. The renderer keeps its drawing
   * buffer, so the canvas can be read back after the frame has been presented.
   */
  saveScreenshot() {
    try {
      const url = this.canvas.toDataURL('image/png');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const link = document.createElement('a');
      link.href = url;
      link.download = `voxelhaven-${stamp}.png`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      this.hud.toast('Screenshot saved', 'info', 1.8);
    } catch (err) {
      this.hud.toast('Could not save a screenshot', 'error', 3);
      console.warn('[Game] screenshot failed:', err);
    }
  }

  /**
   * Change the render distance at runtime (used by the settings screen and by
   * the automated tests, which run on a software renderer and want a small world).
   */
  setRenderDistance(chunks) {
    this.menus.settings.renderDistance = chunks;
    if (this.chunkManager) this.chunkManager.setRenderDistance(chunks);
  }

  /** Resize handling for the canvas. */
  onResize() {
    this.renderer.resize();
    if (this.camera) this.camera.update(this.renderer.aspect);
  }
}

/** Fog colour used while the camera is submerged. */
const UNDERWATER_FOG = new Float32Array([0.10, 0.28, 0.52]);

/**
 * View-space boxes making up the first-person arm, drawn under the held item.
 *
 * The arm exists so the held item reads as gripped rather than floating. It is
 * deliberately a separate, non-overlapping run of boxes: an upper arm running
 * down and out of the bottom-right of the screen, and a fist at its top. See
 * the placement note in buildHeldItem for how the depths were chosen.
 */
const HELD_ARM = [
  // Upper arm: angled down-right, most of it off screen. It must stay clear of
  // the near plane — an earlier placement put its near end at w = 0.28, which
  // blew it up to ~900 px wide and clipped it away entirely.
  { x: 0.60, y: -0.62, z: -1.25, yaw: 0.20, pitch: 0.30, roll: 0.10, sx: 0.13, sy: 0.40, sz: 0.13 },
  // Fist: tucked directly under the item so the two read as gripped.
  { x: 0.50, y: -0.32, z: -1.05, yaw: 0.30, pitch: -0.20, roll: 0.12, sx: 0.13, sy: 0.16, sz: 0.13 }
];

/**
 * Compose a view-space (not world-space) transform for the held item.
 * Rotation order is Y then X then Z, matching mat4Compose.
 */
function composeViewMatrix(out, x, y, z, yaw, pitch, roll, sx, sy, sz) {
  const cy = Math.cos(yaw), sy_ = Math.sin(yaw);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const cr = Math.cos(roll), sr = Math.sin(roll);

  out[0] = (cy * cr + sy_ * sp * sr) * sx;
  out[1] = (cp * sr) * sx;
  out[2] = (-sy_ * cr + cy * sp * sr) * sx;
  out[3] = 0;
  out[4] = (-cy * sr + sy_ * sp * cr) * sy;
  out[5] = (cp * cr) * sy;
  out[6] = (sy_ * sr + cy * sp * cr) * sy;
  out[7] = 0;
  out[8] = (sy_ * cp) * sz;
  out[9] = (-sp) * sz;
  out[10] = (cy * cp) * sz;
  out[11] = 0;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  out[15] = 1;
  return out;
}

/** Human readable description of where worlds are being stored. */
function storageNote(saveSystem) {
  if (saveSystem.apiAvailable) {
    return 'Worlds are saved to disk by the Voxelhaven server (saves/ directory).';
  }
  return 'Server storage unavailable — worlds are kept in this browser only.';
}

/** Promise that resolves on the next animation frame. */
function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export { GameState };
