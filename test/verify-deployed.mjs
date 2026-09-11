/**
 * Verify both fixes against the DEPLOYED server, over HTTP, in a real browser.
 * This is deliberately separate from the probes: those run against a server the
 * test itself starts, so they prove the source is right, not that the running
 * deployment is serving it.
 */
import { launchGame, waitForState, sleep } from './headless.mjs';

const URL = process.argv[2] || 'http://192.168.1.101:8123/';
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: URL });
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

try {
  await page.evaluate(() => window.VH.createWorld({ seed: 20240607, name: 'deployed-verify' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(3));
  await sleep(4000);

  // ---- The hand: one arm box, in the bottom-right, cropped by both edges ----
  //
  // Measured from the vertex buffer the served build actually fills, and from
  // the served camera's own projection — not from source, which would only
  // prove the files were copied.
  const hand = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const mesh = game.renderer.heldItemMesh;
    game.player.inventory.clear();
    game.player.selectedSlot = 0;
    game._heldSwing = 0;
    game.buildHeldItem(1 / 60);

    const p = game.camera.projection;
    const verts = [];
    for (let i = 0; i < mesh.vertexCount; i++) {
      const o = i * 11;
      const x = mesh.vertices[o], y = mesh.vertices[o + 1], z = mesh.vertices[o + 2];
      const cx = p[0] * x + p[4] * y + p[8] * z + p[12];
      const cy = p[1] * x + p[5] * y + p[9] * z + p[13];
      const cw = p[3] * x + p[7] * y + p[11] * z + p[15];
      if (cw === 0) continue;
      verts.push({
        x, y, z, w: cw,
        sx: (cx / cw * 0.5 + 0.5) * window.innerWidth,
        sy: (0.5 - cy / cw * 0.5) * window.innerHeight
      });
    }
    return {
      vertexCount: mesh.vertexCount,
      indexCount: mesh.indexCount,
      boxes: Math.round(mesh.vertexCount / 24),
      verts
    };
  });

  const inFront = hand.verts.filter((v) => v.w > 0);
  check('the served build draws the arm as a single box',
    hand.boxes === 1 && hand.indexCount === 36,
    `${hand.boxes} box(es), ${hand.vertexCount} vertices, ${hand.indexCount} indices`);
  check('the whole served arm is in front of the camera',
    hand.verts.length > 0 && hand.verts.every((v) => v.w > 0.06),
    `${inFront.length}/${hand.verts.length} vertices in front`);

  // Screen-space bounds, from the served build's own vertices and the served
  // camera's projection. This is what "in the bottom-right corner, cropped"
  // means as a number.
  const xs = inFront.map((v) => v.sx);
  const ys = inFront.map((v) => v.sy);
  const W = await page.evaluate(() => window.innerWidth);
  const H = await page.evaluate(() => window.innerHeight);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const visibleW = Math.min(W, maxX) - Math.max(0, minX);
  const visibleH = Math.min(H, maxY) - Math.max(0, minY);

  check('the served hand is cropped by the right and bottom edges',
    maxX > W && maxY > H,
    `bounds x ${minX.toFixed(0)}..${maxX.toFixed(0)}, y ${minY.toFixed(0)}..${maxY.toFixed(0)} of ${W}x${H}`);
  check('the served hand sits in the bottom-right, not the middle of the view',
    minX > 0.6 * W && minY > 0.3 * H,
    `starts at (${minX.toFixed(0)}, ${minY.toFixed(0)})`);
  check('the visible hand is hand-sized',
    visibleW > 90 && visibleW < 340 && visibleH > 90 && visibleH < 420,
    `${visibleW.toFixed(0)}x${visibleH.toFixed(0)} px visible`);

  // ---- Bug 1: the hotbar updates the instant a stack is spent --------------
  const hotbar = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    // Settle on the ground and aim at a block that can legally be built against.
    player.velocityX = 0; player.velocityY = 0; player.velocityZ = 0;
    const REPLACEABLE = new Set([0, 6, 30]);
    let aim = null;
    for (const pitch of [-0.55, -0.4, -0.9]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        game.camera.yaw = yaw; game.camera.pitch = pitch;
        game.interaction.refreshTarget();
        const t = game.interaction.target;
        if (!t) continue;
        const px = t.x + t.nx, py = t.y + t.ny, pz = t.z + t.nz;
        if (py < 0 || py >= 128) continue;
        const ex = game.world.getBlock(px, py, pz);
        if (ex !== 0 && !REPLACEABLE.has(ex)) continue;
        const h = player.halfWidth;
        if (px + 1 > player.x - h && px < player.x + h && py + 1 > player.y
          && py < player.y + 1.8 && pz + 1 > player.z - h && pz < player.z + h) continue;
        aim = { yaw, pitch };
        break;
      }
      if (aim) break;
    }
    if (!aim) return { error: 'no legal build target' };

    const inv = player.inventory;
    inv.clear();
    inv.slots[0] = { item: 'cobble', count: 1 };
    player.selectedSlot = 0;
    game.hud.refreshHotbar(player);
    const slot = () => document.querySelector('#hotbar .slot');
    const before = { icon: slot().style.backgroundImage !== '', title: slot().title };

    game.camera.yaw = aim.yaw; game.camera.pitch = aim.pitch;
    game.interaction.refreshTarget();
    const placed = game.interaction.tryPlace();
    return { placed, before, aim };
  });

  await sleep(500);
  const after = await page.evaluate(() => {
    const slot = document.querySelector('#hotbar .slot');
    return { icon: slot.style.backgroundImage !== '', title: slot.title };
  });

  check('the block was placed', hotbar.placed === true, JSON.stringify(hotbar.aim || hotbar.error));
  check('the hotbar showed the block before placing', hotbar.before.icon === true,
    `icon=${hotbar.before.icon} title="${hotbar.before.title}"`);
  check('the hotbar clears the instant the last block is placed', after.icon === false,
    `icon=${after.icon} title="${after.title}"`);

  check('no page errors', pageErrors.length === 0, pageErrors.join(' | ') || 'none');
  check('no console errors', consoleErrors.length === 0, consoleErrors.join(' | ') || 'none');

  const failed = results.filter((r) => !r.pass);
  console.log('');
  console.log(`Deployed build: ${results.length - failed.length}/${results.length} checks passed  (${URL})`);
  process.exitCode = failed.length ? 1 : 0;
} finally {
  await browser.close();
}
