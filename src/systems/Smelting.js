/**
 * Smelting.js — the furnace simulation.
 *
 * A furnace is a small state machine attached to a world position:
 *
 *   input + fuel -> (burn timer) -> (cook timer) -> output
 *
 * Fuel is consumed a whole item at a time and turns into a fixed number of
 * seconds of heat (`fuelValue` items x `SECONDS_PER_ITEM`), exactly the way a
 * piece of coal smelts eight things. The burn timer keeps running while the
 * furnace is lit even if the input runs out, which is what makes the fuel
 * gauge in the UI behave the way players expect.
 *
 * The module is DOM-free and deterministic; the UI and the world only read
 * state from it. Stations are serialised into the save document, so a furnace
 * caught mid-smelt resumes where it left off.
 */

import { ItemRegistry } from '../world/Items.js';
import { RecipeBook } from '../data/RecipeBook.js';

/** Real seconds one unit of fuel value burns for. */
export const SECONDS_PER_ITEM = 10;

/**
 * @typedef {Object} Station
 * @property {number} x
 * @property {number} y
 * @property {number} z
 * @property {{item:string,count:number}|null} input
 * @property {{item:string,count:number}|null} fuel
 * @property {{item:string,count:number}|null} output
 * @property {number} burnRemaining seconds of heat left
 * @property {number} burnTotal     seconds the current fuel item provides
 * @property {number} cookProgress  seconds of progress on the current item
 * @property {number} cookTotal     seconds the current recipe needs
 * @property {boolean} lit
 */

export class Smelting {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   */
  constructor(bus) {
    this.bus = bus;
    /** @type {Map<string, Station>} */
    this.stations = new Map();
    /** Recipe book to read; defaults to the shared snapshot. */
    this.book = null;
  }

  /** The book in use, falling back to the loaded snapshot. */
  _book() {
    return this.book || RecipeBook.current();
  }

  /** Override the recipe book (used by the offline tests). */
  useBook(book) {
    this.book = book;
  }

  /** Map key for a furnace position. */
  static key(x, y, z) {
    return `${x},${y},${z}`;
  }

  /**
   * The station at a position, creating an empty one on first use.
   * @returns {Station}
   */
  ensure(x, y, z) {
    const key = Smelting.key(x, y, z);
    let station = this.stations.get(key);
    if (!station) {
      station = {
        x, y, z,
        input: null,
        fuel: null,
        output: null,
        burnRemaining: 0,
        burnTotal: 0,
        cookProgress: 0,
        cookTotal: 0,
        lit: false
      };
      this.stations.set(key, station);
    }
    return station;
  }

  /** The station at a position, or null when it has never been used. */
  get(x, y, z) {
    return this.stations.get(Smelting.key(x, y, z)) || null;
  }

  /** True when the station holds anything worth persisting. */
  static isEmpty(station) {
    return !station.input && !station.fuel && !station.output;
  }

  /** Forget a station (the furnace block was broken). */
  remove(x, y, z) {
    return this.stations.delete(Smelting.key(x, y, z));
  }

  /**
   * Put items into the input slot.
   * @returns {number} how many could not be accepted
   */
  insertInput(x, y, z, stack) {
    const station = this.ensure(x, y, z);
    const leftover = mergeInto(station, 'input', stack);
    this.bus.emit('smeltingChanged', { x, y, z });
    return leftover;
  }

  /**
   * Put items into the fuel slot. Only real fuels are accepted, so the player
   * cannot park a stack of dirt in the furnace.
   * @returns {number} how many could not be accepted
   */
  insertFuel(x, y, z, stack) {
    if (this._book().fuelValue(stack.item) <= 0) return stack.count;
    const station = this.ensure(x, y, z);
    const leftover = mergeInto(station, 'fuel', stack);
    this.bus.emit('smeltingChanged', { x, y, z });
    return leftover;
  }

  /** Take everything out of the output slot. */
  takeOutput(x, y, z) {
    const station = this.get(x, y, z);
    if (!station || !station.output) return null;
    const stack = station.output;
    station.output = null;
    this.bus.emit('smeltingChanged', { x, y, z });
    return stack;
  }

  /**
   * Advance every furnace by one step.
   * @param {number} dt seconds
   */
  update(dt) {
    const book = this._book();
    for (const station of this.stations.values()) {
      this._updateStation(station, dt, book);
    }
  }

