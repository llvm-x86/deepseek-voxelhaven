/**
 * GameState.js — the finite states the game can be in.
 *
 * Kept in its own module so both Game and any UI code can reference the states
 * without importing the (much heavier) Game module and creating a cycle.
 */

export const GameState = Object.freeze({
  /** Starting up, before the main menu is usable. */
  BOOT: 'boot',
  /** Main menu, world list, creation form. */
  MENU: 'menu',
  /** A world is being generated or restored; the loading screen is up. */
  LOADING: 'loading',
  /** Normal gameplay. */
  PLAYING: 'playing',
  /** Pause menu. */
  PAUSED: 'paused',
  /** Settings screen (opened from pause). */
  SETTINGS: 'settings',
  /** Inventory and crafting screen. */
  INVENTORY: 'inventory',
  /** Death screen. */
  DEAD: 'dead',
  /** An unrecoverable error is being displayed. */
  ERROR: 'error'
});

/** True for states where the world should keep streaming but not simulate. */
export function isWorldIdleState(state) {
  return state === GameState.PAUSED
    || state === GameState.SETTINGS
    || state === GameState.INVENTORY
    || state === GameState.DEAD;
}
