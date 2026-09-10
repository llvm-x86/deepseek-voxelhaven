/**
 * EventBus.js — a tiny synchronous publish/subscribe helper.
 *
 * Used to keep systems decoupled: the world does not know about the HUD, it
 * just emits 'blockChanged' and whoever cares listens.
 */

export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this.listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} an unsubscribe function
   */
  on(event, handler) {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  /** Subscribe for a single invocation. */
  once(event, handler) {
    const off = this.on(event, (...args) => {
      off();
      handler(...args);
    });
    return off;
  }

  /** Remove a previously registered handler. */
  off(event, handler) {
    const set = this.listeners.get(event);
    if (set) set.delete(handler);
  }

  /**
   * Emit an event. Handler exceptions are contained so one bad listener cannot
   * break the rest of the frame.
   * @param {string} event
   * @param {...any} args
   */
  emit(event, ...args) {
    const set = this.listeners.get(event);
    if (!set || set.size === 0) return;
    // Copy so handlers may unsubscribe during dispatch.
    for (const handler of Array.from(set)) {
      try {
        handler(...args);
      } catch (err) {
        console.error(`[EventBus] listener for "${event}" threw:`, err);
      }
    }
  }

  /** Remove every listener, optionally for one event only. */
  clear(event) {
    if (event) this.listeners.delete(event);
    else this.listeners.clear();
  }
}

/** Shared application-wide bus. */
export const bus = new EventBus();
