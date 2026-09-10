/**
 * Input.js — keyboard, mouse and pointer-lock handling.
 *
 * Owns all browser event wiring so no other module has to. Exposes a small,
 * frame-stable query API:
 *   - isDown(action)     held state
 *   - wasPressed(action) true only on the frame the action started
 *   - mouseDelta         accumulated look delta, consumed once per frame
 *
 * The Input instance can be enabled/disabled (menus disable movement input
 * while still receiving Escape presses).
 */

/** Logical actions and their key bindings. */
const KEY_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['ControlLeft', 'ControlRight', 'KeyC'],
  inventory: ['KeyE', 'Tab'],
  drop: ['KeyQ'],
  pause: ['Escape'],
  debug: ['F3', 'Backquote'],
  mute: ['KeyM'],
  craft: ['KeyR'],
  hotbar1: ['Digit1'], hotbar2: ['Digit2'], hotbar3: ['Digit3'],
  hotbar4: ['Digit4'], hotbar5: ['Digit5'], hotbar6: ['Digit6'],
  hotbar7: ['Digit7'], hotbar8: ['Digit8'], hotbar9: ['Digit9'],
  screenshot: ['F2']
};

/** Reverse map from KeyboardEvent.code to action. */
const CODE_TO_ACTION = new Map();
for (const [action, codes] of Object.entries(KEY_BINDINGS)) {
  for (const code of codes) CODE_TO_ACTION.set(code, action);
}

/** Mouse button -> action. */
const MOUSE_BINDINGS = { 0: 'break', 2: 'place', 1: 'pick' };

export class Input {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {import('../core/EventBus.js').EventBus} bus
   */
  constructor(canvas, bus) {
    this.canvas = canvas;
    this.bus = bus;

    /** @type {Set<string>} actions currently held */
    this.down = new Set();
    /** @type {Set<string>} actions that started this frame */
    this.pressed = new Set();
    /** @type {Set<string>} actions that ended this frame */
    this.released = new Set();

    /** Accumulated look delta in pixels; reset by consumeMouseDelta(). */
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    /** Accumulated wheel steps this frame. */
    this.wheelDelta = 0;

    /** True when the pointer is locked, i.e. the game has mouse control. */
    this.pointerLocked = false;
    /** When false, movement and mouse look are ignored (menus are open). */
    this.enabled = false;
    /** When true the browser default for a key is always prevented. */
    this.sensitivity = 0.0022;

    this._boundHandlers = [];
    this._attach();
  }

  /** Wire up DOM listeners. */
  _attach() {
    const on = (target, type, handler, options) => {
      target.addEventListener(type, handler, options);
      this._boundHandlers.push([target, type, handler, options]);
    };

    on(window, 'keydown', (event) => {
      // Never swallow browser shortcuts the user still needs.
      if (event.ctrlKey && event.code !== 'ControlLeft' && event.code !== 'ControlRight') return;
      const action = CODE_TO_ACTION.get(event.code);
      if (!action) return;
      // F3 and the function keys should not scroll or open dev tools menus.
      if (event.code === 'F3' || event.code === 'Tab' || event.code === 'Space') event.preventDefault();
      if (event.repeat) return;
      if (!this.down.has(action)) this.pressed.add(action);
      this.down.add(action);
      this.bus.emit('keyAction', action, event);
    });

    on(window, 'keyup', (event) => {
      const action = CODE_TO_ACTION.get(event.code);
      if (!action) return;
      this.down.delete(action);
      this.released.add(action);
    });

    on(this.canvas, 'mousedown', (event) => {
      const action = MOUSE_BINDINGS[event.button];
      if (!action) return;
      event.preventDefault();
      if (this.pointerLocked && this.enabled) {
        if (!this.down.has(action)) this.pressed.add(action);
        this.down.add(action);
      }
      this.bus.emit('mouseAction', action, event);
    });

    on(window, 'mouseup', (event) => {
      const action = MOUSE_BINDINGS[event.button];
      if (!action) return;
      this.down.delete(action);
      this.released.add(action);
    });

    on(this.canvas, 'contextmenu', (event) => event.preventDefault());

    on(document, 'mousemove', (event) => {
      if (!this.pointerLocked || !this.enabled) return;
      this.mouseDeltaX += event.movementX || 0;
      this.mouseDeltaY += event.movementY || 0;
    });

    on(this.canvas, 'wheel', (event) => {
      if (!this.enabled) return;
      event.preventDefault();
      // Normalise the wildly different deltaMode values browsers report.
      const scale = event.deltaMode === 1 ? 1 : event.deltaMode === 2 ? 16 : 0.02;
      this.wheelDelta += Math.sign(event.deltaY) * Math.max(1, Math.abs(event.deltaY * scale));
      this.wheelDelta = Math.max(-10, Math.min(10, this.wheelDelta));
    }, { passive: false });

    on(document, 'pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      if (locked === this.pointerLocked) return;
      this.pointerLocked = locked;
      if (!locked) {
        // Dropping the lock must not leave keys stuck down.
        this.down.clear();
        this.mouseDeltaX = 0;
        this.mouseDeltaY = 0;
      }
      this.bus.emit('pointerLockChanged', locked);
    });

    on(document, 'pointerlockerror', () => {
      console.warn('[Input] pointer lock request was rejected by the browser');
      this.bus.emit('pointerLockError');
    });

    // Losing focus must release every held key, otherwise the player keeps
    // walking after switching tabs.
    on(window, 'blur', () => {
      this.down.clear();
      this.mouseDeltaX = 0;
      this.mouseDeltaY = 0;
    });
  }

  /** Request pointer lock; resolves silently when the browser refuses. */
  requestPointerLock() {
    if (this.pointerLocked) return;
    const promise = this.canvas.requestPointerLock();
    // Chrome returns a promise; Firefox returns undefined.
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
  }

  /** Release pointer lock. */
  exitPointerLock() {
    if (document.pointerLockElement === this.canvas) document.exitPointerLock();
  }

  /** True while the action is held. */
  isDown(action) {
    return this.down.has(action);
  }

  /** True only on the frame the action started. */
  wasPressed(action) {
    return this.pressed.has(action);
  }

  /** True only on the frame the action ended. */
  wasReleased(action) {
    return this.released.has(action);
  }

  /**
   * Read and clear the accumulated mouse look delta.
   * @returns {{yaw:number, pitch:number}} radians to apply
   */
  consumeMouseDelta() {
    const yaw = -this.mouseDeltaX * this.sensitivity;
    const pitch = -this.mouseDeltaY * this.sensitivity;
    this.mouseDeltaX = 0;
    this.mouseDeltaY = 0;
    return { yaw, pitch };
  }

  /** Read and clear the accumulated wheel steps. */
  consumeWheel() {
    const value = this.wheelDelta;
    this.wheelDelta = 0;
    return value;
  }

  /** Clear per-frame edge state. Call at the very end of each frame. */
  endFrame() {
    this.pressed.clear();
    this.released.clear();
  }

  /** Remove every listener (used when tearing down a session). */
  dispose() {
    for (const [target, type, handler, options] of this._boundHandlers) {
      target.removeEventListener(type, handler, options);
    }
    this._boundHandlers.length = 0;
    this.down.clear();
    this.pressed.clear();
  }
}
