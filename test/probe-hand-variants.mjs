/**
 * probe-hand-variants.mjs — choose the first-person hand transform by measurement.
 *
 * The report was "the hand extension doesn't follow the default minecraft style"
 * and, more specifically, "ours is not on the bottom-right corner at all".
 * `probe-hand.mjs` confirms the second half: the shipped fist+forearm occupies a
 * 137x228 px box whose right edge stops 285 px short of the screen edge and whose
 * bottom stops 71 px short of the bottom. Vanilla instead anchors the hand in the
 * corner, cropped by the frame, and draws it larger.
 *
 * This probe projects a grid of candidate layouts through the game's own
 * projection matrix and scores each against what that look requires.
 *
 * Three mistakes from earlier versions are designed out here, because each one
 * produced a confident, wrong answer:
 *
 *   - Scaling a hand's size AND its distance together changes nothing on screen
 *     (apparent size is size/distance), so a "scale" sweep reported four
 *     identical rows. Size and depth are separate knobs now.
 *   - A swing built from per-part rotations is not rigid; rotating boxes about a
 *     shared pivot slides them apart. `handBoxes` uses a rigid translation.
 *   - Scoring only "is the fist cropped by the corner" is not enough: a fist
 *     centred 97% of the way down the screen is cropped by everything and is
 *     also invisible. That layout scored perfectly and shipped a game with no
 *     visible hand at all. Candidates are now placed by SCREEN FRACTION and
 *     must be visible as well as cropped.
 *
 * Run: node test/probe-hand-variants.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, PROJECT_ROOT } from './headless.mjs';
import { handBoxes, boxToScreen } from './hand-probe-lib.mjs';

const PORT = 8509;
const SEED = 20240607;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
const report = [];
const log = (s, t) => { const l = `[${s}] ${t}`; report.push(l); console.log(l); };

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate((seed) => window.VH.createWorld({ seed, name: 'probe-variants' }), SEED);
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(3));
  await sleep(4000);

  const view = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    game.renderer.resize();
    game.camera.update(game.renderer.aspect);
    return {
      w: game.canvas.width,
      h: game.canvas.height,
      aspect: game.renderer.aspect,
      projection: Array.from(game.camera.projection),
      fov: game.camera.currentFov
    };
  });
  log('view', `canvas ${view.w}x${view.h} aspect ${view.aspect.toFixed(4)} fov ${view.fov}`);

  const projection = new Float32Array(view.projection);
  const measure = (boxes) => ({
    forearm: boxToScreen(boxes.forearm, projection, view.w, view.h),
    fist: boxToScreen(boxes.fist, projection, view.w, view.h),
    item: boxToScreen(boxes.item, projection, view.w, view.h)
  });

  // Read the shipped hand out of the running game so the "before" numbers stay
  // honest even if HAND_V2 is edited later.
  const shipped = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const mesh = game.renderer.heldItemMesh;
    game.player.inventory.clear();
    game.player.selectedSlot = 0;
    game.buildHeldItem(1 / 60);
    const data = mesh.vertices;
    const STRIDE = 11;
    const m = game.camera.projection;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, nearZ = -Infinity;
    for (let i = 0; i < mesh.vertexCount; i++) {
      const o = i * STRIDE;
      const x = data[o], y = data[o + 1], z = data[o + 2];
      if (z > nearZ) nearZ = z;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-6) continue;
      const sx = (cx / cw * 0.5 + 0.5) * game.canvas.width;
      const sy = (0.5 - cy / cw * 0.5) * game.canvas.height;
      if (sx < minX) minX = sx; if (sx > maxX) maxX = sx;
      if (sy < minY) minY = sy; if (sy > maxY) maxY = sy;
    }
    return {
      left: +minX.toFixed(1), top: +minY.toFixed(1),
      right: +maxX.toFixed(1), bottom: +maxY.toFixed(1),
      w: +(maxX - minX).toFixed(1), h: +(maxY - minY).toFixed(1),
      insetRight: +(game.canvas.width - maxX).toFixed(1),
      insetBottom: +(game.canvas.height - maxY).toFixed(1),
      nearZ: +nearZ.toFixed(3)
    };
  });

  // ---------------------------------------------------------------------
  // Candidate grid, placed by SCREEN FRACTION.
  //
  // This is the fix for the bug that shipped an invisible hand: instead of
  // guessing view-space x/y, the fist's CENTRE is placed at a chosen fraction
  // of the viewport and converted to view space through the real projection.
  // `centreX 0.95` means the fist's middle projects at 95% of the way across.
  // ---------------------------------------------------------------------
  const CANDIDATES = [];
  const SIZES = [0.16, 0.18, 0.20, 0.24];
  const DEPTHS = [-0.85, -0.95];
  const CENTRES = [
    { x: 0.88, y: 0.80, label: 'corner' },
    { x: 0.82, y: 0.72, label: 'inset' },
    { x: 0.94, y: 0.88, label: 'deep' }
  ];
  for (const size of SIZES) {
    for (const depth of DEPTHS) {
      for (const centre of CENTRES) {
        CANDIDATES.push(buildVariant(size, depth, centre, view));
      }
    }
  }

  const rows = [];
  for (const candidate of CANDIDATES) {
    const rest = measure(handBoxes(candidate, 0));
    const swung = measure(handBoxes(candidate, 0.35));
    const offset = (m) => ({ x: m.fist.left - m.forearm.left, y: m.fist.top - m.forearm.top });
    const o0 = offset(rest), o1 = offset(swung);
    rows.push({
      name: candidate.name,
      variant: candidate,
      fist: rest.fist,
      forearm: rest.forearm,
      item: rest.item,
      fistHeightFraction: +(rest.fist.h / view.h).toFixed(3),
      // Visible = a decent number of fist pixels are actually inside the frame.
      fistVisiblePx: visibleArea(rest.fist, view),
      itemVisiblePx: visibleArea(rest.item, view),
      drift: +Math.hypot(o1.x - o0.x, o1.y - o0.y).toFixed(1),
      swingTravel: +Math.hypot(swung.fist.top - rest.fist.top, swung.fist.left - rest.fist.left).toFixed(1)
    });
  }

  // ---------------------------------------------------------------------
  // Score.
  // ---------------------------------------------------------------------
  const TARGET_FIST_FRACTION = 0.27;
  const scored = rows.map((row) => {
    const reasons = [];
    const f = row.fist, a = row.forearm;
    if (row.fistVisiblePx < 8000) reasons.push(`only ${row.fistVisiblePx} px of fist on screen`);
    if (row.itemVisiblePx < 5000) reasons.push(`only ${row.itemVisiblePx} px of item on screen`);
    if (!(f.insetRight <= 0)) reasons.push(`fist stops ${f.insetRight}px short of the right edge`);
    if (!(f.insetBottom <= 0)) reasons.push(`fist stops ${f.insetBottom}px short of the bottom edge`);
    if (!(a.insetBottom < -100)) reasons.push('forearm does not leave the bottom edge');
    if (f.crossesNearPlane || a.crossesNearPlane) reasons.push('crosses the near plane');
    if (row.drift > Math.max(4, row.swingTravel * 0.2)) {
      reasons.push(`fist/forearm drift ${row.drift}px through the swing`);
    }
    if (row.fistHeightFraction < 0.20 || row.fistHeightFraction > 0.36) {
      reasons.push(`fist is ${(row.fistHeightFraction * 100).toFixed(0)}% of screen height (want ~27%)`);
    }
    if (row.swingTravel < 6) reasons.push(`swing moves the hand only ${row.swingTravel}px`);
    return { row, reasons, ok: reasons.length === 0, sizeError: Math.abs(row.fistHeightFraction - TARGET_FIST_FRACTION) };
  });
  scored.sort((x, y) => (x.ok === y.ok ? x.sizeError - y.sizeError : x.ok ? -1 : 1));

  // ---------------------------------------------------------------------
  // Report
  // ---------------------------------------------------------------------
  log('shipped', `fist+forearm ${shipped.w}x${shipped.h} @ (${shipped.left},${shipped.top}), `
    + `inset R/B ${shipped.insetRight}/${shipped.insetBottom}`);
  log('', '');
  log('columns', 'candidate | fist w x h | %H | fist insetR/insetB | fist vis px | item vis px | forearm insetB | drift | swing | near');
  for (const row of rows) {
    const f = row.fist;
    log('row', [
      row.name.padEnd(24),
      `${f.w} x ${f.h}`.padEnd(12),
      `${(row.fistHeightFraction * 100).toFixed(0)}%`.padEnd(5),
      `${f.insetRight} / ${f.insetBottom}`.padEnd(16),
      String(row.fistVisiblePx).padEnd(11),
      String(row.itemVisiblePx).padEnd(12),
      String(row.forearm.insetBottom).padEnd(14),
      String(row.drift).padEnd(6),
      `${row.swingTravel}px`.padEnd(7),
      f.crossesNearPlane || row.forearm.crossesNearPlane ? 'CROSSES' : 'ok'
    ].join(' | '));
  }
  log('', '');
  for (const entry of scored) {
    log(entry.ok ? 'VIABLE' : 'reject',
      `${entry.row.name} — ${entry.reasons.length ? entry.reasons.join('; ') : 'meets every requirement'}`);
  }
  const viable = scored.filter((s) => s.ok);
  const best = viable[0] || null;
  log('', '');
  log('summary', `${viable.length} of ${rows.length} candidates met every requirement`);
  if (best) {
    log('BEST', best.row.name);
    log('HAND_V2', JSON.stringify(best.row.variant, null, 2));
  }

  fs.mkdirSync(OUT, { recursive: true });
  const lines = [];
  lines.push('# First-person hand: candidate transforms', '');
  lines.push(`Viewport ${view.w}x${view.h}, fov ${view.fov} deg. All figures are canvas pixels.`);
  lines.push('');
  lines.push('Candidates are placed by **screen fraction**: the fist centre is put at a');
  lines.push('chosen fraction of the viewport and converted to view space through the');
  lines.push('real projection. An earlier grid placed the fist in raw view-space');
  lines.push('coordinates, chose a centre 97% of the way down the screen, and shipped a');
  lines.push('hand that was cropped by every edge and therefore invisible.');
  lines.push('');
  lines.push('`insetR`/`insetB` are distances to the right and bottom edges; **negative**');
  lines.push('means cropped by that edge. `vis px` is how much of the box is actually');
  lines.push('inside the frame.', '');
  lines.push('Shipped hand for reference: the combined fist+forearm box is '
    + `**${shipped.w} x ${shipped.h} px** at inset ${shipped.insetRight} / ${shipped.insetBottom}.`);
  lines.push('');
  lines.push('| candidate | fist w x h | %H | fist insetR/B | fist vis px | item vis px | forearm insetB | drift | swing | near plane |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const row of rows) {
    const f = row.fist;
    lines.push(`| ${row.name} | ${f.w} x ${f.h} | ${(row.fistHeightFraction * 100).toFixed(0)}% `
      + `| ${f.insetRight} / ${f.insetBottom} | ${row.fistVisiblePx} | ${row.itemVisiblePx} `
      + `| ${row.forearm.insetBottom} | ${row.drift} px | ${row.swingTravel} px `
      + `| ${f.crossesNearPlane || row.forearm.crossesNearPlane ? '**CROSSES**' : 'ok'} |`);
  }
  lines.push('');
  lines.push('## Scoring', '');
  lines.push('| candidate | verdict | why |');
  lines.push('| --- | --- | --- |');
  for (const entry of scored) {
    lines.push(`| ${entry.row.name} | ${entry.ok ? 'VIABLE' : 'rejected'} | ${entry.reasons.length ? entry.reasons.join('; ') : 'meets every requirement'} |`);
  }
  lines.push('');
  if (best) {
    lines.push('## Chosen candidate', '');
    lines.push(`**${best.row.name}**`, '');
    lines.push('```js');
    lines.push(`const HELD_HAND = ${JSON.stringify(best.row.variant, null, 2)};`);
    lines.push('```');
  } else {
    lines.push('No candidate satisfied every requirement.');
  }
  lines.push('');
  lines.push(`Console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}`);
  for (const e of consoleErrors) lines.push(`- console: ${e}`);
  for (const e of pageErrors) lines.push(`- page: ${e}`);
  const reportPath = path.join(OUT, 'hand-variants-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  fs.writeFileSync(path.join(OUT, 'hand-variants-data.json'), JSON.stringify({
    view: { w: view.w, h: view.h },
    shipped,
    rows,
    scored: scored.map((s) => ({ name: s.row.name, ok: s.ok, reasons: s.reasons }))
  }, null, 2));
  console.log('');
  console.log(`Report: ${reportPath}`);
} finally {
  await browser.close();
  await server.stop();
}

/** How many pixels of a screen box fall inside the viewport. */
function visibleArea(box, view) {
  if (!box) return 0;
  const w = Math.max(0, Math.min(box.right, view.w) - Math.max(box.left, 0));
  const h = Math.max(0, Math.min(box.bottom, view.h) - Math.max(box.top, 0));
  return Math.round(w * h);
}

