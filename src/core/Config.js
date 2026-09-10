/**
 * Config.js — every tunable constant in Voxelhaven.
 *
 * Nothing else in the codebase should contain a bare magic number that a
 * designer might reasonably want to change; it belongs here instead.
 */

// ---------------------------------------------------------------------------
// World geometry
// ---------------------------------------------------------------------------

/** Horizontal size of a chunk in blocks (X and Z). Power of two: 16. */
export const CHUNK_SIZE = 16;
/** Base-2 log of CHUNK_SIZE; used for fast shifting and masking. */
export const CHUNK_BITS = 4;
/** Bit mask for local coordinates inside a chunk. */
export const CHUNK_MASK = CHUNK_SIZE - 1;
/** Vertical size of the world in blocks. */
export const WORLD_HEIGHT = 128;
/** Squared horizontal area of one chunk, in blocks. */
export const CHUNK_AREA = CHUNK_SIZE * CHUNK_SIZE;
/** Number of blocks in one chunk column-stack. */
export const CHUNK_VOLUME = CHUNK_AREA * WORLD_HEIGHT;

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/** Chunks are generated/kept inside this radius (in chunks) around the player. */
export const RENDER_DISTANCE = 8;
/** Chunks beyond RENDER_DISTANCE + this margin are unloaded and their meshes freed. */
export const UNLOAD_MARGIN = 2;
/** Milliseconds per frame granted to terrain/mesh work before yielding. */
export const FRAME_BUDGET_MS = 8;
/** Milliseconds per frame granted to light recalculation jobs. */
export const LIGHT_BUDGET_MS = 4;
/** Upper bound on chunk meshes uploaded to the GPU per frame. */
export const MAX_MESH_UPLOADS_PER_FRAME = 3;
/** Number of terrain-generation worker threads (0 disables workers). */
export const TERRAIN_WORKERS = 3;

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

export const PLAYER = {
  /** Collision box width and depth in blocks. */
  width: 0.6,
  /** Standing eye/box height in blocks. */
  height: 1.8,
  /** Height when crouching. */
  crouchHeight: 1.35,
  /** Eye offset below the top of the collision box. */
  eyeOffset: 0.18,
  /** Walk speed, blocks/second. */
  walkSpeed: 4.6,
  /** Sprint speed, blocks/second. */
  sprintSpeed: 7.1,
  /** Crouch speed, blocks/second. */
  crouchSpeed: 1.9,
  /** Upward velocity applied on jump, blocks/second. */
  jumpVelocity: 8.4,
  /** Downward acceleration, blocks/second². */
  gravity: 30.0,
  /** Terminal fall speed, blocks/second. */
  terminalVelocity: 58.0,
  /** Horizontal acceleration while grounded, blocks/second². */
  groundAccel: 46.0,
  /** Horizontal acceleration while airborne (reduced air control). */
  airAccel: 9.0,
  /** Ground friction coefficient (per second, exponential decay). */
  groundFriction: 34.0,
  /** Air drag coefficient. */
  airDrag: 0.6,
  /** Maximum horizontal speed ever allowed (safety clamp). */
  maxHorizontalSpeed: 24.0,
  /** How far the player can reach to break/place blocks, in blocks. */
  reach: 5.0,
  /** Maximum height the player may step up without jumping. */
  stepHeight: 0.55,
  /** Fall distance (blocks) before fall damage begins. */
  safeFallDistance: 3.5,
  /** Damage per block fallen beyond safeFallDistance. */
  fallDamagePerBlock: 1.0,
  /** Maximum health in half-hearts (20 = 10 hearts). */
  maxHealth: 20,
  /** Health regenerated per second while the player has recently eaten... i.e. slow regen. */
  healthRegenPerSecond: 0.25,
  /** Seconds after taking damage before regeneration resumes. */
  regenDelaySeconds: 6.0,
  /** Damage taken per second while out of air. */
  drowningDamagePerSecond: 2.0,
  /** Maximum breath in seconds. */
  maxBreathSeconds: 14.0,
  /** Movement speed multiplier while submerged. */
  swimSpeedMultiplier: 0.55,
  /** Upward acceleration while swimming and holding jump. */
  swimUpVelocity: 3.6,
  /** Vertical sink speed while in water. */
  swimSinkVelocity: -1.6,
};

// ---------------------------------------------------------------------------
// Interaction
// ---------------------------------------------------------------------------

export const INTERACTION = {
  /** Extra distance added to the raycast so it lands exactly on the block surface. */
  rayEpsilon: 1e-4,
  /** Seconds between automatic repeated block breaking while the button is held. */
  repeatBreakDelay: 0.22,
  /** Seconds between automatic repeated block placing while the button is held. */
  repeatPlaceDelay: 0.20,
  /** Radius in blocks within which dropped items are pulled into the inventory. */
  pickupRadius: 1.65,
  /** Delay before a newly dropped item can be picked up (seconds). */
  pickupDelay: 0.45,
};

// ---------------------------------------------------------------------------
// Time / day-night cycle
// ---------------------------------------------------------------------------

