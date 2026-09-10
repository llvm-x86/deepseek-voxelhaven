/**
 * diag-underground.mjs — second-pass probe for the "I can see the whole wall
 * when underground" report. Uses positive-space checks so a failed teleport or
 * a stale mesh cannot masquerade as a rendering bug.
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';

const PORT = 8392;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
const report = [];
const log = (s, t) => { const l = `[${s}] ${t}`; report.push(l); console.log(l); };

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate(() => window.VH.createWorld({ seed: 4242, name: 'diag2' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(4));
  await sleep(5000);

  const setup = await page.evaluate(async () => {
    const game = window.__VOXELHAVEN__;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.VH.setTime(0.3);

    // Pick a column, then go DEEP: well below the surface so we are inside
    // solid rock rather than in a cave we did not notice.
    const px = Math.floor(game.player.x);
    const pz = Math.floor(game.player.z);
    const surface = game.world.surfaceHeight ? game.world.surfaceHeight(px, pz) : null;
    const baseY = 40;

    // Carve a clean 7x5x7 room and line it with stone so nothing can see out.
    for (let x = -3; x <= 3; x++) {
      for (let z = -3; z <= 3; z++) {
        for (let y = 0; y <= 4; y++) window.VH.setBlock(px + x, baseY + y, pz + z, 'air');
      }
    }
    // Seal the shell one block thick.
    for (let x = -4; x <= 4; x++) {
      for (let z = -4; z <= 4; z++) {
        for (let y = -1; y <= 5; y++) {
          const inside = Math.abs(x) <= 3 && Math.abs(z) <= 3 && y >= 0 && y <= 4;
          if (!inside) window.VH.setBlock(px + x, baseY + y, pz + z, 'stone');
        }
      }
    }

    // Let the chunk manager rebuild, then confirm the room is really air.
    await wait(6000);
    const probes = [];
    for (const [dx, dy, dz] of [[0, 0, 0], [0, 2, 0], [3, 2, 0], [0, 2, 3], [-3, 2, 0], [0, 2, -3], [0, 4, 0]]) {
      probes.push(window.VH.getBlock(px + dx, baseY + dy, pz + dz));
    }

    // Teleport and read the position BACK.
    window.VH.teleport(px + 0.5, baseY + 1.05, pz + 0.5);
    window.VH.lookAt(px + 3, baseY + 1, pz + 0.5);
    await wait(1500);

    const store = game.world;
    const chunk = store.getChunk ? store.getChunk(Math.floor((px + 0.5) / 16), Math.floor((pz + 0.5) / 16)) : null;
    return {
      baseY, surface,
      roomAir: probes,
      playerPos: { x: +game.player.x.toFixed(2), y: +game.player.y.toFixed(2), z: +game.player.z.toFixed(2) },
      playerOnGround: game.player.onGround,
      chunkState: chunk ? chunk.state : 'no chunk',
      chunkHasMesh: chunk ? !!chunk.mesh : 'n/a',
      draws: game.renderer.stats.drawCalls,
      tris: game.renderer.stats.triangles
    };
  });
  log('SETUP', JSON.stringify(setup));

  const shotA = await screenshot(page, 'diag-under-2a');

  // Positive-space: from THIS camera, march rays and record the first hit.
  const rays = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const eye = { x: game.player.x, y: game.player.y + game.player.eyeHeight, z: game.player.z };
    const yaw = game.player.yaw, pitch = game.player.pitch;
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    const fx = -Math.sin(yaw) * cp, fy = sp, fz = -Math.cos(yaw) * cp;
    const rxv = Math.cos(yaw), rzv = -Math.sin(yaw);
    const ux = -rzv * fy, uy = rxv * fz - (-rzv) * fx, uz = rxv * fy;
    let hits = {};
    for (let iy = -3; iy <= 3; iy++) {
      for (let ix = -5; ix <= 5; ix++) {
        const dx = fx + (ix / 5) * 0.7 * rxv + (iy / 3) * 0.7 * ux;
        const dy = fy + (iy / 3) * 0.7 * uy;
        const dz = fz + (ix / 5) * 0.7 * rzv + (iy / 3) * 0.7 * uz;
        const len = Math.hypot(dx, dy, dz);
        let hit = 'sky';
        for (let t = 0.2; t < 30; t += 0.15) {
          const id = game.world.getBlock(
            Math.floor(eye.x + (dx / len) * t),
            Math.floor(eye.y + (dy / len) * t),
            Math.floor(eye.z + (dz / len) * t)
          );
          if (id !== 0) { hit = id; break; }
        }
        hits[hit] = (hits[hit] || 0) + 1;
      }
    }
    return { eye: { x: +eye.x.toFixed(2), y: +eye.y.toFixed(2), z: +eye.z.toFixed(2) }, hits };
  });
  log('RAY-HITS (0=air-through-to-sky, 3=stone)', JSON.stringify(rays));

  const strip = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const gl = game.renderer.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    // Sample a cross through the frame centre.
    const at = (x, y) => { const i = (y * w + x) * 4; return [buf[i], buf[i + 1], buf[i + 2]]; };
    const cx = w >> 1, cy = h >> 1;
    return {
      centre: at(cx, cy),
      up: at(cx, cy + 200),
      down: at(cx, cy - 200),
      left: at(cx - 300, cy),
      right: at(cx + 300, cy),
      topEdge: at(cx, h - 60),
      bottomEdge: at(cx, 40)
    };
  });
  log('PIXELS', JSON.stringify(strip));

  // Force every loaded chunk to rebuild from scratch, then look again.
  const afterForce = await page.evaluate(async () => {
    const game = window.__VOXELHAVEN__;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const cm = game.chunkManager;
    let n = 0;
    for (const chunk of game.world.chunks.values()) {
      if (chunk.mesh) { chunk.mesh.dispose ? chunk.mesh.dispose() : null; chunk.mesh = null; }
      chunk.state = 2;
      cm.workQueue.push(chunk);
      n++;
    }
    await wait(8000);
    const gl = game.renderer.gl;
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    const buf = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let skyish = 0, total = 0;
    for (let i = 0; i < buf.length; i += 4 * 37) {
      const r = buf[i], g = buf[i + 1], b = buf[i + 2];
      total++;
      if (b > r + 24 && b > 60) skyish++;
    }
    return { remeshed: n, skyishPct: +(100 * skyish / total).toFixed(1), draws: game.renderer.stats.drawCalls };
  });
  log('AFTER-FORCED-REMESH', JSON.stringify(afterForce));
  const shotB = await screenshot(page, 'diag-under-2b');

  log('SHOTS', `${shotA} | ${shotB}`);
  log('ERRORS', `page=${pageErrors.length} console=${consoleErrors.length}`);
} finally {
  fs.writeFileSync(path.join(OUT, 'diag-underground.txt'), report.join('\n'));
  await browser.close().catch(() => {});
  await server.stop();
}
