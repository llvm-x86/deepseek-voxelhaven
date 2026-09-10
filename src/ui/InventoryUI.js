/**
 * InventoryUI.js — the inventory screen and the craft panel.
 *
 * Uses a "held stack" interaction model: clicking a slot picks the stack up,
 * clicking another slot puts it down (merging when the items match), and
 * shift-clicking splits a stack in half. This is easy to explain, works with
 * one mouse button, and needs no drag-and-drop plumbing.
 */

import { INVENTORY_SIZE, HOTBAR_SIZE } from '../player/Inventory.js';
import { ItemRegistry } from '../world/Items.js';
import { Crafting } from '../systems/Crafting.js';

export class InventoryUI {
  /**
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {import('../render/TextureAtlas.js').TextureAtlas} atlas
   * @param {import('../systems/AudioSystem.js').AudioSystem} audio
   */
  constructor(bus, atlas, audio) {
    this.bus = bus;
    this.atlas = atlas;
    this.audio = audio;

    this.root = document.getElementById('screen-inventory');
    this.gridEl = document.getElementById('inventory-grid');
    this.hotbarEl = document.getElementById('inventory-hotbar');
    this.craftEl = document.getElementById('craft-list');

    /** Stack currently held by the cursor, or null. */
    this.held = null;
    /** @type {import('../player/Player.js').Player|null} */
    this.player = null;

    /** @type {HTMLElement[]} */
    this.slotElements = [];
    this._buildSlots();

    document.getElementById('btn-inventory-close').addEventListener('click', () => {
      this.bus.emit('requestCloseInventory');
    });
  }

  /** Build the 27 backpack slots and the 9 hotbar slots once. */
  _buildSlots() {
    const backpack = document.createDocumentFragment();
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) {
      backpack.appendChild(this._createSlotElement(i));
    }
    this.gridEl.appendChild(backpack);

