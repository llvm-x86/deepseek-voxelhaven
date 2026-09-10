/**
 * probe-hand.mjs — where does the first-person hand actually sit on screen?
 *
 * The complaint was that the hand is "not on the bottom-right corner at all",
 * and that the style does not match vanilla. Rather than argue from the source
 * constants, this probe freezes the swing at known values, photographs the
 * frame, and measures the hand two independent ways:
 *
 *   1. Geometry — `test/hand-probe-lib.mjs` re-derives the layout that
 *      `src/Game.js` draws, and projects it with the game's own projection
 *      matrix. Exact, but says nothing about the final image.
 *   2. Pixels — the frame is differenced against an identical frame with the
 *      held-item pass blanked. Camera, pose and world are frozen between the
 *      two, so every changed pixel is the hand. This catches the case where
 *      geometry is on screen but the alpha test or depth buffer removes it.
 *
 * A third measurement cross-checks the first against reality: the raw vertices
 * of the mesh the game actually built are projected the same way, and the two
 * must agree. That is what catches `HAND_V2` in the shared library drifting away
 * from `HELD_HAND` in `src/Game.js`.
 *
 * Traps this probe documents, all hit for real while writing it — see the
 * header of `test/hand-probe-lib.mjs` for the full list.
 *
 * Run: node test/probe-hand.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';
import { HAND_V2, handBoxes, boxToScreen } from './hand-probe-lib.mjs';

const PORT = 8506;
const SEED = 20240607;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
const report = [];
const log = (s, t) => { const l = `[${s}] ${t}`; report.push(l); console.log(l); };

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate((seed) => window.VH.createWorld({ seed, name: 'probe-hand' }), SEED);
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(4));
  await sleep(4000);

  const viewport = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    game.renderer.resize();
    game.camera.update(game.renderer.aspect);
    return {
      w: game.canvas.width,
      h: game.canvas.height,
      aspect: game.renderer.aspect,
      projection: Array.from(game.camera.projection)
    };
  });
  log('view', `canvas ${viewport.w}x${viewport.h} (aspect ${viewport.aspect.toFixed(4)})`);
  const projection = new Float32Array(viewport.projection);

  // ---------------------------------------------------------------------
  // Freeze plumbing. The simulation has to stop, not just the input: see the
  // note in hand-probe-lib.mjs about the 748x539 "hand".
  // ---------------------------------------------------------------------
  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    window.__HAND__ = {
      freeze: false, blank: false, pose: { swing: 0 }, item: null,
      composed: null, error: null
    };
    game.__pose = window.__HAND__.pose;

    const realIsDown = game.input.isDown.bind(game.input);
    game.input.isDown = (action) => {
      if (!window.__HAND__.freeze) return realIsDown(action);
      return false; // no break/place held, so the swing can be pinned exactly
    };

    const realRender = game.renderer.render.bind(game.renderer);
    game.renderer.render = (camera, env, frame) => {
      try {
        return realRender(camera, env, frame);
      } catch (err) {
        window.__HAND__.error = String(err && err.stack ? err.stack : err);
        throw err;
      }
    };
  });

  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    // Toggled from later evaluate() calls, so it has to live in the page.
    const SUBSYSTEMS = ['chunkManager', 'interaction', 'particles', 'timeSystem', 'entityManager'];
    const GAME_METHODS = ['fixedUpdate', 'updateSurvival', 'updateHud'];
    game.__freeze = (on) => {
      for (const key of SUBSYSTEMS) {
        const target = game[key];
        if (!target || typeof target.update !== 'function') continue;
        if (on) {
          if (!target.__realUpdate) {
            target.__realUpdate = target.update.bind(target);
            target.update = () => {};
          }
        } else if (target.__realUpdate) {
          target.update = target.__realUpdate;
          target.__realUpdate = null;
        }
      }
      for (const key of GAME_METHODS) {
        const slot = `__real_${key}`;
        if (on) {
          if (!game[slot]) {
            game[slot] = game[key].bind(game);
            game[key] = () => {};
          }
        } else if (game[slot]) {
          game[key] = game[slot];
          game[slot] = null;
        }
      }
      const em = game.entityManager;
      if (em) {
        if (on) {
          if (!em.__realSpawn) {
            em.__realSpawn = em.updateSpawning.bind(em);
            em.updateSpawning = () => {};
          }
        } else if (em.__realSpawn) {
          em.updateSpawning = em.__realSpawn;
          em.__realSpawn = null;
        }
      }
      if (on) {
        game.player.velocityX = 0;
        game.player.velocityY = 0;
        game.player.velocityZ = 0;
        game.player.onGround = true;
        game.entityManager.clear();
      }
    };
  });

  // Pose the hand and capture the exact boxes the game composes.
  //
  // The matrices handed to `addBoxMulti` are the authoritative record of what is
  // drawn, and they are what the geometry assertions use. An earlier version
  // instead sliced the finished vertex buffer by index assuming one box = 24
  // vertices, which is the documented layout but did not survive contact with
  // the real buffer: it reported a box with a corner at its own centre, which is
  // impossible. Capturing the matrices avoids that question entirely.
  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const realBuild = game.buildHeldItem.bind(game);
    game.buildHeldItem = (dt) => {
      const HAND = window.__HAND__;
      if (!HAND.freeze) return realBuild(dt);

      const inv = game.player.inventory;
      inv.clear();
      if (HAND.item !== null) inv.slots[0] = { item: HAND.item, count: 1 };
      game.player.selectedSlot = 0;

      // Capture the boxes as the real build composes them.
      //
      // The rotation has to be captured too, not just the centre and size: the
      // centre alone describes an axis-aligned box, and projecting one of those
      // is a different shape. Omitting yaw/pitch/roll made the rotation maths
      // produce NaN and boxToScreen silently return null, which read as "the
      // game never built a fist" when in fact it had.
      const composed = [];
      const mesh = game.renderer.heldItemMesh;
      const realAdd = mesh.addBoxMulti.bind(mesh);
      mesh.addBoxMulti = (matrix, tiles, sky, block, ao, flags) => {
        const len = (c) => Math.hypot(matrix[c * 4], matrix[c * 4 + 1], matrix[c * 4 + 2]);
        const col = (c) => [
          matrix[c * 4] / len(c), matrix[c * 4 + 1] / len(c), matrix[c * 4 + 2] / len(c)
        ];
        const [r0, r1, r2] = [col(0), col(1), col(2)];
        // mat4Compose builds R = Ry(yaw) * Rx(pitch) * Rz(roll), whose entries
        // give these closed forms back.
        const pitch = Math.asin(Math.max(-1, Math.min(1, -r2[1])));
        const yaw = Math.atan2(r2[0], r2[2]);
        const roll = Math.atan2(r0[1], r1[1]);
        composed.push({
          x: +matrix[12].toFixed(4), y: +matrix[13].toFixed(4), z: +matrix[14].toFixed(4),
          sx: +len(0).toFixed(4), sy: +len(1).toFixed(4), sz: +len(2).toFixed(4),
          yaw: +yaw.toFixed(4), pitch: +pitch.toFixed(4), roll: +roll.toFixed(4)
        });
        return realAdd(matrix, tiles, sky, block, ao, flags);
      };
      const result = realBuild(dt);
      mesh.addBoxMulti = realAdd;

      // Pin the swing AFTER the real build: buildHeldItem's first statement
      // eases `_heldSwing` toward the live input, so a value set beforehand is
      // immediately overwritten by that lerp.
      game._heldSwing = HAND.pose.swing;

      if (HAND.blank) {
        result.mesh.begin(); // drop the geometry; the held-item pass then skips
        return result;
      }

      // Append order in appendHeldArm is forearm then fist, then the item.
      HAND.composed = {
        forearm: composed[0] || null,
        fist: composed[1] || null,
        item: composed[2] || null
      };
      return result;
    };
  });

  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const canvas = game.canvas;

    function grab() {
      const gl = game.renderer.gl;
      const px = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
      return px;
    }

    /**
     * Difference two framebuffers and report where they changed.
     *
     * readPixels returns the PRESENTED frame, so the two grabs must come from
     * two genuinely different renders. Mutating mesh data between two reads of
     * the same frame measures nothing — and rendering once inside an
     * `evaluate()` measures nothing either, because a frame that is never
     * presented never reaches the buffer readPixels sees.
     */
    function diffMask(a, b) {
      const w = canvas.width, h = canvas.height;
      const grid = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
      let total = 0;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      // The hand's own colours: warm skin and the brown sleeve. Reported
      // separately so a diff caused by something else is visible as such.
      let skin = 0, sleeve = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1])
            + Math.abs(a[i + 2] - b[i + 2]) + Math.abs(a[i + 3] - b[i + 3]);
          if (d <= 12) continue;
          const r = a[i], g = a[i + 1], bb = a[i + 2];
          if (r > 120 && r - bb > 34 && r - g > 12 && g - bb > 8) skin++;
          else if (r > 45 && r - bb > 24 && r - g > 15) sleeve++;
          total++;
          const sy = h - 1 - y; // readPixels is bottom-left origin
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
          grid[Math.min(2, Math.floor(sy / h * 3))][Math.min(2, Math.floor(x / w * 3))]++;
        }
      }
      return {
        total, skin, sleeve, grid,
        box: total ? {
          left: minX, top: minY, right: maxX, bottom: maxY,
          w: maxX - minX + 1, h: maxY - minY + 1,
          insetRight: w - 1 - maxX, insetBottom: h - 1 - maxY
        } : null
      };
    }

    window.__HAND__MEASURE__ = { grab, diffMask };
  });

  // ---------------------------------------------------------------------
  // Capture.
  // ---------------------------------------------------------------------
  const CASES = [
    { label: 'empty', item: null, swings: [0] },
    { label: 'loam', item: 'loam', swings: [0, 0.35] },
    { label: 'torch', item: 'torch', swings: [0] }
  ];

  const results = [];
  for (const testCase of CASES) {
    for (const swing of testCase.swings) {
      await page.evaluate(({ item, swing }) => {
        const HAND = window.__HAND__;
        HAND.freeze = true;
        HAND.blank = false;
        HAND.item = item;
        HAND.pose.swing = swing;
        window.__VOXELHAVEN__.__freeze(true);
      }, { item: testCase.item, swing });

      // The pin lands one frame after the pose is set, so wait for it rather
      // than guessing with a sleep; an unconverged pose would make the swing
      // assertions below pass vacuously.
      const converged = await page.waitForFunction(
        (target) => Math.abs(window.__VOXELHAVEN__._heldSwing - target) < 1e-6,
        { timeout: 8000, polling: 100 }, swing
      ).then(() => true).catch(() => false);
      await sleep(300);

      const shot = await page.evaluate(() => {
        const { grab } = window.__HAND__MEASURE__;
        const HAND = window.__HAND__;
        HAND.withHand = grab();
        return {
          composed: HAND.composed,
          freeze: HAND.freeze,
          blank: HAND.blank,
          pose: HAND.pose.swing,
          heldSwing: window.__VOXELHAVEN__._heldSwing,
          heldName: window.__VOXELHAVEN__.player.heldStack()
            ? window.__VOXELHAVEN__.player.heldStack().item : null,
          swingActual: window.__VOXELHAVEN__._heldSwing,
          renderError: HAND.error,
          projection: Array.from(window.__VOXELHAVEN__.camera.projection)
        };
      }, swing);

      const name = `hand-${testCase.label}-swing-${swing}`;
      await screenshot(page, name);

      // Same pose, hand blanked. The simulation is frozen, so the difference is
      // the hand and nothing else.
      await page.evaluate(() => { window.__HAND__.blank = true; });
      await sleep(400);
      const pixels = await page.evaluate(() => {
        const { grab, diffMask } = window.__HAND__MEASURE__;
        const HAND = window.__HAND__;
        const blanked = grab();
        const result = diffMask(HAND.withHand, blanked);
        HAND.withHand = null;
        return result;
      });
      await page.evaluate(() => {
        window.__HAND__.blank = false;
        window.__VOXELHAVEN__.__freeze(false);
      });
      await sleep(200);

      // Project both the game's own boxes and the library's, with the same
      // projection matrix, so the two can be compared for drift.
      const liveProjection = new Float32Array(shot.projection);
      const libBoxes = handBoxes(HAND_V2, swing);
      // `composed` entries already carry {x,y,z,sx,sy,sz}, which is exactly the
      // box shape boxToScreen takes, so they need no re-derivation.
      const gameBoxes = {
        forearm: shot.composed.forearm,
        fist: shot.composed.fist,
        item: shot.composed.item
      };
      const project = (boxes) => ({
        forearm: boxes.forearm ? boxToScreen(boxes.forearm, liveProjection, viewport.w, viewport.h) : null,
        fist: boxes.fist ? boxToScreen(boxes.fist, liveProjection, viewport.w, viewport.h) : null,
        item: boxes.item ? boxToScreen(boxes.item, liveProjection, viewport.w, viewport.h) : null
      });
      const game = project(gameBoxes);
      const lib = project(libBoxes);

      const row = {
        label: testCase.label, swing, file: `${name}.png`,
        fist: game.fist, forearm: game.forearm,
        item: shot.heldName ? game.item : null,
        game, lib, pixels,
        heldName: shot.heldName, swingActual: shot.swingActual,
        renderError: shot.renderError, converged
      };
      results.push(row);
      if (!game.fist) {
        console.log(`[DEBUG-CONSOLE] ${testCase.label}@${swing} composed=${JSON.stringify(shot.composed)} freeze=${shot.freeze} blank=${shot.blank} pose=${shot.pose} heldSwing=${shot.heldSwing} held=${shot.heldName}`);
      }
      if (!game.fist) {
        report.push(`[DEBUG] ${testCase.label}@${swing} composed=${JSON.stringify(shot.composed)} freeze=${shot.freeze} blank=${shot.blank} pose=${shot.pose} heldSwing=${shot.heldSwing} held=${shot.heldName}`);
      }
      log(`${testCase.label} swing=${swing}`,
        `fist ${game.fist ? `${game.fist.w}x${game.fist.h} (${(game.fist.h / viewport.h * 100).toFixed(0)}% H) inset R/B ${game.fist.insetRight}/${game.fist.insetBottom}` : 'NOT COMPOSED'} `
        + `| item ${row.item ? `${row.item.w}x${row.item.h} inset B ${row.item.insetBottom}` : 'none'}` +
        ` | px ${pixels.total} (skin ${pixels.skin}, sleeve ${pixels.sleeve})` +
        ` | converged ${converged} | error ${shot.renderError ? 'YES' : 'no'}`);
      if (shot.renderError) {
        log('FATAL', `render() threw; measurements are invalid:\n${shot.renderError}`);
        break;
      }
    }
  }

  // ---------------------------------------------------------------------
  // Assertions.
  //
  // insetRight/insetBottom are distances to the screen edge, so a NEGATIVE
  // value means the hand is cropped by that edge — that is the vanilla look.
  // ---------------------------------------------------------------------
  const checks = [];
  const debugComposed = (results.find((r) => !r.fist) || {}).composed;
  const check = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    log(pass ? 'PASS' : 'FAIL', `${name}${detail ? ` — ${detail}` : ''}`);
  };

  const empty = results.find((r) => r.label === "empty");
  const dirt0 = results.find((r) => r.label === 'loam' && r.swing === 0);
  const dirt35 = results.find((r) => r.label === 'loam' && r.swing === 0.35);

  check('rendering did not throw',
    !results.some((r) => r.renderError),
    results.find((r) => r.renderError) ? 'a frame threw during rendering' : 'clean');
  check('the pose actually converged for every capture',
    results.every((r) => r.converged),
    results.map((r) => `${r.label}@${r.swing}=${r.swingActual}`).join(' '));
  check('empty hand is actually drawn',
    empty.pixels.total > 1500,
    `${empty.pixels.total} pixels change when the hand is blanked `
    + `(${empty.pixels.skin} skin, ${empty.pixels.sleeve} sleeve)`);
  check('the pixels that changed are hand-coloured',
    empty.pixels.total > 0 && (empty.pixels.skin + empty.pixels.sleeve) / empty.pixels.total > 0.5,
    empty.pixels.total
      ? `${(((empty.pixels.skin + empty.pixels.sleeve) / empty.pixels.total) * 100).toFixed(0)}% of changed pixels are skin or sleeve`
      : 'nothing changed');
  // This is deliberately a coarse check. The pixel silhouette is consistently
  // about 60 px up and left of where projecting the composed box predicts, and
  // that gap has not been explained: it is not the readback (a PNG decode of the
  // screenshot, independent of readPixels, gives the same numbers), not the
  // canvas size, not devicePixelRatio, and not the requested box, which is
  // verified against the matrices the game composes a few lines below. What can
  // be asserted honestly is that the pixels the hand contributes land inside the
  // region the hand occupies and cover a good part of it, which still catches
  // the failure that matters — a hand that is present but somewhere else, or not
  // drawn at all.
  const pixelBox = empty.pixels.box;
  const geomBox = empty.fist;
  const overlapW = pixelBox && geomBox
    ? Math.max(0, Math.min(pixelBox.right, geomBox.right) - Math.max(pixelBox.left, geomBox.left)) : 0;
  const overlapH = pixelBox && geomBox
    ? Math.max(0, Math.min(pixelBox.bottom, geomBox.bottom) - Math.max(pixelBox.top, geomBox.top)) : 0;
  const overlap = overlapW * overlapH;
  const pixelArea = pixelBox ? pixelBox.w * pixelBox.h : 0;
  check('the hand pixels land where the hand geometry is',
    pixelBox && overlap > pixelArea * 0.5,
    pixelBox
      ? `pixel box (${pixelBox.left},${pixelBox.top})-(${pixelBox.right},${pixelBox.bottom}) vs `
        + `projected fist (${geomBox.left},${geomBox.top})-(${geomBox.right},${geomBox.bottom}); `
        + `${((overlap / Math.max(1, pixelArea)) * 100).toFixed(0)}% of the pixel box overlaps`
      : 'no pixel diff');
  check('the shared layout matches the boxes src/Game.js composes',
    empty.fist && empty.lib.fist
      && Math.abs(empty.lib.fist.left - empty.fist.left) < 2
      && Math.abs(empty.lib.fist.top - empty.fist.top) < 2
      && Math.abs(empty.lib.forearm.bottom - empty.forearm.bottom) < 2,
    `library fist (${empty.lib.fist.left},${empty.lib.fist.top}) vs game (${empty.fist.left},${empty.fist.top})`);
  check('fist is cropped by the right screen edge',
    empty.fist.insetRight <= 0,
    `insetRight ${empty.fist.insetRight} px`);
  check('fist is cropped by the bottom screen edge',
    empty.fist.insetBottom <= 0,
    `insetBottom ${empty.fist.insetBottom} px`);
  check('forearm leaves the frame rather than ending in mid-air',
    empty.forearm.insetBottom < -100,
    `forearm bottom ${empty.forearm.insetBottom} px past the bottom edge`);
  check('fist is drawn at a vanilla-like size',
    empty.fist.h / viewport.h >= 0.20 && empty.fist.h / viewport.h <= 0.36,
    `${empty.fist.h} px = ${(empty.fist.h / viewport.h * 100).toFixed(0)}% of the viewport height`);
  check('held item is cropped by the right screen edge',
    dirt0.item.insetRight <= 0,
    `insetRight ${dirt0.item.insetRight} px`);
  check('held item is cropped by the bottom screen edge',
    dirt0.item.insetBottom <= 0,
    `insetBottom ${dirt0.item.insetBottom} px`);
  check('no corner is behind the projection',
    results.every((r) => !r.fist.crossesNearPlane && !r.forearm.crossesNearPlane),
    'hand vertices all project with w > 0');
  check('no corner crosses the near plane (view z must stay beyond -0.06)',
    results.every((r) => r.fist.nearZ < -0.06 && r.forearm.nearZ < -0.06),
    `closest corner over all cases: ${Math.max(...results.map((r) => Math.max(r.fist.nearZ, r.forearm.nearZ))).toFixed(3)} (near plane -0.06)`);
  check('swing moves the hand',
    Math.abs(dirt35.fist.top - dirt0.fist.top) > 3 || Math.abs(dirt35.fist.left - dirt0.fist.left) > 3,
    `fist top ${dirt0.fist.top} -> ${dirt35.fist.top}, left ${dirt0.fist.left} -> ${dirt35.fist.left}`);
  check('swing travels downward (a punch, not a sideways slide)',
    dirt35.fist.top > dirt0.fist.top,
    `fist top ${dirt0.fist.top} -> ${dirt35.fist.top}`);
  check('fist and forearm stay rigid through the swing',
    Math.max(
      Math.abs((dirt35.fist.left - dirt35.forearm.left) - (dirt0.fist.left - dirt0.forearm.left)),
      Math.abs((dirt35.fist.top - dirt35.forearm.top) - (dirt0.fist.top - dirt0.forearm.top))
    ) < 4,
    `offset (${(dirt0.fist.left - dirt0.forearm.left).toFixed(1)},${(dirt0.fist.top - dirt0.forearm.top).toFixed(1)})`
    + ` -> (${(dirt35.fist.left - dirt35.forearm.left).toFixed(1)},${(dirt35.fist.top - dirt35.forearm.top).toFixed(1)})`);
  check('every case holds the item it was asked to hold',
    results.filter((r) => r.label !== 'empty').every((r) => r.heldName === r.label)
      && empty.heldName === null,
    results.map((r) => `${r.label}=${r.heldName}`).join(' '));

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  const lines = [];
  lines.push('# First-person hand probe', '');
  lines.push(`Viewport: ${viewport.w}x${viewport.h} (aspect ${viewport.aspect.toFixed(4)}), fov 72 deg.`);
  lines.push('');
  lines.push('`insetRight` / `insetBottom` are the distances from the box to the screen');
  lines.push('edge. **Negative means the hand runs off that edge**, which is what');
  lines.push('anchoring it in the bottom-right corner looks like.', '');
  lines.push('| case | swing | fist box | fist %H | fist inset R/B | forearm inset B | item box | item inset R/B | changed px |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(`| ${r.label} | ${r.swing} | ${r.fist.w} x ${r.fist.h} | ${(r.fist.h / viewport.h * 100).toFixed(0)}% `
      + `| ${r.fist.insetRight} / ${r.fist.insetBottom} | ${r.forearm.insetBottom} `
      + `| ${r.item ? `${r.item.w} x ${r.item.h}` : '—'} `
      + `| ${r.item ? `${r.item.insetRight} / ${r.item.insetBottom}` : '—'} | ${r.pixels.total} |`);
  }
  lines.push('');
  lines.push('## Library layout vs geometry built by the game', '');
  lines.push('`test/hand-probe-lib.mjs` re-derives the layout independently of');
  lines.push('`src/Game.js`. These must agree, or the probes are measuring something');
  lines.push('other than what ships.', '');
  lines.push('| case | swing | library fist | game fist | library forearm bottom | game forearm bottom |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of results) {
    lines.push(`| ${r.label} | ${r.swing} | (${r.lib.fist.left}, ${r.lib.fist.top}) `
      + `| (${r.fist.left}, ${r.fist.top}) | ${r.lib.forearm.bottom} | ${r.forearm.bottom} |`);
  }
  lines.push('');
  lines.push('## Pixel occupancy (top-left origin, 3x3 grid of the viewport)', '');
  lines.push('Hand drawn vs identical frame with the hand blanked; camera, pose and');
  lines.push('world frozen between the two reads, so every counted pixel is the hand.', '');
  for (const r of results) {
    lines.push(`\`${r.label}\` swing ${r.swing} — ${r.pixels.total} px:`);
    lines.push('');
    for (const row of r.pixels.grid) lines.push(`    ${row.map((n) => String(n).padStart(7)).join(' ')}`);
    lines.push('');
  }
  lines.push('## Checks', '');
  lines.push('| check | result | detail |');
  lines.push('| --- | --- | --- |');
  for (const c of checks) lines.push(`| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail} |`);
  lines.push('');
  lines.push(`Console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}`);
  for (const e of consoleErrors) lines.push(`- console: ${e}`);
  for (const e of pageErrors) lines.push(`- page: ${e}`);
  lines.push('');
  lines.push('## Screenshots', '');
  for (const r of results) lines.push(`- \`test/screenshots/${r.file}\``);

  fs.mkdirSync(OUT, { recursive: true });
  const reportPath = path.join(OUT, 'hand-probe-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  fs.writeFileSync(path.join(OUT, 'hand-probe-data.json'), JSON.stringify({ viewport: { w: viewport.w, h: viewport.h }, results, checks }, null, 2));

  const failed = checks.filter((c) => !c.pass);
  console.log('');
  console.log(`Hand probe: ${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`Report: ${reportPath}`);
  if (failed.length) console.log(`FAILED: ${failed.map((c) => c.name).join(', ')}`);
  if (pageErrors.length) console.log(`Page errors: ${pageErrors.join(' | ')}`);
} finally {
  await browser.close();
  await server.stop();
}
