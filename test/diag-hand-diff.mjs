/** Throwaway: validate that wrapping renderer.render yields a real object diff. */
import { startServer, launchGame, waitForState, sleep } from './headless.mjs';

const server = await startServer(8496);
const { browser, page } = await launchGame({ url: server.url });
try {
  await page.evaluate(() => window.VH.createWorld({ seed: 20240607, name: 'diag' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(4));
  await sleep(5000);
  await page.evaluate(() => {
    const s = window.VH.snapshot().player;
    window.VH.teleport(s.x, Math.round(s.y), s.z);
    window.VH.look(s.yaw, -0.30);
    window.VH.give('stone', 1);
  });
  await sleep(2500);

  const out = await page.evaluate(async () => {
    const game = window.__VOXELHAVEN__;
    const canvas = game.canvas;
    const gl = canvas.getContext('webgl2');
    const EMPTY = { indexCount: 0, vertexCount: 0, begin() {}, end() {}, draw() { return 0; } };
    const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

    const r = game.renderer;
    const original = r.render.bind(r);
    r.render = (cam, env, frame) => {
      if (game._probe && game._probe.hideHeld) frame.heldItem = { mesh: EMPTY, projection: cam.projection };
      return original(cam, env, frame);
    };

    const grab = (x, y, w, h) => {
      const buf = new Uint8Array(w * h * 4);
      gl.readPixels(x, canvas.height - (y + h), w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      return buf;
    };

    game._probe = { hideHeld: false };
    await nextFrame(); await nextFrame();
    const a = grab(700, 430, 560, 280);
    game._probe.hideHeld = true;
    await nextFrame(); await nextFrame();
    const b = grab(700, 430, 560, 280);
    game._probe.hideHeld = false;

    let diff = 0, maxD = 0;
    for (let k = 0; k < 560 * 280; k++) {
      const d = Math.abs(a[k * 4] - b[k * 4]) + Math.abs(a[k * 4 + 1] - b[k * 4 + 1]) + Math.abs(a[k * 4 + 2] - b[k * 4 + 2]);
      if (d > 24) diff++;
      if (d > maxD) maxD = d;
    }
    return { diffPixels: diff, maxDelta: maxD, held: window.VH.heldMeshStats() };
  });
  console.log(JSON.stringify(out, null, 2));
} finally {
  await browser.close();
  await server.stop();
}