/**
 * Build one candidate.
 *
 * @param {number} size fist cube edge length, view units
 * @param {number} depth fist centre z (negative is in front of the camera)
 * @param {{x:number,y:number,label:string}} centre fist centre as a fraction of
 *        the viewport; converted to view space below
 * @param {{w:number,h:number,aspect:number,fov:number}} view
 */
function buildVariant(size, depth, centre, view) {
  // Screen fraction -> view space. A point at depth |z| covers `halfH` units
  // vertically and `halfH * aspect` horizontally, so fraction f maps to
  // (2f - 1) * halfExtent.
  const z = Math.abs(depth);
  const halfH = z * Math.tan((view.fov || 72) * Math.PI / 180 / 2);
  const halfW = halfH * view.aspect;
  const x = (centre.x * 2 - 1) * halfW;
  const y = -(centre.y * 2 - 1) * halfH;

  // The other parts are offsets from the fist, so the group keeps its shape as
  // size and depth change. The forearm goes down-right and behind; the item
  // tucks up-left of the fist.
  return {
    name: `size ${size} depth ${depth} ${centre.label}`,
    fist: { x, y, z: depth, yaw: 0.62, pitch: -0.30, roll: 0.10, size },
    forearm: {
      x: x + size * 0.45,
      y: y - size * 2.6,
      z: depth - size * 0.5,
      sizeXZ: size * 0.9,
      sizeY: size * 5.5,
      yaw: 0.42, pitch: 0.34, roll: 0.10
    },
    item: {
      x: x - size * 0.75,
      y: y + size * 0.95,
      z: depth + size * 0.25,
      yaw: 0.62, pitch: -0.30, roll: 0.10, size: size * 0.9
    },
    swing: { x: -size * 0.18, y: -size * 0.5 }
  };
}
