/**
 * InventoryUI.js — the inventory / crafting-table screen and the recipe browser.
 *
 * One screen serves both stations, exactly the way the game does it: the
 * inventory shows a 2x2 grid, right-clicking a placed crafting table shows the
 * same layout with a 3x3 grid, and the player's 27 backpack slots and 9 hotbar
 * slots are always visible underneath.
 *
 * The result slot is a preview, not a container: it recomputes the match every
 * time the grid changes, clicking it performs one craft, and shift-clicking it
 * crafts as many as the ingredients allow.
 *
 * Closing the screen always returns the grid contents to the inventory. If the
 * inventory cannot take everything, the remainder is dropped into the world
 * through the overflow handler rather than deleted.
 */

import { HOTBAR_SIZE, INVENTORY_SIZE } from '../player/Inventory.js';
import { CraftGrid, CRAFT_GRID_INVENTORY, CRAFT_GRID_TABLE } from '../player/CraftGrid.js';
import { ItemRegistry } from '../world/Items.js';
import { Crafting } from '../systems/Crafting.js';
import { RecipeBook } from '../data/RecipeBook.js';
import { SlotView, describe } from './SlotView.js';

/** How many ingredients a browser entry lists before it says "…". */
const BROWSER_INGREDIENT_LIMIT = 4;

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
    this.titleEl = document.getElementById('inventory-title');
    this.gridEl = document.getElementById('inventory-grid');
    this.hotbarEl = document.getElementById('inventory-hotbar');
    this.craftGridEl = document.getElementById('craft-grid');
    this.craftResultEl = document.getElementById('craft-result');
    this.craftEl = document.getElementById('craft-list');
    this.hintEl = document.getElementById('inventory-hint');

    /** The station currently open: 'inventory' or 'crafting_table'. */
    this.station = 'inventory';
    /** @type {import('../player/CraftGrid.js').CraftGrid} */
    this.grid = new CraftGrid(CRAFT_GRID_INVENTORY);
    /** Result of the current grid match, or null. */
    this.match = null;
    /** @type {import('../player/Player.js').Player|null} */
    this.player = null;
    /** Called with {item, count} when a returned stack does not fit. */
    this.onOverflow = null;

    this.slots = new SlotView({
      atlas,
      audio,
      onChange: () => this.refresh(),
      onReject: (reason) => this.bus.emit('craftFailed', { reason })
    });

    this._buildInventorySlots();
    this._buildCraftSlots();
    this._buildResultSlot();

    document.getElementById('btn-inventory-close').addEventListener('click', () => {
      this.bus.emit('requestCloseInventory');
    });
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /** Build the 27 backpack slots and the 9 hotbar slots once. */
  _buildInventorySlots() {
    const backpack = document.createDocumentFragment();
    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) {
      backpack.appendChild(this._slotElement('inventory'));
    }
    this.gridEl.appendChild(backpack);

    const hotbar = document.createDocumentFragment();
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      hotbar.appendChild(this._slotElement('hotbar'));
    }
    this.hotbarEl.appendChild(hotbar);
  }

  /** A bare slot element; binding happens in open(). */
  _slotElement(role) {
    const element = document.createElement('div');
    element.className = 'slot';
    element.dataset.role = role;
    element.innerHTML = '<span class="slot-count"></span>';
    return element;
  }

  /** Create the grid slots for the largest grid, rebinding for smaller ones. */
  _buildCraftSlots() {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < CRAFT_GRID_TABLE * CRAFT_GRID_TABLE; i++) {
      fragment.appendChild(this._slotElement('craft'));
    }
    this.craftGridEl.appendChild(fragment);
    /** @type {HTMLElement[]} */
    this.craftSlotElements = [...this.craftGridEl.children];
  }

  /** The result slot is a preview plus a button, not a container. */
  _buildResultSlot() {
    const element = document.createElement('div');
    element.className = 'slot slot-result';
    element.dataset.role = 'result';
    element.tabIndex = 0;
    element.innerHTML = '<span class="slot-count"></span>';
    element.addEventListener('click', (event) => {
      event.preventDefault();
      this.takeResult(event.shiftKey === true);
    });
    element.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      this.takeResult(event.shiftKey === true);
    });
    this.craftResultEl.appendChild(element);
    this.resultElement = element;
  }

  // -------------------------------------------------------------------------
  // Opening and closing
  // -------------------------------------------------------------------------

  /**
   * Show the screen.
   * @param {import('../player/Player.js').Player} player
   * @param {{station?:'inventory'|'crafting_table'}} [options]
   */
  open(player, options = {}) {
    const station = options.station === 'crafting_table' ? 'crafting_table' : 'inventory';
    this.player = player;
    this.slots.held = null;
    this.station = station;
    this.grid.resize(station === 'crafting_table' ? CRAFT_GRID_TABLE : CRAFT_GRID_INVENTORY);
    this._bind(station);
    this.root.dataset.station = station;
    this.root.classList.remove('is-hidden');
    this.titleEl.textContent = station === 'crafting_table' ? 'Crafting Table' : 'Inventory';
    if (this.hintEl) {
      this.hintEl.textContent = station === 'crafting_table'
        ? '3×3 grid: click a slot to pick a stack up, shift-click to split, arrows and Enter to work without a mouse.'
        : '2×2 grid: click a slot to pick a stack up, shift-click to split, arrows and Enter to work without a mouse.';
    }
    this.refresh();
    this.slots.focusFirst();
  }

  /** Bind the slot views for the active grid size. */
  _bind() {
    this.slots.unbindAll();
    const inventory = this.player.inventory;

    for (let i = HOTBAR_SIZE; i < INVENTORY_SIZE; i++) {
      const element = this.gridEl.children[i - HOTBAR_SIZE];
      this.slots.bind(element, inventory, i, 'inventory');
    }
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const element = this.hotbarEl.children[i];
      this.slots.bind(element, inventory, i, 'hotbar');
    }
    for (let i = 0; i < this.craftSlotElements.length; i++) {
      const element = this.craftSlotElements[i];
      const active = i < this.grid.size;
      element.classList.toggle('is-hidden', !active);
      if (active) this.slots.bind(element, this.grid, i, 'craft');
    }
  }

  /**
   * Hide the screen, returning everything the player was carrying or had laid
   * out in the grid. Anything that will not fit is handed to the overflow
   * handler so it can be dropped into the world instead of being deleted.
   * @returns {{dropped:Array<{item:string,count:number}>}}
   */
  close() {
    const dropped = [];
    if (this.player) {
      const heldLeftover = this.slots.returnHeld(this.player.inventory);
      if (heldLeftover) {
        dropped.push(heldLeftover);
        if (this.onOverflow) this.onOverflow(heldLeftover);
      }
      for (const stack of this.grid.returnAllTo(this.player.inventory)) {
        dropped.push(stack);
        if (this.onOverflow) this.onOverflow(stack);
      }
    }
    this.slots.held = null;
    this.root.classList.add('is-hidden');
    this.root.dataset.station = '';
    this.match = null;
    this.player = null;
    return { dropped };
  }

  /** True while the screen is on show. */
  get isOpen() {
    return !this.root.classList.contains('is-hidden');
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  /** Redraw every slot, the result preview and the recipe browser. */
  refresh() {
    if (!this.player) return;
    const inventory = this.player.inventory;

    this.slots.refresh();
    for (const entry of this.slots.entries) {
      if (entry.role === 'hotbar' || entry.role === 'inventory') {
        entry.element.classList.toggle('is-selected', entry.index === this.player.selectedSlot);
      }
    }
    this._refreshResult();
    this.refreshCrafting();
    void inventory;
  }

  /** Recompute the grid match. Called on every grid mutation. */
  _refreshResult() {
    this.match = Crafting.match(this.grid.toArray(), this.grid.dimension);
    const element = this.resultElement;
    if (this.match) {
      const { output } = this.match;
      element.style.backgroundImage = `url("${this.atlas.iconDataURL(ItemRegistry.tile(output.item), 4)}")`;
      element.querySelector('.slot-count').textContent = output.count > 1 ? String(output.count) : '';
      element.title = `${describe(output)} — click to craft`;
      element.classList.add('has-result');
    } else {
      element.style.backgroundImage = '';
      element.querySelector('.slot-count').textContent = '';
      element.title = 'No recipe matches this arrangement';
      element.classList.remove('has-result');
    }
  }

  /**
   * Rebuild the recipe browser: every recipe in the book, cheap enough to
   * browse, with the ingredients the player is missing left visible so they
   * know what to go and find.
   */
  refreshCrafting() {
    if (!this.player) return;
    const inventory = this.player.inventory;
    const book = RecipeBook.current();
    const fragment = document.createDocumentFragment();

    for (const { recipe, crafts } of Crafting.available(inventory, book)) {
      const affordable = crafts > 0;
      const fits = recipe.station !== 'crafting_table' || this.grid.dimension === 3;
      const entry = document.createElement('div');
      entry.className = `craft-entry ${affordable && fits ? 'can-craft' : 'cannot-craft'}`;
      entry.dataset.recipe = recipe.id;

      const icon = document.createElement('div');
      icon.className = 'craft-icon';
      icon.style.backgroundImage = `url("${this.atlas.iconDataURL(ItemRegistry.tile(recipe.output.item), 3)}")`;

      const info = document.createElement('div');
      info.className = 'craft-info';
      info.innerHTML = '<div class="craft-name"></div><div class="craft-recipe"></div><div class="craft-hint"></div>';
      info.querySelector('.craft-name').textContent = `${recipe.name} ×${recipe.output.count}`;
      info.querySelector('.craft-recipe').textContent = this._ingredientSummary(recipe, book);
      info.querySelector('.craft-hint').textContent = !fits
        ? 'Needs a crafting table (3×3)'
        : affordable ? 'Click to lay the ingredients out in the grid' : 'Missing ingredients';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-small';
      button.textContent = 'Lay out';
      button.disabled = !affordable || !fits;
      button.addEventListener('click', () => this.fillFromInventory(recipe));

      entry.appendChild(icon);
      entry.appendChild(info);
      entry.appendChild(button);
      fragment.appendChild(entry);
    }

    this.craftEl.replaceChildren(fragment);
  }

  /** Human readable ingredient list for a recipe. */
  _ingredientSummary(recipe, book) {
    /** @type {Map<string, number>} */
    const counts = new Map();
    const add = (name, count) => {
      const label = book.isTag(name)
        ? `Any ${book.tagMembers(name).map((key) => ItemRegistry.name(key)).join('/')}`
        : ItemRegistry.name(name);
      counts.set(label, (counts.get(label) || 0) + count);
    };
    if (recipe.type === 'shaped') {
      /** @type {Map<string, number>} */
      const perSymbol = new Map();
      for (const row of recipe.pattern) {
        for (const symbol of row) {
          if (symbol === ' ') continue;
          perSymbol.set(symbol, (perSymbol.get(symbol) || 0) + 1);
        }
      }
      for (const [symbol, occurrences] of perSymbol) {
        for (const name of recipe.key[symbol]) add(name, occurrences);
      }
    } else {
      for (const list of recipe.ingredients) for (const name of list) add(name, 1);
    }
    const parts = [...counts.entries()].map(([label, count]) => `${count}× ${label}`);
    if (parts.length <= BROWSER_INGREDIENT_LIMIT) return parts.join(' + ');
    return `${parts.slice(0, BROWSER_INGREDIENT_LIMIT).join(' + ')} +${parts.length - BROWSER_INGREDIENT_LIMIT} more`;
  }

  // -------------------------------------------------------------------------
  // Crafting
  // -------------------------------------------------------------------------

  /**
   * Take the result: one craft, or as many as possible when shift is held.
   * @param {boolean} many
   */
  takeResult(many = false) {
    if (!this.player || !this.match) return;
    // The engine operates on the live slot array, so there is exactly one copy
    // of the grid state and no replaying of consumption afterwards.
    const grid = this.grid.slots;
    const size = this.grid.dimension;

    if (many) {
      let crafted = 0;
      let lastRecipe = null;
      // Each craft re-matches the grid, because consuming an item can empty a
      // slot and change what the grid satisfies.
      for (let i = 0; i < 64; i++) {
        const result = Crafting.craftFromGrid(grid, size, this.player.inventory);
        if (!result.ok) break;
        lastRecipe = result.recipe;
        crafted++;
      }
      if (crafted > 0) {
        this.audio.play('craft');
        this.bus.emit('crafted', { recipe: lastRecipe, count: crafted });
        this.bus.emit('hotbarRefresh');
      }
      this.refresh();
      return;
    }

    const result = Crafting.craftFromGrid(grid, size, this.player.inventory);
    if (!result.ok) {
      this.bus.emit('craftFailed', { reason: result.reason });
      this.refresh();
      return;
    }
    this.audio.play('craft');
    this.bus.emit('crafted', { recipe: result.recipe, output: result.output });
    this.bus.emit('hotbarRefresh');
    this.refresh();
  }

  /**
   * Lay a recipe out in the grid, pulling the ingredients out of the
   * inventory. Anything already in the grid goes back to the inventory first.
   */
  fillFromInventory(recipe) {
    if (!this.player) return false;
    const inventory = this.player.inventory;
    const book = RecipeBook.current();
    if (recipe.station === 'crafting_table' && this.grid.dimension < 3) {
      this.bus.emit('craftFailed', { reason: 'That recipe needs a crafting table.' });
      return false;
    }
    if (!Crafting.canCraft(inventory, recipe, book)) {
      this.bus.emit('craftFailed', { reason: `Not enough materials for ${recipe.name}.` });
      return false;
    }

    for (const stack of this.grid.returnAllTo(inventory)) {
      if (this.onOverflow) this.onOverflow(stack);
    }

    const take = (names, count) => {
      // Prefer a concrete item the player actually has; fall back to the first
      // member of a tag so the layout is still deterministic.
      const candidates = names.flatMap((name) => (book.isTag(name) ? book.tagMembers(name) : [name]));
      for (const item of candidates) {
        if (inventory.countOf(item) >= count) {
          inventory.removeItem(item, count);
          return { item, count };
        }
      }
      return null;
    };

    let placed = 0;
    if (recipe.type === 'shaped') {
      for (let y = 0; y < recipe.height; y++) {
        for (let x = 0; x < recipe.width; x++) {
          const symbol = recipe.pattern[y][x];
          if (symbol === ' ') continue;
          const perSlot = Number.isFinite(recipe.counts && recipe.counts[symbol]) ? recipe.counts[symbol] : 1;
          const stack = take(recipe.key[symbol], perSlot);
          if (!stack) continue;
          this.grid.set(y * this.grid.dimension + x, stack);
          placed++;
        }
      }
    } else {
      for (let i = 0; i < recipe.ingredients.length; i++) {
        const perSlot = Number.isFinite(recipe.counts && recipe.counts[String(i)]) ? recipe.counts[String(i)] : 1;
        const stack = take(recipe.ingredients[i], perSlot);
        if (!stack) continue;
        this.grid.set(i, stack);
        placed++;
      }
    }
    this.audio.play('click');
    this.refresh();
    return placed > 0;
  }

  /**
   * Flat craft used by the automation API and by anything that wants to craft
   * straight out of the inventory without touching the grid.
   */
  craft(recipe) {
    if (!this.player) return { ok: false, reason: 'No player.' };
    const result = Crafting.craft(this.player.inventory, recipe);
    if (result.ok) {
      this.audio.play('craft');
      this.bus.emit('crafted', { recipe, output: result.output });
      this.refresh();
      this.bus.emit('hotbarRefresh');
    } else {
      this.bus.emit('craftFailed', { recipe, reason: result.reason });
    }
    return result;
  }
}