  /** One furnace, one step. */
  _updateStation(station, dt, book) {
    const recipe = station.input ? book.smeltingFor(station.input.item) : null;
    const maxStack = recipe ? ItemRegistry.maxStack(recipe.output.item) : 0;
    const outputFits = !!(recipe && (!station.output
      || (station.output.item === recipe.output.item && station.output.count + recipe.output.count <= maxStack)));
    const wantsToCook = !!(recipe && outputFits);

    // Burn down whatever heat is left.
    if (station.burnRemaining > 0) {
      station.burnRemaining = Math.max(0, station.burnRemaining - dt);
    }

    // Light the next fuel item when there is work to do and no heat left.
    if (wantsToCook && station.burnRemaining <= 0 && station.fuel) {
      const value = book.fuelValue(station.fuel.item);
      if (value > 0) {
        station.fuel.count -= 1;
        if (station.fuel.count <= 0) station.fuel = null;
        station.burnTotal = value * SECONDS_PER_ITEM;
        station.burnRemaining = station.burnTotal;
        this.bus.emit('furnaceLit', { x: station.x, y: station.y, z: station.z });
      }
    }

    station.lit = station.burnRemaining > 0;

    if (wantsToCook && station.lit) {
      station.cookTotal = recipe.seconds;
      station.cookProgress += dt;
      if (station.cookProgress >= recipe.seconds) {
        station.cookProgress = 0;
        station.input.count -= 1;
        if (station.input.count <= 0) station.input = null;
        if (station.output) station.output.count += recipe.output.count;
        else station.output = { item: recipe.output.item, count: recipe.output.count };
        this.bus.emit('smelted', {
          x: station.x, y: station.y, z: station.z,
          item: recipe.output.item, count: recipe.output.count
        });
        this.bus.emit('smeltingChanged', { x: station.x, y: station.y, z: station.z });
      }
      return;
    }

    // Nothing to do: the progress bar slides back rather than snapping, and
    // the partial progress is kept while the furnace is merely between items.
    if (station.cookProgress > 0) {
      station.cookProgress = Math.max(0, station.cookProgress - dt * 2);
    }
  }

  /** Normalised cook progress 0..1 for the UI. */
  progressOf(station) {
    if (!station || !station.cookTotal) return 0;
    return Math.min(1, station.cookProgress / station.cookTotal);
  }

  /** Normalised fuel remaining 0..1 for the UI. */
  heatOf(station) {
    if (!station || !station.burnTotal) return 0;
    return Math.min(1, station.burnRemaining / station.burnTotal);
  }

  /** Serialise every non-empty furnace, keyed by position. */
  serialize() {
    const out = {};
    for (const [key, station] of this.stations) {
      if (Smelting.isEmpty(station)) continue;
      out[key] = {
        input: station.input,
        fuel: station.fuel,
        output: station.output,
        burnRemaining: round(station.burnRemaining),
        burnTotal: round(station.burnTotal),
        cookProgress: round(station.cookProgress),
        cookTotal: round(station.cookTotal)
      };
    }
    return out;
  }

  /**
   * Restore furnaces from a save, skipping unusable entries.
   * @param {object} data
   * @returns {{restored:number, skipped:number}}
   */
  deserialize(data) {
    this.stations.clear();
    let restored = 0;
    let skipped = 0;
    if (!data || typeof data !== 'object') return { restored, skipped };
    for (const [key, value] of Object.entries(data)) {
      const parts = String(key).split(',').map(Number);
      if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) { skipped++; continue; }
      if (!value || typeof value !== 'object') { skipped++; continue; }
      const station = this.ensure(parts[0] | 0, parts[1] | 0, parts[2] | 0);
      station.input = sanitiseStack(value.input);
      station.fuel = sanitiseStack(value.fuel);
      station.output = sanitiseStack(value.output);
      station.burnRemaining = clampNumber(value.burnRemaining, 0, 1e6);
      station.burnTotal = clampNumber(value.burnTotal, 0, 1e6);
      station.cookProgress = clampNumber(value.cookProgress, 0, 1e6);
      station.cookTotal = clampNumber(value.cookTotal, 0, 1e6);
      station.lit = station.burnRemaining > 0;
      if (Smelting.isEmpty(station)) {
        this.stations.delete(key);
        continue;
      }
      restored++;
    }
    return { restored, skipped };
  }

  /** Drop every station (world teardown). */
  clear() {
    this.stations.clear();
  }
}

/** Merge a stack into a named station slot, returning what did not fit. */
function mergeInto(station, slotName, stack) {
  if (!stack || stack.count <= 0) return 0;
  const maxStack = ItemRegistry.maxStack(stack.item);
  const current = station[slotName];
  if (!current) {
    const moved = Math.min(maxStack, stack.count);
    station[slotName] = { item: stack.item, count: moved };
    return stack.count - moved;
  }
  if (current.item !== stack.item) return stack.count;
  const room = maxStack - current.count;
  const moved = Math.min(Math.max(0, room), stack.count);
  current.count += moved;
  return stack.count - moved;
}

/** Validate one saved stack. */
function sanitiseStack(value) {
  if (!value || typeof value !== 'object') return null;
  const item = value.item;
  const count = Number(value.count);
  if (typeof item !== 'string' || !ItemRegistry.has(item)) return null;
  if (!Number.isFinite(count) || count <= 0) return null;
  return { item, count: Math.min(ItemRegistry.maxStack(item), Math.floor(count)) };
}

/** Clamp a saved number into a sane range. */
function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(min, Math.min(max, number));
}

/** Round to milliseconds so serialised documents stay byte-stable. */
function round(value) {
  return Math.round((Number(value) || 0) * 1000) / 1000;
}
