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

  // ---- Bug 2: the hand is cropped by the bottom-right corner ----------------
  const hand = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const mesh = game.renderer.heldItemMesh;
    game.player.inventory.clear();
    game.player.selectedSlot = 0;
    game._heldSwing = 0;
    // Capture the boxes the served build composes.
    const boxes = [];
    const realAdd = mesh.addBoxMulti.bind(mesh);
    mesh.addBoxMulti = (m, t, s, b, a, f) => {
      boxes.push({ x: m[12], y: m[13], z: m[14] });
      return realAdd(m, t, s, b, a, f);
    };
    game.buildHeldItem(1 / 60);
    mesh.addBoxMulti = realAdd;
    return { boxes, count: boxes.length };
  });
  check('the served build draws a forearm and a fist', hand.count === 2,
    `${hand.count} boxes: ${JSON.stringify(hand.boxes)}`);
  check('the served hand sits at the bottom-right of the view',
    hand.boxes.every((b) => b.x > 0.5 && b.y < -0.2),
    `centres ${hand.boxes.map((b) => `(${b.x.toFixed(2)},${b.y.toFixed(2)})`).join(' ')}`);

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
