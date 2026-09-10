/**
 * probe-hotbar.mjs — regression probe for "the placed block stays in the hotbar".
 *
 * Reproduces the reported bug through the real input path: give the player a
 * stack of exactly one block, aim at the ground, place it, and then check what
 * the HUD is showing for that slot.
 *
 * The bug was that `Interaction.tryPlace` spends the stack with
 * `inventory.removeAt(...)` and emits `blockPlaced`, but never announced an
 * inventory change. `HUD.refreshHotbar` only re-ran when the selected slot
 * changed or when some other subsystem happened to emit `hotbarRefresh`, so the
 * hotbar kept drawing a block the player had already used until they scrolled
 * the hotbar or opened the inventory.
 *
 * Run: node test/probe-hotbar.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';

const PORT = 8507;
const SEED = 20240607;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
const report = [];
const log = (s, t) => { const l = `[${s}] ${t}`; report.push(l); console.log(l); };

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate((seed) => window.VH.createWorld({ seed, name: 'probe-hotbar' }), SEED);
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(3));
  await sleep(4000);

  /**
   * Read what the hotbar is DISPLAYING, not what the inventory holds.
   *
   * The whole bug was a disagreement between these two, so a test that only
   * inspects the inventory would have passed while the screen was wrong. The
   * icon is a CSS background-image data URL and the count is text content.
   */
  const readHotbar = () => page.evaluate(() => {
    const elements = Array.from(document.querySelectorAll('#hotbar .slot'));
    return elements.map((el) => {
      const count = el.querySelector('.slot-count');
      const bg = el.style.backgroundImage || '';
      return {
        hasIcon: bg !== '' && bg !== 'none',
        count: count ? count.textContent : '',
        title: el.title || ''
      };
    });
  });

  /**
   * Aim at a block the player can legally build against.
   *
   * Looking straight down targets the block underfoot, and `tryPlace` correctly
   * refuses that: the new block would land in the cell the player occupies.
   * That refusal is the anti-entombment guard working, not a placement failure,
   * and it made an earlier version of this probe report every placement as
   * broken. So: sweep the yaw until the raycast lands on a solid block whose
   * build cell is free, then leave the camera there.
   */
  const aimAtGround = () => page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    const camera = game.camera;
    const REPLACEABLE = new Set([0, 6, 30]); // air, sapling-ish, tall grass
    for (const pitch of [-0.55, -0.4, -0.9]) {
      for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
        camera.yaw = yaw;
        camera.pitch = pitch;
        game.interaction.refreshTarget();
        const t = game.interaction.target;
        if (!t) continue;
        const px = t.x + t.nx, py = t.y + t.ny, pz = t.z + t.nz;
        if (py < 0 || py >= 128) continue;
        const existing = game.world.getBlock(px, py, pz);
        if (existing !== 0 && !REPLACEABLE.has(existing)) continue;
        const half = player.halfWidth;
        const overlapsPlayer = (px + 1 > player.x - half && px < player.x + half
          && py + 1 > player.y && py < player.y + 1.8
          && pz + 1 > player.z - half && pz < player.z + half);
        if (overlapsPlayer) continue;
        return { yaw, pitch, target: { id: t.id, x: t.x, y: t.y, z: t.z }, cell: [px, py, pz], existing };
      }
    }
    return null;
  });

  // Ground the player first, then aim: the aim search depends on where they are
  // standing.
  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    // Drop onto the surface so the block below is definitely a real block.
    player.y = 80;
    player.velocityX = 0; player.velocityY = 0; player.velocityZ = 0;
  });
  await page.waitForFunction(() => {
    const p = window.__VOXELHAVEN__.player;
    return p.onGround && p.y > 1 && p.y < 90;
  }, { timeout: 30000, polling: 150 }).catch(() => {});
  await sleep(1200);

  const aim = await aimAtGround();
  log('aim', aim
    ? `yaw ${aim.yaw.toFixed(2)} pitch ${aim.pitch} -> block ${JSON.stringify(aim.target)}, build cell ${JSON.stringify(aim.cell)} (was ${aim.existing})`
    : 'no legal build target found');
  await sleep(300);

  const setup = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    const inv = player.inventory;
    inv.clear();
    // Exactly one block, so a single placement must empty the slot entirely.
    inv.slots[0] = { item: 'cobble', count: 1 };
    player.selectedSlot = 0;
    game.hud.refreshHotbar(player);
    return {
      held: player.heldStack() ? player.heldStack().item : null,
      count: player.heldStack() ? player.heldStack().count : 0,
      revision: inv.revision
    };
  });
  log('setup', `holding ${setup.count}x ${setup.held}, inventory revision ${setup.revision}`);

  const before = await readHotbar();
  log('before place', `slot 0 icon=${before[0].hasIcon} count="${before[0].count}" title="${before[0].title}"`);

  // Place through the interaction system, exactly as a right-click would.
  const aimAgain = await aimAtGround();
  const placed = await page.evaluate((aim) => {
    const game = window.__VOXELHAVEN__;
    const player = game.player;
    // Re-aim: the game keeps ticking between evaluates, and PlayerController
    // rewrites the camera angles from input every frame, so a pitch set in an
    // earlier evaluate may already have been reset.
    game.camera.yaw = aim.yaw;
    game.camera.pitch = aim.pitch;
    // tryPlace works off `interaction.target`, which is only filled in by
    // Interaction.update. Refresh it explicitly so this runs through the real
    // placement code rather than depending on the last frame's aim.
    game.interaction.refreshTarget();
    const before = player.blocksPlaced;
    const target = game.interaction.target;
    const ok = game.interaction.tryPlace();
    // If it refused, reproduce tryPlace's own gates so the report says WHY
    // rather than just "false". Blaming the game for a refusal caused by the
    // probe's aim is exactly the mistake that wasted a run here.
    let refusal = null;
    if (!ok && target) {
      const stack = player.heldStack();
      const REPLACEABLE = new Set([0, 6, 30]);
      const px = target.x + target.nx, py = target.y + target.ny, pz = target.z + target.nz;
      const gates = {
        hasStack: !!stack,
        blockIdOfHeldItem: stack ? (window.VOXELHAVEN_INTERNALS
          ? window.VOXELHAVEN_INTERNALS.blockIdOf(stack.item) : 'unknown') : null,
        placeYInRange: py >= 0 && py < 128,
        existing: game.world.getBlock(px, py, pz),
        existingReplaceable: REPLACEABLE.has(game.world.getBlock(px, py, pz)),
        sameAsHeld: false,
        wouldTrap: game.interaction.wouldTrapPlayer(px, py, pz)
      };
      gates.sameAsHeld = gates.existing === gates.blockIdOfHeldItem;
      refusal = { cell: [px, py, pz], gates };
    }
    return {
      ok, refusal,
      diagnosis: {
        player: { x: +player.x.toFixed(2), y: +player.y.toFixed(2), z: +player.z.toFixed(2) },
        blockBelow: game.world.getBlock(
          Math.floor(player.x), Math.floor(player.y) - 1, Math.floor(player.z)
        )
      },
      target: target ? { id: target.id, x: target.x, y: target.y, z: target.z } : null,
      placedDelta: ok ? 1 : 0,
      blocksPlacedDelta: player.blocksPlaced - before,
      heldNow: player.heldStack() ? player.heldStack().item : null,
      slot0: player.inventory.get(0),
      revision: player.inventory.revision
    };
  }, aimAgain || aim);
  log('place', `target=${JSON.stringify(placed.target)} diag=${JSON.stringify(placed.diagnosis)} tryPlace=${placed.ok} blocksPlaced+${placed.blocksPlacedDelta} heldNow=${placed.heldNow} slot0=${JSON.stringify(placed.slot0)} revision=${placed.revision}`);
  if (placed.refusal) log('refusal', JSON.stringify(placed.refusal));

  await sleep(400);
  await screenshot(page, 'hotbar-after-place');
  const after = await readHotbar();
  log('after place', `slot 0 icon=${after[0].hasIcon} count="${after[0].count}" title="${after[0].title}"`);

  // ---------------------------------------------------------------------
  // Also cover the second half of the report: a partial stack must show the
  // decremented count immediately, not the old one.
  // ---------------------------------------------------------------------
  const aimThird = await aimAtGround();
  const partial = await page.evaluate((aim) => {
    const game = window.__VOXELHAVEN__;
    const inv = game.player.inventory;
    inv.clear();
    inv.slots[0] = { item: 'cobble', count: 5 };
    game.player.selectedSlot = 0;
    game.hud.refreshHotbar(game.player);
    const displayedBefore = document.querySelector('#hotbar .slot .slot-count').textContent;
    if (aim) {
      game.camera.yaw = aim.yaw;
      game.camera.pitch = aim.pitch;
    }
    game.interaction.refreshTarget();
    const ok = game.interaction.tryPlace();
    return { ok, displayedBefore, nowCount: inv.get(0) ? inv.get(0).count : 0 };
  }, aimThird);
  await sleep(400);
  const partialAfter = await readHotbar();
  log('partial stack', `place=${partial.ok} displayed "${partial.displayedBefore}" -> inventory ${partial.nowCount}, hotbar now "${partialAfter[0].count}"`);

  // ---------------------------------------------------------------------
  // A third path that never announced anything either: tool wear.
  // ---------------------------------------------------------------------
  const wear = await page.evaluate(async () => {
    const game = window.__VOXELHAVEN__;
    const inv = game.player.inventory;
    inv.clear();
    inv.slots[0] = { item: 'stone_pickaxe', count: 1 };
    game.player.selectedSlot = 0;
    game.hud.refreshHotbar(game.player);
    const before = inv.revision;
    game.player.damageHeldTool(1);
    return { before, after: inv.revision, durability: inv.get(0) ? inv.get(0).durability : null };
  });
  log('tool wear', `revision ${wear.before} -> ${wear.after}, durability ${wear.durability}`);

  const checks = [];
  const check = (name, pass, detail) => {
    checks.push({ name, pass, detail });
    log(pass ? 'PASS' : 'FAIL', `${name}${detail ? ` — ${detail}` : ''}`);
  };

  check('the block was actually placed',
    placed.ok && placed.blocksPlacedDelta === 1,
    `tryPlace=${placed.ok}, blocksPlaced +${placed.blocksPlacedDelta}`);
  check('the stack was spent from the inventory',
    placed.slot0 === null,
    `slot 0 is now ${JSON.stringify(placed.slot0)}`);
  check('the hotbar slot was showing the block before placing',
    before[0].hasIcon && before[0].count === '',
    `icon=${before[0].hasIcon} count="${before[0].count}"`);
  check('the hotbar clears the icon as soon as the block is placed',
    after[0].hasIcon === false,
    `icon=${after[0].hasIcon} (false means the spent stack is gone from the hotbar)`);
  check('the hotbar clears the tooltip as soon as the block is placed',
    after[0].title === '',
    `title="${after[0].title}"`);
  check('a partial stack shows the decremented count',
    partialAfter[0].count === String(partial.nowCount) && partial.nowCount === 4,
    `displayed "${partialAfter[0].count}" for ${partial.nowCount} remaining`);
  check('tool wear bumps the inventory revision',
    wear.after > wear.before,
    `revision ${wear.before} -> ${wear.after}`);

  fs.mkdirSync(OUT, { recursive: true });
  const lines = ['# Hotbar refresh probe', ''];
  lines.push('Reproduces "after placing the last block, it stays in the hotbar for a');
  lines.push('little while" through the real `Interaction.tryPlace` path.', '');
  lines.push('| stage | slot 0 icon | slot 0 count | slot 0 title |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(`| before place | ${before[0].hasIcon} | "${before[0].count}" | "${before[0].title}" |`);
  lines.push(`| after place | ${after[0].hasIcon} | "${after[0].count}" | "${after[0].title}" |`);
  lines.push('');
  lines.push('| check | result | detail |');
  lines.push('| --- | --- | --- |');
  for (const c of checks) lines.push(`| ${c.name} | ${c.pass ? 'PASS' : 'FAIL'} | ${c.detail} |`);
  lines.push('');
  lines.push(`Console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}`);
  for (const e of consoleErrors) lines.push(`- console: ${e}`);
  for (const e of pageErrors) lines.push(`- page: ${e}`);
  fs.writeFileSync(path.join(OUT, 'hotbar-probe-report.md'), lines.join('\n'));

  const failed = checks.filter((c) => !c.pass);
  console.log('');
  console.log(`Hotbar probe: ${checks.length - failed.length}/${checks.length} checks passed`);
  if (failed.length) console.log(`FAILED: ${failed.map((c) => c.name).join(', ')}`);
} finally {
  await browser.close();
  await server.stop();
}
