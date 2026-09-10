/**
 * AudioSystem.js — every sound in the game, synthesised at runtime with the
 * Web Audio API.
 *
 * No audio files are used or needed: block breaks are filtered noise bursts,
 * footsteps are short thumps whose pitch depends on the block material,
 * pickups are little arpeggios, and there is a slow ambient pad that fades in
 * at night. Everything is generated from oscillators and a noise buffer, so the
 * project ships with zero third-party assets.
 *
 * Audio is created lazily on the first user gesture, which is what browsers
 * require before an AudioContext may produce sound.
 */

import { AUDIO } from '../core/Config.js';

/**
 * Per-material sound design.
 *  noiseHz   — centre frequency of the filtered noise burst
 *  q         — filter resonance
 *  decay     — seconds for the burst to fade
 *  toneHz    — optional pitched component
 *  toneGain  — level of the pitched component
 */
const MATERIALS = {
  stone: { noiseHz: 1400, q: 1.4, decay: 0.16, toneHz: 180, toneGain: 0.35, gain: 0.75 },
  dirt: { noiseHz: 620, q: 0.8, decay: 0.18, toneHz: 110, toneGain: 0.3, gain: 0.7 },
  grass: { noiseHz: 2400, q: 0.7, decay: 0.13, toneHz: 0, toneGain: 0, gain: 0.5 },
  sand: { noiseHz: 3200, q: 0.6, decay: 0.14, toneHz: 0, toneGain: 0, gain: 0.45 },
  wood: { noiseHz: 880, q: 2.2, decay: 0.17, toneHz: 240, toneGain: 0.45, gain: 0.75 },
  glass: { noiseHz: 5200, q: 3.0, decay: 0.22, toneHz: 1800, toneGain: 0.3, gain: 0.5 },
  liquid: { noiseHz: 500, q: 1.1, decay: 0.24, toneHz: 0, toneGain: 0, gain: 0.55 },
  plant: { noiseHz: 3000, q: 0.8, decay: 0.10, toneHz: 0, toneGain: 0, gain: 0.4 },
  none: { noiseHz: 800, q: 1, decay: 0.1, toneHz: 0, toneGain: 0, gain: 0.0 }
};

export class AudioSystem {
  /** @param {import('../core/EventBus.js').EventBus} bus */
  constructor(bus) {
    this.bus = bus;
    /** @type {AudioContext|null} */
    this.context = null;
    /** @type {GainNode|null} */
    this.master = null;
    /** @type {AudioBuffer|null} reusable white-noise buffer */
    this.noiseBuffer = null;
    this.enabled = AUDIO.enabledByDefault;
    this.volume = AUDIO.masterVolume;
    /** Ambient night pad nodes, created on demand. */
    this.ambientNodes = null;
    /** Minimum spacing between identical sounds, prevents machine-gunning. */
    this._lastPlayed = new Map();
  }

  /** True when sound can actually be produced right now. */
  get ready() {
    return !!this.context && this.context.state === 'running' && this.enabled;
  }

  /**
   * Create the AudioContext. Must be called from a user gesture (a click or a
   * key press) or the browser will leave it suspended.
   */
  unlock() {
    if (this.context) {
      if (this.context.state === 'suspended') {
        this.context.resume().catch(() => {});
      }
      return;
    }
    try {
      const Ctor = window.AudioContext || window.webkitAudioContext;
      if (!Ctor) {
        console.warn('[Audio] Web Audio API is unavailable; running silently');
        return;
      }
      const context = new Ctor();
      const master = context.createGain();
      master.gain.value = this.enabled ? this.volume : 0;
      master.connect(context.destination);
      this.context = context;
      this.master = master;
      this.noiseBuffer = this._createNoiseBuffer(context, 1.0);
      if (context.state === 'suspended') context.resume().catch(() => {});
    } catch (err) {
      console.warn('[Audio] could not start the audio context:', err);
      this.context = null;
      this.master = null;
    }
  }