    const hotbar = document.createDocumentFragment();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      hotbar.appendChild(this._createSlotElement(i));
    }
    this.hotbarEl.appendChild(hotbar);
  }

  /** Create one clickable slot element. */
  _createSlotElement(index) {
    const element = document.createElement('div');
    element.className = 'slot';
    element.dataset.slot = String(index);
    element.innerHTML = '<span class="slot-count"></span>';
    element.addEventListener('click', (event) => this.onSlotClick(index, event));
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      this.onSlotClick(index, { shiftKey: true });
    });
    this.slotElements.push(element);
    return element;
  }

  /**
   * Attach to a player and show the screen.
   * @param {import('../player/Player.js').Player} player
   */
  open(player) {
    this.player = player;
    this.held = null;
    this.root.classList.remove('is-hidden');
    this.refresh();
  }

  /** Hide the screen and return any held stack to the inventory. */
  close() {
    if (this.held && this.player) {
      // Never destroy items: put the held stack back before closing.
      const leftover = this.player.inventory.add(this.held.item, this.held.count);
      if (leftover > 0) {
        this.bus.emit('inventoryFull', { item: this.held.item, count: leftover });
      }
      this.held = null;
    }
    this.root.classList.add('is-hidden');
    this.player = null;
  }

  /** True while the screen is on show. */
  get isOpen() {
    return !this.root.classList.contains('is-hidden');
  }

  /** Redraw every slot and the craft list. */
  refresh() {
    if (!this.player) return;
    const inventory = this.player.inventory;

    for (const element of this.slotElements) {
      const index = Number(element.dataset.slot);
      const stack = inventory.get(index);
      const countEl = element.querySelector('.slot-count');
      if (stack) {
        element.style.backgroundImage = `url("${this.atlas.iconDataURL(ItemRegistry.tile(stack.item), 4)}")`;
        countEl.textContent = stack.count > 1 ? String(stack.count) : '';
        element.title = `${ItemRegistry.name(stack.item)} ×${stack.count}`;
      } else {
        element.style.backgroundImage = '';
        countEl.textContent = '';
        element.title = '';
      }
      element.classList.toggle('is-selected', index === this.player.selectedSlot);
    }
    this.refreshCrafting();
  }

  /** Rebuild the list of recipes and their affordability. */
  refreshCrafting() {
    if (!this.player) return;
    const inventory = this.player.inventory;
    const fragment = document.createDocumentFragment();

    for (const { recipe, crafts } of Crafting.available(inventory)) {
      const entry = document.createElement('div');
      entry.className = `craft-entry ${crafts > 0 ? 'can-craft' : 'cannot-craft'}`;

      const icon = document.createElement('div');
      icon.className = 'craft-icon';
      icon.style.backgroundImage = `url("${this.atlas.iconDataURL(ItemRegistry.tile(recipe.output.item), 3)}")`;

      const info = document.createElement('div');
      info.className = 'craft-info';
      const inputText = recipe.inputs
        .map((input) => `${input.count}× ${ItemRegistry.name(input.item)}`)
        .join(' + ');
      info.innerHTML = `<div class="craft-name"></div><div class="craft-recipe"></div><div class="craft-hint"></div>`;
      info.querySelector('.craft-name').textContent = `${recipe.name} ×${recipe.output.count}`;
      info.querySelector('.craft-recipe').textContent = inputText;
      info.querySelector('.craft-hint').textContent = recipe.hint || '';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-small';
      button.textContent = crafts > 0 ? `Craft${crafts > 1 ? ` (${crafts})` : ''}` : 'Craft';
      button.disabled = crafts <= 0;
      button.addEventListener('click', () => this.craft(recipe));

      entry.appendChild(icon);
      entry.appendChild(info);
      entry.appendChild(button);
      fragment.appendChild(entry);
    }

    this.craftEl.replaceChildren(fragment);
  }

  /** Attempt a craft and report the result. */
  craft(recipe) {
    if (!this.player) return;
    const result = Crafting.craft(this.player.inventory, recipe);
    if (result.ok) {
      this.audio.play('craft');
      this.bus.emit('crafted', { recipe });
      this.refresh();
      this.bus.emit('hotbarRefresh');
    } else {
      this.bus.emit('craftFailed', { recipe, reason: result.reason });
    }
  }

  /**
   * Click handler implementing the held-stack model.
   * @param {number} index
   * @param {{shiftKey?:boolean}} event
   */
  onSlotClick(index, event) {
    if (!this.player) return;
    const inventory = this.player.inventory;

    if (event && event.shiftKey) {
      if (this.held) {
        // Drop one item from the held stack into this slot.
        const target = inventory.get(index);
        if (!target) {
          inventory.set(index, { item: this.held.item, count: 1 });
          this.held.count -= 1;
        } else if (target.item === this.held.item) {
          const max = ItemRegistry.maxStack(target.item);
          if (target.count < max) {
            target.count += 1;
            this.held.count -= 1;
          }
        }
        if (this.held.count <= 0) this.held = null;
      } else {
        // Split the stack in this slot in half into the held stack.
        const stack = inventory.get(index);
        if (stack) {
          const half = Math.floor(stack.count / 2);
          if (half > 0) {
            this.held = { item: stack.item, count: half };
            stack.count -= half;
            if (stack.count <= 0) inventory.set(index, null);
          } else {
            this.held = { item: stack.item, count: stack.count };
            inventory.set(index, null);
          }
        }
      }
      this.audio.play('click');
      this.refresh();
      this.bus.emit('hotbarRefresh');
      return;
    }

    if (!this.held) {
      const stack = inventory.get(index);
      if (!stack) return;
      this.held = { item: stack.item, count: stack.count };
      inventory.set(index, null);
    } else {
      const target = inventory.get(index);
      if (!target) {
        inventory.set(index, this.held);
        this.held = null;
      } else if (target.item === this.held.item) {
        const max = ItemRegistry.maxStack(target.item);
        const room = max - target.count;
        const moved = Math.min(room, this.held.count);
        target.count += moved;
        this.held.count -= moved;
        if (this.held.count <= 0) this.held = null;
      } else {
        // Swap.
        inventory.set(index, this.held);
        this.held = target;
      }
    }
    this.audio.play('click');
    this.refresh();
    this.bus.emit('hotbarRefresh');
  }
}