export const TIME = {
  /** Real seconds for one full in-game day. */
  dayLengthSeconds: 600,
  /** Fraction of the day that is day-time (0..1). */
  dayFraction: 0.55,
  /** Starting time of day as a normalized 0..1 value (0 = sunrise, 0.25 = noon). */
  startTime: 0.05,
  /** Skylight multiplier during full day. */
  dayBrightness: 1.0,
  /** Skylight multiplier during full night. */
  nightBrightness: 0.17,
  /** Added to the light term so nothing ever renders pure black. */
  minAmbient: 0.055,
  /** Sun light colour at noon. */
  dayColor: [1.0, 0.99, 0.94],
  /** Sun light colour at dusk/dawn. */
  duskColor: [1.0, 0.62, 0.38],
  /** Skylight colour during night. */
  nightColor: [0.42, 0.5, 0.78],
  /** Lantern (block light) colour. */
  blockLightColor: [1.0, 0.82, 0.55],
  /** Fog distance at noon, in blocks. */
  fogFarDay: 150.0,
  /** Fog distance at night, in blocks. */
  fogFarNight: 88.0,
  /** Fog distance while submerged, in blocks. */
  fogFarUnderwater: 18.0,
};

// ---------------------------------------------------------------------------
// Lighting
// ---------------------------------------------------------------------------

export const LIGHT = {
  /** Maximum light value (4 bits of precision, 0..15). */
  max: 15,
  /** Skylight lost per block of water travelled. */
  waterAttenuation: 2,
  /** Skylight lost per block of leaves travelled. */
  leafAttenuation: 1,
  /** Block light emitted by a lantern. */
  lanternEmission: 14,
  /** Block light emitted by a glowcap. */
  glowcapEmission: 9,
};

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

export const RENDER = {
  /** Vertical field of view in degrees. */
  fov: 72,
  /** Near/far clip planes. */
  near: 0.06,
  far: 400.0,
  /** Fog start as a fraction of the fog end distance. */
  fogStartRatio: 0.55,
  /** Pixels per atlas tile edge (tiles are square). */
  tileSize: 16,
  /** Atlas grid dimension (16 => 256 tiles). */
  atlasGrid: 16,
  /** Maximum devicePixelRatio used for the framebuffer (perf guard). */
  maxPixelRatio: 2,
  /** Face-direction brightness multipliers, baked into the mesh. */
  faceShade: {
    top: 1.0,
    bottom: 0.52,
    north: 0.78,
    south: 0.78,
    east: 0.66,
    west: 0.66
  },
  /** Ambient occlusion strength (0 = off, 1 = full). */
  aoStrength: 0.72,
  /** Crosshair gap in CSS pixels. */
  crosshairGap: 5,
  /** Field of view "punch" applied while sprinting, in degrees. */
  sprintFovBoost: 4.0,
  /** View bobbing amplitude in blocks. */
  viewBobAmount: 0.045,
  /** View bobbing frequency in cycles per block travelled. */
  viewBobFrequency: 1.6,
};

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export const ENTITIES = {
  /** Hard cap on simultaneously live entities. */
  maxEntities: 220,
  /** Items despawn after this many seconds once their age exceeds it. */
  itemLifetimeSeconds: 300,
  /** Entity simulation is skipped beyond this distance from the player. */
  simulationDistance: 72,
  /** Gravity applied to entities. */
  gravity: 26.0,
  /** Hostile mobs only spawn when skylight is at or below this level. */
  hostileSpawnMaxLight: 6,
  /** Attempted hostile spawns per second. */
  hostileSpawnAttemptsPerSecond: 0.65,
  /** Attempted passive spawns per second. */
  passiveSpawnAttemptsPerSecond: 0.30,
  /** Minimum / maximum distance from the player for natural spawns. */
  spawnMinDistance: 14,
  spawnMaxDistance: 46,
  /** Mobs further than this from the player are removed. */
  despawnDistance: 78,
  /** Maximum simultaneously live hostile mobs. */
  maxHostile: 14,
  /** Maximum simultaneously live passive mobs. */
  maxPassive: 10,
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export const SAVE = {
  /** Bumped whenever the save format changes incompatibly. */
  formatVersion: 3,
  /** localStorage/API key prefix. */
  keyPrefix: 'voxelhaven.save.',
  /** Autosave interval in seconds. */
  autosaveIntervalSeconds: 90,
  /** Maximum number of edits stored per chunk before compaction warning. */
  maxEditsPerChunk: 4096,
};

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export const AUDIO = {
  /** Master gain (0..1). */
  masterVolume: 0.5,
  /** Footstep interval in seconds while walking. */
  footstepIntervalWalk: 0.42,
  /** Footstep interval while sprinting. */
  footstepIntervalSprint: 0.30,
  /** Whether audio starts enabled. */
  enabledByDefault: true
};

// ---------------------------------------------------------------------------
// Debug / dev
// ---------------------------------------------------------------------------

export const DEBUG = {
  /** Expose window.__VOXELHAVEN__ for the automated integration tests and console. */
  exposeDebugApi: true,
  /** Show the F3 overlay on boot. */
  showDebugOverlayOnBoot: false
};

/** Human-readable name of the game, used across the UI. */
export const GAME_NAME = 'Voxelhaven';
/** Save-format friendly version string shown in the UI. */
export const GAME_VERSION = '1.0.0';
