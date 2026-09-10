/**
 * FurnaceUI.js — the smelting screen.
 *
 * Three slots, a flame gauge and a progress arrow, driven by the `Smelting`
 * system. The furnace's contents live on the world position, not in the UI, so
 * closing the screen leaves the ore smelting and walking back shows the result.
 *
 * Slots:
 *   0 input   — anything a smelting recipe accepts
 *   1 fuel    — only real fuels; the container refuses everything else
 *   2 output  — read only; clicking it takes what is there
 */

import { ItemRegistry } from '../world/Items.js';
import { RecipeBook } from '../data/RecipeBook.js';
import { SlotView } from './SlotView.js';

export class FurnaceUI {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {import('../render/TextureAtlas.js').TextureAtlas} atlas
   * @param {import('../systems/AudioSystem.js').AudioSystem} audio
   * @param {import('../systems/Smelting.js').Smelting} smelting
   */
  constructor(bus, atlas, audio, smelting) {
    this.bus = bus;
    this.atlas = atlas;
    this.audio = audio;
    this.smelting = smelting;

    this.root = document.getElementById('screen-furnace');
    this.slotsEl = document.getElementById('furnace-slots');
    this.flameEl = document.getElementById('furnace-flame');
    this.arrowEl = document.getElementById('furnace-arrow');
    this.statusEl = document.getElementById('furnace-status');

    /** @type {import('../player/Player.js').Player|null} */
    this.player = null;
    /** Current furnace position, or null. */
    this.position = null;
    /** Adapter that exposes the furnace's three slots like a container. */
    this.container = null;

    this.slots = new SlotView({
      atlas,
      audio,
      onChange: () => {
        this.audio.play('click');
        this.refresh();
        this.bus.emit('hotbarRefresh');
      },
      onReject: (reason) => this.bus.emit('craftFailed', { reason })
    });

    this._buildSlots();
    document.getElementById('btn-furnace-close').addEventListener('click', () => {
      this.bus.emit('requestCloseFurnace');
    });
    this.bus.on('smeltingChanged', ({ x, y, z }) => {
      if (!this.isOpen || !this.position) return;
      if (this.position.x === x && this.position.y === y && this.position.z === z) this.refresh();
    });
  }

  /** Create the three labelled slot rows once. */
  _buildSlots() {
    const roles = ['input', 'fuel', 'output'];
    const labels = ['Ingredient', 'Fuel', 'Result'];
    for (let i = 0; i < roles.length; i++) {
      const row = document.createElement('div');
      row.className = 'furnace-row';
      const label = document.createElement('span');
      label.className = 'furnace-label';
      label.textContent = labels[i];
      const element = document.createElement('div');
      element.className = `slot furnace-slot furnace-${roles[i]}`;
      element.dataset.role = roles[i];
      element.innerHTML = '<span class="slot-count"></span>';
      row.appendChild(label);
      row.appendChild(element);
      this.slotsEl.appendChild(row);
    }
    /** @type {HTMLElement[]} */
    this.furnaceSlotElements = [...this.slotsEl.querySelectorAll('.slot')];
  }

  /**
   * Show the furnace at a position.
   * @param {import('../player/Player.js').Player} player
   * @param {number} x
   * @param {number} y
   * @param {number} z
   */
  open(player, x, y, z) {
    this.player = player;
    this.position = { x, y, z };
    this.container = this._containerFor(x, y, z);
    this.slots.held = null;
    this.slots.unbindAll();
    const roles = ['input', 'fuel', 'output'];
    for (let i = 0; i < this.furnaceSlotElements.length; i++) {
      this.slots.bind(this.furnaceSlotElements[i], this.container, i, roles[i]);
    }
    this.root.classList.remove('is-hidden');
    this.refresh();
    this.slots.focusFirst();
  }

  /** Close the screen, returning whatever the cursor was carrying. */
  close() {
    if (this.player) {
      const leftover = this.slots.returnHeld(this.player.inventory);
      if (leftover && this.onOverflow) this.onOverflow(leftover);
    }
    this.slots.held = null;
    this.root.classList.add('is-hidden');
    this.player = null;
    this.position = null;
    this.container = null;
  }

  /** Called when a returned stack does not fit in the inventory. */
  setOverflowHandler(fn) {
    this.onOverflow = fn;
  }

  /** True while the screen is on show. */
  get isOpen() {
    return !this.root.classList.contains('is-hidden');
  }

  /** Adapter presenting the furnace's slots as a small container. */
  _containerFor(x, y, z) {
    const smelting = this.smelting;
    const bus = this.bus;
    const key = ['input', 'fuel', 'output'];
    return {
      size: 3,
      get(index) {
        const station = smelting.get(x, y, z);
        if (!station) return null;
        return station[key[index]] || null;
      },
      set(index, stack) {
        const station = smelting.ensure(x, y, z);
        station[key[index]] = stack && stack.count > 0 ? { item: stack.item, count: stack.count } : null;
        bus.emit('smeltingChanged', { x, y, z });
      },
      /** Fuel slot takes only fuel; the output slot is read-only. */
      accepts(index, stack) {
        if (index === 2) return false;
        if (index === 1) return RecipeBook.current().fuelValue(stack.item) > 0;
        return true;
      },
      rejectReason(index, stack) {
        if (index === 2) return 'The result slot is take-only.';
        return `${ItemRegistry.name(stack.item)} is not a fuel.`;
      }
    };
  }

  /** Redraw slots, gauges and status text. */
  refresh() {
    if (!this.player || !this.position) return;
    const { x, y, z } = this.position;
    this.slots.refresh();

    const station = this.smelting.get(x, y, z);
    const heat = this.smelting.heatOf(station);
    const progress = this.smelting.progressOf(station);
    this.flameEl.style.height = `${Math.round(heat * 100)}%`;
    this.flameEl.classList.toggle('is-lit', heat > 0);
    this.arrowEl.style.setProperty('--progress', `${Math.round(progress * 100)}%`);

    const book = RecipeBook.current();
    if (!station || !station.input) {
      this.statusEl.textContent = 'Put something smeltable in the top slot and fuel underneath.';
    } else if (book.fuelValue(station.input.item) > 0 && !book.smeltingFor(station.input.item)) {
      this.statusEl.textContent = `${ItemRegistry.name(station.input.item)} is a fuel, not a smeltable item.`;
    } else if (!book.smeltingFor(station.input.item)) {
      this.statusEl.textContent = `${ItemRegistry.name(station.input.item)} cannot be smelted.`;
    } else if (!station.fuel && !station.lit) {
      this.statusEl.textContent = 'Out of fuel.';
    } else {
      const recipe = book.smeltingFor(station.input.item);
      this.statusEl.textContent = `Smelting ${ItemRegistry.name(station.input.item)} into `
        + `${ItemRegistry.name(recipe.output.item)} — ${Math.round(progress * 100)}%`;
    }
  }
}
