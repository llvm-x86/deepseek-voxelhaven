/**
 * TimeSystem.js — the day/night cycle and everything the renderer needs to
 * know about the current lighting environment.
 *
 * Time is stored as a normalised value in [0,1):
 *   0.00 sunrise   0.25 noon   0.50 sunset   0.75 midnight
 *
 * The environment object is mutated in place rather than rebuilt each frame,
 * and is read by the renderer, the sky shader and the mob spawner.
 */

import { TIME } from '../core/Config.js';

/** Smooth 0..1 ramp between two edges (Hermite). */
function smoothstep(edge0, edge1, x) {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Component-wise lerp of two RGB triples into `out`. */
function lerpRGB(out, a, b, t) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

// ---------------------------------------------------------------------------
// Keyframes
// ---------------------------------------------------------------------------

const SKY_TOP_DAY = [0.28, 0.53, 0.92];
const SKY_TOP_NIGHT = [0.015, 0.025, 0.075];
const SKY_TOP_DUSK = [0.24, 0.20, 0.44];

const SKY_HORIZON_DAY = [0.68, 0.82, 0.97];
const SKY_HORIZON_NIGHT = [0.04, 0.06, 0.14];
const SKY_HORIZON_DUSK = [0.96, 0.50, 0.26];

const CLOUD_DAY = [0.98, 0.99, 1.0];
const CLOUD_NIGHT = [0.16, 0.19, 0.30];
const CLOUD_DUSK = [0.92, 0.66, 0.58];

const SUN_DAY = [1.0, 0.97, 0.90];
const SUN_DUSK = [1.0, 0.58, 0.32];

const SKYLIGHT_DAY = [1.0, 0.99, 0.94];
const SKYLIGHT_NIGHT = [0.42, 0.50, 0.78];
const SKYLIGHT_DUSK = [1.0, 0.80, 0.66];

export class TimeSystem {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {number} [startTime] normalised time of day in [0,1)
   */
  constructor(bus, startTime = TIME.startTime) {
    this.bus = bus;
    /** Normalised time of day, [0,1). */
    this.time = ((startTime % 1) + 1) % 1;
    /** Total elapsed in-game days, useful for logging and saves. */
    this.dayCount = 0;
    /** Real seconds elapsed, drives cloud drift and shader animation. */
    this.elapsedSeconds = 0;
    /** Real seconds for one full day; changeable from the settings screen. */
    this.dayLengthSeconds = TIME.dayLengthSeconds;
    /** Set to false to freeze the cycle (used by the pause menu is NOT desired;
     *  pausing stops update() entirely instead). */
    this.running = true;

    /** @type {number} 0 = night, 1 = full day */
    this.dayBrightness = 1;
    /** @type {boolean} true between sunset and sunrise */
    this.night = false;

    this._lastDayPhase = this.night;

    // Reused environment record so the render loop allocates nothing.
    this.environment = {
      timeSeconds: 0,
      timeOfDay: this.time,
      dayCount: 0,
      dayBrightness: 1,
      night: false,
      sunDirection: new Float32Array([0, 1, 0]),
      sunColor: new Float32Array(3),
      skyTop: new Float32Array(3),
      skyHorizon: new Float32Array(3),
      cloudColor: new Float32Array(3),
      skyLightColor: new Float32Array(3),
      blockLightColor: new Float32Array(TIME.blockLightColor),
      fogColor: new Float32Array(3),
      fogNear: 60,
      fogFar: TIME.fogFarDay,
      minAmbient: TIME.minAmbient,
      starAmount: 0
    };
    this.refreshEnvironment();
  }

  /** Advance the cycle. @param {number} dt seconds */
  update(dt) {
    if (!this.running) return;
    this.elapsedSeconds += dt;
    const before = this.time;
    this.time += dt / Math.max(1, this.dayLengthSeconds);
    if (this.time >= 1) {
      this.time -= Math.floor(this.time);
      this.dayCount++;
      this.bus.emit('newDay', this.dayCount);
    }
    if (this.time < before) this.bus.emit('newDay', this.dayCount);
    this.refreshEnvironment();

    if (this.night !== this._lastDayPhase) {
      this._lastDayPhase = this.night;
      this.bus.emit(this.night ? 'nightfall' : 'sunrise');
    }
  }

  /** How far through the day we are, in [0,1). */
  get timeOfDay() {
    return this.time;
  }

  /** True when the sun is below the horizon. */
  isNight() {
    return this.night;
  }

  /**
   * Set the time of day directly (used when loading a save and by the debug API).
   * @param {number} t normalised [0,1)
   */
  setTime(t) {
    this.time = ((t % 1) + 1) % 1;
    this.refreshEnvironment();
  }

  /** Recompute the environment record from the current time. */
  refreshEnvironment() {
    const env = this.environment;
    const t = this.time;

    // Sun angle: 0 at noon, +/-pi/2 at the horizon, pi at midnight.
    const angle = (t - 0.25) * Math.PI * 2;
    const sinA = Math.sin(angle);
    const cosA = Math.cos(angle);
    // Tilted orbital plane so the sun rises in one direction and sets in another.
    let sx = sinA * 0.52;
    let sy = cosA;
    let sz = sinA * 0.854;
    const len = Math.hypot(sx, sy, sz) || 1;
    env.sunDirection[0] = sx / len;
    env.sunDirection[1] = sy / len;
    env.sunDirection[2] = sz / len;

    const height = sy; // -1 (midnight) .. 1 (noon)
    // How "day" it is, and how close to the horizon (for warm sunset colours).
    const dayT = smoothstep(-0.16, 0.26, height);
    const duskT = Math.exp(-Math.pow(height / 0.26, 2));

    this.dayBrightness = lerp(TIME.nightBrightness, TIME.dayBrightness, dayT);
    this.night = dayT < 0.28;

    env.timeSeconds = this.elapsedSeconds;
    env.timeOfDay = t;
    env.dayCount = this.dayCount;
    env.dayBrightness = this.dayBrightness;
    env.night = this.night;

    // Sky and light colours: night -> dusk -> day, with dusk blended in on top.
    lerpRGB(env.skyTop, SKY_TOP_NIGHT, SKY_TOP_DAY, dayT);
    lerpRGB(env.skyTop, env.skyTop, SKY_TOP_DUSK, duskT * 0.55);
    lerpRGB(env.skyHorizon, SKY_HORIZON_NIGHT, SKY_HORIZON_DAY, dayT);
    lerpRGB(env.skyHorizon, env.skyHorizon, SKY_HORIZON_DUSK, duskT * 0.7);
    lerpRGB(env.cloudColor, CLOUD_NIGHT, CLOUD_DAY, dayT);
    lerpRGB(env.cloudColor, env.cloudColor, CLOUD_DUSK, duskT * 0.5);
    lerpRGB(env.sunColor, SUN_DUSK, SUN_DAY, smoothstep(0.02, 0.42, height));
    lerpRGB(env.skyLightColor, SKYLIGHT_NIGHT, SKYLIGHT_DAY, dayT);
    lerpRGB(env.skyLightColor, env.skyLightColor, SKYLIGHT_DUSK, duskT * 0.6);

    // Fog matches the horizon so distant terrain dissolves into the sky.
    env.fogColor[0] = env.skyHorizon[0] * 0.94;
    env.fogColor[1] = env.skyHorizon[1] * 0.94;
    env.fogColor[2] = env.skyHorizon[2] * 0.96;

    const fogFar = lerp(TIME.fogFarNight, TIME.fogFarDay, dayT);
    env.fogFar = fogFar;
    env.fogNear = fogFar * TIME.fogStartRatio;
    env.starAmount = Math.pow(1 - dayT, 1.6);
    return env;
  }

  /** Current environment record (do not mutate). */
  getEnvironment() {
    return this.environment;
  }

  /** Time formatted as a 24-hour clock for the debug overlay. */
  formatClock() {
    // Shift so that 0.25 (noon) reads as 12:00.
    const hours = (this.time * 24 + 6) % 24;
    const h = Math.floor(hours);
    const m = Math.floor((hours - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}
