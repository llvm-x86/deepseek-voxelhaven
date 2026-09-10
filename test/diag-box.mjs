/**
 * diag-box.mjs — minimal, localised reproduction of the "see through the wall"
 * report. Builds one sealed 5x5x5 stone box entirely inside a single chunk and
 * photographs the inside. No terrain, no cave ambiguity.
 *
 * If the interior renders black/grey -> meshing is fine and the original bug is
 * environmental. If the interior shows sky -> interior faces are being dropped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';

const PORT = 8482;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
const report = [];
const log = (s, t) => { const l = `[${s}] ${t}`; report.push(l); console.log(l); };

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate(() => window.VH.createWorld({ seed: 4242, name: 'box' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(4));
  await sleep(4000);

  // Two boxes, each 5x5x5 of solid stone, high above the terrain so there is
  // nothing else in frame. Box A centre is at a chunk-local (8,8) = mid chunk.
  // Box B centre is at chunk-local (0,0) = the chunk corner.
  const built = await page.evaluate(async () => {
    const game = window.__VOXELHAVEN__;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.VH.setTime(0.3);
    const Y = 120;

    // Ground the player so the chunk streaming area is defined, then build.
    const baseX = 8, baseZ = 8;      // chunk (0,0) local centre
    const carveAndShell = (cx, cz, key) => {
      // Hollow interior 3x3x3, shell one block thick -> 5x5x5 total.
      for (let x = -2; x <= 2; x++) {
        for (let z = -2; z <= 2; z++) {
          for (let y = -2; y <= 2; y++) {
            const shell = Math.abs(x) === 2 || Math.abs(z) === 2 || Math.abs(y) === 2;
            window.VH.setBlock(cx + x, Y + y, cz + z, shell ? 'stone' : 'air');
          }
        }
      }
      return { cx, cz, key };
    };
    const boxA = carveAndShell(baseX, baseZ, 'mid-chunk');
    const boxB = carveAndShell(0, 0, 'chunk-corner');   // chunk-local (0,0)

    await wait(9000);

    // Verify with the voxel data that each box really is sealed.
    const probe = (cx, cz) => {
      const out = { centre: window.VH.getBlock(cx, Y, cz), overhead: [], walls: [] };
      for (let y = 1; y <= 3; y++) out.overhead.push(window.VH.getBlock(cx, Y + y, cz));
      out.walls.push(window.VH.getBlock(cx + 2, Y, cz));
      out.walls.push(window.VH.getBlock(cx - 2, Y, cz));
      out.walls.push(window.VH.getBlock(cx, Y, cz + 2));
      out.walls.push(window.VH.getBlock(cx, Y, cz - 2));
      out.floor = window.VH.getBlock(cx, Y - 2, cz);
      return out;
    };

    return {
      boxA, boxB,
      probeA: probe(baseX, baseZ),
      probeB: probe(0, 0),
      chunkOfA: `${Math.floor(baseX / 16)},${Math.floor(baseZ / 16)}`
    };
  });
  log('BUILT', JSON.stringify(built));

  // ---- Photograph the inside of box A (mid-chunk) -----------------------
  for (const [label, cx, cz] of [['A-midchunk', 8, 8], ['B-corner', 0, 0]]) {
    const info = await page.evaluate(async ({ cx, cz }) => {
      const game = window.__VOXELHAVEN__;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const Y = 120;
      window.VH.teleport(cx + 0.5, Y - 1.0, cz + 0.5);
      window.VH.lookAt(cx, Y + 2, cz);          // look up at the ceiling
      await wait(2500);

      const gl = game.renderer.gl;
      const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      const buckets = { dark: 0, grey: 0, sky: 0, other: 0 };
      for (let i = 0; i < buf.length; i += 4 * 17) {
        const r = buf[i], g = buf[i + 1], b = buf[i + 2];
        const lum = (r + g + b) / 3;
        if (b > r + 24 && b > 120) buckets.sky++;
        else if (lum < 40) buckets.dark++;
        else buckets.grey++;
      }
      const total = buckets.dark + buckets.grey + buckets.sky + buckets.other;
      const pct = (n) => +(100 * n / total).toFixed(1);
      return {
        pos: { x: +game.player.x.toFixed(2), y: +game.player.y.toFixed(2), z: +game.player.z.toFixed(2) },
        pitch: +game.player.pitch.toFixed(3),
        skyPct: pct(buckets.sky), darkPct: pct(buckets.dark), greyPct: pct(buckets.grey),
        draws: game.renderer.stats.drawCalls
      };
    }, { cx, cz });
    log(`INSIDE-${label}`, JSON.stringify(info));
    log(`SHOT-${label}`, await screenshot(page, `diag-box-${label}`));
  }

  log('ERRORS', `page=${pageErrors.length} console=${consoleErrors.length}`);
} finally {
  fs.writeFileSync(path.join(OUT, 'diag-box.txt'), report.join('\n'));
  await browser.close().catch(() => {});
  await server.stop();
}