  /** Build a second of white noise, reused by every percussive sound. */
  _createNoiseBuffer(context, seconds) {
    const length = Math.max(1, Math.floor(context.sampleRate * seconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    return buffer;
  }

  /** Toggle sound on and off. */
  setEnabled(enabled) {
    this.enabled = enabled;
    if (this.master && this.context) {
      this.master.gain.setTargetAtTime(enabled ? this.volume : 0, this.context.currentTime, 0.02);
    }
    this.bus.emit('audioToggled', enabled);
  }

  /** Flip the mute state and return the new value. */
  toggle() {
    this.setEnabled(!this.enabled);
    return this.enabled;
  }

  /** Change the master volume (0..1). */
  setVolume(volume) {
    this.volume = Math.max(0, Math.min(1, volume));
    if (this.master && this.context && this.enabled) {
      this.master.gain.setTargetAtTime(this.volume, this.context.currentTime, 0.02);
    }
  }

  /** Rate-limit a sound key so it cannot retrigger faster than `minGap`. */
  _throttle(key, minGap) {
    const now = this.context ? this.context.currentTime : performance.now() / 1000;
    const last = this._lastPlayed.get(key);
    if (last !== undefined && now - last < minGap) return false;
    this._lastPlayed.set(key, now);
    return true;
  }

  /**
   * Play a block-related sound.
   * @param {'break'|'place'|'step'} kind
   * @param {string} material one of the MATERIALS keys
   */
  playBlockSound(kind, material) {
    if (!this.ready) return;
    const config = MATERIALS[material] || MATERIALS.stone;
    if (config.gain <= 0) return;
    // Breaking is louder and slower than placing; footsteps are quieter still.
    const level = kind === 'break' ? 1.0 : kind === 'place' ? 0.72 : 0.34;
    const pitch = kind === 'break' ? 1.0 : kind === 'place' ? 1.18 : 0.82;
    this._noiseBurst(config, level, pitch);
  }

  /** Filtered noise burst plus an optional pitched body. */
  _noiseBurst(config, level, pitch = 1) {
    const context = this.context;
    const now = context.currentTime;
    const duration = config.decay;

    const source = context.createBufferSource();
    source.buffer = this.noiseBuffer;
    // Start at a random offset so repeated hits do not sound identical.
    const offset = Math.random() * Math.max(0.01, this.noiseBuffer.duration - duration - 0.01);
    source.playbackRate.value = pitch;

    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = config.noiseHz * pitch;
    filter.Q.value = config.q;

    const gain = context.createGain();
    const peak = config.gain * level * 0.5;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), now + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    source.connect(filter);
    filter.connect(gain);
    gain.connect(this.master);
    source.start(now, offset, duration + 0.02);
    source.stop(now + duration + 0.03);

    if (config.toneHz > 0 && config.toneGain > 0) {
      const osc = context.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(config.toneHz * pitch, now);
      osc.frequency.exponentialRampToValueAtTime(Math.max(30, config.toneHz * pitch * 0.6), now + duration);
      const oscGain = context.createGain();
      oscGain.gain.setValueAtTime(0.0001, now);
      oscGain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * config.toneGain), now + 0.008);
      oscGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
      osc.connect(oscGain);
      oscGain.connect(this.master);
      osc.start(now);
      osc.stop(now + duration + 0.02);
    }
  }

  /** A short pitched blip. */
  _tone(frequency, duration, type = 'sine', level = 0.25, endFrequency = null) {
    const context = this.context;
    const now = context.currentTime;
    const osc = context.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(frequency, now);
    if (endFrequency) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + duration);
    const gain = context.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(level, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    osc.connect(gain);
    gain.connect(this.master);
    osc.start(now);
    osc.stop(now + duration + 0.02);
  }

  /**
   * Play a named game sound.
   * @param {string} name
   */
  play(name) {
    if (!this.ready) return;
    switch (name) {
      case 'jump':
        if (!this._throttle('jump', 0.12)) return;
        this._tone(340, 0.12, 'triangle', 0.16, 520);
        break;
      case 'land':
        if (!this._throttle('land', 0.1)) return;
        this._noiseBurst(MATERIALS.dirt, 0.6, 0.9);
        break;
      case 'hurt':
        if (!this._throttle('hurt', 0.3)) return;
        this._tone(220, 0.22, 'sawtooth', 0.22, 110);
        break;
      case 'hit':
        if (!this._throttle('hit', 0.12)) return;
        this._tone(160, 0.1, 'square', 0.16, 90);
        this._noiseBurst(MATERIALS.dirt, 0.5, 1.4);
        break;
      case 'pickup':
        if (!this._throttle('pickup', 0.05)) return;
        this._tone(660, 0.08, 'sine', 0.18, 880);
        break;
      case 'craft':
        if (!this._throttle('craft', 0.1)) return;
        this._tone(520, 0.1, 'triangle', 0.2, 780);
        setTimeout(() => {
          if (this.ready) this._tone(780, 0.12, 'triangle', 0.18, 1040);
        }, 70);
        break;
      case 'death':
        this._tone(300, 0.9, 'sawtooth', 0.3, 70);
        break;
      case 'respawn':
        this._tone(440, 0.3, 'sine', 0.22, 880);
        break;
      case 'click':
        if (!this._throttle('click', 0.06)) return;
        this._tone(880, 0.04, 'square', 0.1);
        break;
      case 'splash':
        if (!this._throttle('splash', 0.25)) return;
        this._noiseBurst(MATERIALS.liquid, 0.9, 1.0);
        break;
      case 'mobHurt':
        if (!this._throttle('mobHurt', 0.12)) return;
        this._tone(200, 0.16, 'sawtooth', 0.16, 120);
        break;
      default:
        break;
    }
  }

  /**
   * Ambient audio: a slow, quiet drone that fades in at night and out by day.
   * @param {number} dayBrightness 0..1
   */
  updateAmbience(dayBrightness) {
    if (!this.ready) return;
    const night = 1 - dayBrightness;
    const target = night * 0.05;

    if (!this.ambientNodes) {
      const context = this.context;
      const gain = context.createGain();
      gain.gain.value = 0;
      gain.connect(this.master);

      const oscA = context.createOscillator();
      oscA.type = 'sine';
      oscA.frequency.value = 58.27; // Bb1
      const oscB = context.createOscillator();
      oscB.type = 'sine';
      oscB.frequency.value = 87.31; // F2, a fifth above
      const filter = context.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 320;
      oscA.connect(filter);
      oscB.connect(filter);
      filter.connect(gain);
      oscA.start();
      oscB.start();
      this.ambientNodes = { gain, oscA, oscB, filter };
    }
    this.ambientNodes.gain.gain.setTargetAtTime(target, this.context.currentTime, 1.5);
  }

  /** Stop all scheduled sounds and release the context. */
  dispose() {
    if (this.ambientNodes) {
      try {
        this.ambientNodes.oscA.stop();
        this.ambientNodes.oscB.stop();
      } catch { /* already stopped */ }
      this.ambientNodes = null;
    }
    if (this.context) {
      this.context.close().catch(() => {});
      this.context = null;
      this.master = null;
    }
  }
}
