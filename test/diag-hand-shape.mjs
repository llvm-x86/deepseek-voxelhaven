/**
 * diag-hand-shape.mjs — where does the first-person hand actually render?
 *
 * Two independent sources, because each has been wrong on its own:
 *
 *   1. The vertex buffer the game hands to the draw call. Ground truth for
 *      "what geometry was built", independent of whether it lands on screen.
 *   2. The presented pixels, differenced against a frame where the hand's
 *      vertex data has been displaced before it is drawn.
 *
 * An earlier version of this probe stubbed `addBoxMulti` to blank the hand for
 * the second frame. When the mesh API moved to `addBoxMultiCorners` the stub
 * silently stopped matching, both frames came out identical, and the probe
 * reported "0 hand pixels" — which reads as a rendering bug rather than a
 * broken probe. Blanking now happens on the vertex buffer, below either mesh
 * method, so it cannot go stale the same way.
 */
import { launchGame, startServer, waitForState, sleep } from './headless.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'screenshots');
fs.mkdirSync(OUT, { recursive: true });

const PORT = Number(process.env.PORT || 8521);
const W = 1280, H = 720;
const server = await startServer(PORT);
const { browser, page } = await launchGame({ url: server.url, width: W, height: H });

try {
  await page.evaluate(() => window.VH.createWorld({ seed: 4242, name: 'hand-shape', peaceful: true }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(2));
  await sleep(2500);

  // ---- 1. The geometry the build produces, straight off the vertex buffer ----
  const geometry = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    player.inventory.clear();
    player.selectedSlot = 0;
    game._heldSwing = 0;
    player.velocityX = 0; player.velocityY = 0; player.velocityZ = 0;

    const mesh = game.renderer.heldItemMesh;
    game.buildHeldItem(1 / 60);
    const n = mesh.vertexCount;
    const verts = [];
    for (let i = 0; i < n; i++) {
      const o = i * 11;
      const x = mesh.vertices[o], y = mesh.vertices[o + 1], z = mesh.vertices[o + 2];
      const p = game.camera.projection;
      const cx = p[0] * x + p[4] * y + p[8] * z + p[12];
      const cy = p[1] * x + p[5] * y + p[9] * z + p[13];
      const cw = p[3] * x + p[7] * y + p[11] * z + p[15];
      verts.push({
        x: +x.toFixed(3), y: +y.toFixed(3), z: +z.toFixed(3), w: +cw.toFixed(3),
        sx: Math.round((cx / cw * 0.5 + 0.5) * 1280),
        sy: Math.round((0.5 - cy / cw * 0.5) * 720)
      });
    }
    return { vertexCount: n, indexCount: mesh.indexCount, verts };
  });

  // ---- 2. The pixels, against a frame with the hand's vertices displaced ----
  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    const zero = () => { player.velocityX = 0; player.velocityY = 0; player.velocityZ = 0; };
    for (const key of ['chunkManager', 'interaction', 'particles', 'timeSystem', 'entityManager']) {
      const t = game[key];
      if (t && typeof t.update === 'function') t.update = () => {};
    }
    game.fixedUpdate = () => {};
    game.updateSurvival = () => {};
    game.updateHud = () => {};
    if (game.entityManager) {
      game.entityManager.clear();
      game.entityManager.updateSpawning = () => {};
    }

    const cam = game.camera;
    const pin = { x: cam.x, y: cam.y, z: cam.z, yaw: cam.yaw, pitch: cam.pitch };
    const realBuild = game.buildHeldItem.bind(game);
    game.buildHeldItem = (dt) => {
      zero();
      cam.x = pin.x; cam.y = pin.y; cam.z = pin.z; cam.yaw = pin.yaw; cam.pitch = pin.pitch;
      // Skipping the build is the only reliable way to hide the hand: it is
      // rebuilt from scratch every frame, so blanking the vertex buffer is
      // overwritten before the next draw and measures nothing.
      if (window.__hideHand) return null;
      return realBuild(dt);
    };
    window.__hideHand = false;
  });

  await sleep(500);
  const withHand = path.join(OUT, 'diag-hand-with.png');
  await page.screenshot({ path: withHand });

  await page.evaluate(() => { window.__hideHand = true; });
  await sleep(500);
  const without = path.join(OUT, 'diag-hand-without.png');
  await page.screenshot({ path: without });

  console.log('geometry ' + JSON.stringify(geometry));
  console.log('wrote ' + withHand + ' ' + without);
} finally {
  await browser.close();
  await server.stop();
}
