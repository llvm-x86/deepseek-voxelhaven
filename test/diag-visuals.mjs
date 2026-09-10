/**
 * diag-visuals.mjs — throwaway diagnostic probe for the three reported visual
 * defects. Not part of `npm test`; run directly:
 *
 *   node test/diag-visuals.mjs
 *
 * It answers, with pixel evidence rather than opinion:
 *   1. Are trees clipped at chunk boundaries?
 *   2. What does the renderer actually draw when the player is underground?
 *   3. Does the held item produce any pixels at all?
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';

const PORT = 8391;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const report = [];
function log(section, text) {
  const line = `[${section}] ${text}`;
  report.push(line);
  console.log(line);
}

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  // ---------------------------------------------------------------------
  // Boot into a fixed-seed world so results are reproducible.
  // ---------------------------------------------------------------------
  await page.evaluate(() => window.VH.createWorld({ seed: 4242, name: 'diag' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(5));
  await sleep(4000);

  // =====================================================================
  // 1. TREES
  // =====================================================================
  const tree = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const gen = game.world.generator;
    // Find the first column in the loaded area that hosts a tree.
    const cx = Math.floor(game.player.x / 16);
    const cz = Math.floor(game.player.z / 16);
    let found = null;
    for (let dx = -4; dx <= 4 && !found; dx++) {
      for (let dz = -4; dz <= 4 && !found; dz++) {
        for (let x = 0; x < 16 && !found; x++) {
          for (let z = 0; z < 16 && !found; z++) {
            const wx = (cx + dx) * 16 + x;
            const wz = (cz + dz) * 16 + z;
            const t = gen.treeAt(wx, wz);
            if (t) found = t;
          }
        }
      }
    }
    if (!found) return { found: false };

    // Count canopy blocks around the trunk, and specifically which ones exist
    // in each of the four 4x4 quadrants the canopy should span.
    const { x: tx, y: ty, z: tz, height, kind } = found;
    const topY = ty + height;
    let canopyTotal = 0;
    const missing = [];
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          const id = game.world.getBlock(tx + dx, topY + dy, tz + dz);
          if (id === 10) canopyTotal++;
          else if (dx * dx + dz * dz <= 4) missing.push(`${dx},${dy},${dz}`);
        }
      }
    }
    // How close is the trunk to its chunk edge? A tree whose canopy crosses the
    // boundary is the suspected failure case.
    const localX = ((tx % 16) + 16) % 16;
    const localZ = ((tz % 16) + 16) % 16;
    const distToEdge = Math.min(localX, 15 - localX, localZ, 15 - localZ);
    return {
      found: true, tx, ty, tz, height, kind, topY, canopyTotal,
      localX, localZ, distToEdge, missingCount: missing.length,
      trunkBlock: game.world.getBlock(tx, ty + 1, tz),
      aboveTrunk: game.world.getBlock(tx, topY + 1, tz)
    };
  });
  log('TREE', JSON.stringify(tree));

  // Deterministic ground truth: build a tree exactly straddling a chunk edge
  // and check whether every block we place survives.
  const straddle = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const baseY = 90;
    const cx = 0, cz = 0;
    // x = 0 is the first column of chunk (0,0); -1,-2 are in chunk (-1,0).
    const placed = [];
    // Trunk at x=0, canopy spanning x=-2..2 -> crosses the boundary.
    for (let i = 1; i <= 4; i++) {
      if (window.VH.setBlock(0, baseY + i, 0, 'timber')) placed.push([0, baseY + i, 0]);
    }
    let canopyPlaced = 0;
    const wanted = [];
    for (let dx = -2; dx <= 2; dx++) {
      for (let dz = -2; dz <= 2; dz++) {
        wanted.push([dx, baseY + 5, dz]);
      }
    }
    for (const [dx, dy, dz] of wanted) {
      if (window.VH.setBlock(dx, dy, dz, 'canopy')) canopyPlaced++;
    }
    // Now read them back.
    const readBack = wanted.map(([dx, dy, dz]) => game.world.getBlock(dx, dy, dz));
    const present = readBack.filter((id) => id === 10).length;
    return { canopyPlaced, wanted: wanted.length, present };
  });
  log('STRADDLE', JSON.stringify(straddle));

  // Visual: stand back and photograph a tree.
  if (tree.found) {
    await page.evaluate((t) => {
      const game = window.__VOXELHAVEN__;
      window.VH.setTime(0.3);
      const y = t.ty + 6;
      game.player.x = t.tx + 0.5;
      game.player.y = y;
      game.player.z = t.tz + 12.5;
      window.VH.lookAt(t.tx + 0.5, t.ty + t.height - 1, t.tz + 0.5);
      window.VH.teleport(t.tx + 0.5, y, t.tz + 12.5);
    }, tree);
    await sleep(2500);
    log('TREE-SHOT', await screenshot(page, 'diag-tree'));
  }

  // =====================================================================
  // 2. UNDERGROUND / WALL VISIBILITY
  // =====================================================================
  const under = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const baseY = 100;
    // Carve a 5x4x5 room out of solid stone so the camera sits in a closed box.
    for (let x = -2; x <= 2; x++) {
      for (let z = -2; z <= 2; z++) {
        for (let y = 0; y <= 3; y++) window.VH.setBlock(x, baseY + y, z, 'air');
      }
    }
    // Fill the shell around it with stone.
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        for (let y = -2; y <= 5; y++) {
          const inside = Math.abs(x) <= 2 && Math.abs(z) <= 2 && y >= 0 && y <= 3;
          if (!inside) window.VH.setBlock(x, baseY + y, z, 'stone');
        }
      }
    }
    window.VH.teleport(0.5, baseY + 1.2, 0.5);
    window.VH.lookAt(5, baseY + 1.5, 0.5);
    return { baseY };
  });
  log('UNDERGROUND', JSON.stringify(under));
  await sleep(3000);

  // Count distinct block ids the view ray hits going outward. From inside a
  // sealed box every ray should immediately hit stone; if we can "see the whole
  // wall", rays escape to air/sky instead.
  const escape = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const y = 101.2;
    let solid = 0, air = 0, firstHits = {};
    for (let a = 0; a < 360; a += 5) {
      const rad = (a * Math.PI) / 180;
      const dx = Math.cos(rad), dz = Math.sin(rad);
      let hit = 'escape';
      for (let t = 0.1; t < 24; t += 0.1) {
        const id = game.world.getBlock(Math.floor(0.5 + dx * t), Math.floor(y), Math.floor(0.5 + dz * t));
        if (id !== 0) { hit = id; break; }
      }
      if (hit === 'escape') air++; else solid++;
      firstHits[hit] = (firstHits[hit] || 0) + 1;
    }
    // What does the renderer think is visible? Count chunk meshes drawn.
    const rs = game.renderer.stats;
    return { solid, air, firstHits, draws: rs.drawCalls, tris: rs.triangles };
  });
  log('WALL-RAYS', JSON.stringify(escape));

  const px = await page.evaluate(() => {
    const gl = window.__VOXELHAVEN__.renderer.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // For a sealed stone room the whole frame should be stone-grey. Measure how
    // uniform it is, and how much of it is sky-blue.
    let skyish = 0, total = 0, minL = 255, maxL = 0, sum = 0;
    for (let i = 0; i < buf.length; i += 4 * 37) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      const l = (r + g + b) / 3;
      total++; sum += l;
      if (l < minL) minL = l;
      if (l > maxL) maxL = l;
      if (b > r + 24 && b > 60) skyish++;
    }
    return { w, h, samples: total, skyish, minL, maxL, meanL: +(sum / Math.max(1, total)).toFixed(1) };
  });
  log('UNDERGROUND-PIXELS', JSON.stringify(px));
  log('UNDERGROUND-SHOT', await screenshot(page, 'diag-underground'));

  // =====================================================================
  // 3. HELD ITEM
  // =====================================================================
  const hand = await page.evaluate(async () => {
    const game = window.__VOXELHAVEN__;
    const gl = game.renderer.gl;
    window.VH.setTime(0.3);
    window.VH.teleport(0.5, 140, 0.5);   // high in the air, clean background
    window.VH.lookAt(5, 140, 0.5);
    window.VH.give('lantern', 8);
    window.VH.selectSlot(0);

    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const grab = () => {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));

    // Frame with the held item.
    await wait(400);
    const withItem = grab();
    const trisWith = game.renderer.stats.triangles;
    const drawsWith = game.renderer.stats.drawCalls;

    // Empty the held slot and grab again.
    const inv = game.player.inventory;
    const saved = inv.slots[game.player.selectedSlot];
    inv.slots[game.player.selectedSlot] = null;
    await wait(400);
    const without = grab();
    const trisWithout = game.renderer.stats.triangles;
    const drawsWithout = game.renderer.stats.drawCalls;
    inv.slots[game.player.selectedSlot] = saved;

    // Diff, restricted to the lower-right quadrant where a hand would sit.
    let diff = 0, diffLowerRight = 0, dxMin = 1e9, dxMax = -1, dyMin = 1e9, dyMax = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const d = Math.abs(withItem[i] - without[i])
          + Math.abs(withItem[i + 1] - without[i + 1])
          + Math.abs(withItem[i + 2] - without[i + 2]);
        if (d > 18) {
          diff++;
          // readPixels origin is bottom-left, so y<h/2 is the lower half.
          if (y < h / 2) { diffLowerRight++; }
          if (x < dxMin) dxMin = x;
          if (x > dxMax) dxMax = x;
          if (y < dyMin) dyMin = y;
          if (y > dyMax) dyMax = y;
        }
      }
    }
    const holder = game.buildHeldItem ? null : 'missing';
    return {
      w, h, diff, diffLowerRight, holder,
      bbox: diff ? { dxMin, dxMax, dyMin, dyMax } : null,
      trisWith, trisWithout, drawsWith, drawsWithout,
      triDelta: trisWith - trisWithout,
      drawDelta: drawsWith - drawsWithout,
      glError: gl.getError()
    };
  });
  log('HELD-ITEM', JSON.stringify(hand));
  log('HELD-SHOT', await screenshot(page, 'diag-held'));

  await page.evaluate(() => window.VH.setTime(0.3));
  await sleep(600);
  log('HELD-SHOT-CLEAN', await screenshot(page, 'diag-held-clean'));

  // Also probe: what does buildHeldItem actually return?
  const heldProbe = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    window.VH.give('lantern', 8);
    window.VH.selectSlot(0);
    const res = game.buildHeldItem(1 / 60);
    if (!res) return { returned: null };
    const mesh = res.mesh;
    return {
      returned: true,
      indexCount: mesh.indexCount,
      vertexCount: mesh.vertexCount,
      projectionFirst4: Array.from(res.projection.slice(0, 4)),
      projectionLast4: Array.from(res.projection.slice(12, 16)),
      cameraNear: game.camera.near,
      cameraFar: game.camera.far,
      heldStack: game.player.heldStack(),
      projFromCamera: Array.from(game.camera.projection.slice(12, 16))
    };
  });
  log('HELD-PROBE', JSON.stringify(heldProbe));

  log('ERRORS', `page=${pageErrors.length} console=${consoleErrors.length}`);
  if (pageErrors.length) log('PAGE-ERRORS', pageErrors.slice(0, 5).join(' | '));
  if (consoleErrors.length) log('CONSOLE-ERRORS', consoleErrors.slice(0, 5).join(' | '));
} finally {
  const txt = report.join('\n');
  fs.writeFileSync(path.join(OUT, 'diag-visuals.txt'), txt);
  console.log('\n--- report written to test/screenshots/diag-visuals.txt ---');
  await browser.close().catch(() => {});
  await server.stop();
}
