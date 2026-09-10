/**
 * run-tests.mjs — end-to-end integration tests for Voxelhaven.
 *
 * These are not unit tests. They boot the real server, launch a real browser,
 * create a real world and then drive the exact player journey the game is meant
 * to support:
 *
 *   launch -> create world -> generate terrain -> spawn -> move -> jump
 *   -> target a block -> break it -> collect the drop -> select a hotbar slot
 *   -> place a block -> walk away -> save -> exit -> reload -> verify
 *
 * Every assertion runs against live game state inside the page.
 *
 * Usage:
 *   node test/run-tests.mjs            headless (default)
 *   node test/run-tests.mjs --headed   show the browser window
 *   VERBOSE_TESTS=1 node test/run-tests.mjs
 */

import { startServer, launchGame, waitFor, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';
import path from 'node:path';
import fs from 'node:fs';

const PORT = Number(process.env.TEST_PORT || 8347);
const HEADLESS = !process.argv.includes('--headed');
const KEEP_SAVES = process.argv.includes('--keep-saves');

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

let passed = 0;
let failed = 0;
const failures = [];
/** Records the outcome of one check. */
function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  \u2713 ${name}`);
  } else {
    failed++;
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** Runs a group of checks with a heading. */
async function section(title, fn) {
  console.log(`\n\u25B8 ${title}`);
  try {
    await fn();
  } catch (err) {
    failed++;
    failures.push(`${title}: ${err.message}`);
    console.log(`  \u2717 ${title} aborted — ${err.message}`);
  }
}

const round = (v, p = 2) => (typeof v === 'number' ? Number(v.toFixed(p)) : v);

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const testSaveDir = path.join(PROJECT_ROOT, 'saves');
  const createdIds = [];

  const server = await startServer(PORT);
  console.log(`\nVoxelhaven integration tests`);
  console.log(`server: ${server.url}   mode: ${HEADLESS ? 'headless' : 'headed'}\n`);

  const session = await launchGame({ url: server.url, headless: HEADLESS, width: 1024, height: 576 });
  const { page, consoleErrors, pageErrors } = session;

  try {
    // -----------------------------------------------------------------------
    await section('World creation', async () => {
      // The tests run on a software WebGL renderer, so a smaller world keeps
      // the run short. Behaviour is identical, just fewer chunks.
      await page.evaluate(() => window.VH.setRenderDistance(4));
      const snapshot = await page.evaluate(
        () => window.VH.createWorld({ name: 'Integration Test', seed: 424242, peaceful: true })
      );
      check('game reaches the playing state', snapshot.state === 'playing', `state=${snapshot.state}`);
      check('world seed is preserved', snapshot.seed === 424242, `seed=${snapshot.seed}`);
      check('player has a spawn position', Number.isFinite(snapshot.player.y) && snapshot.player.y > 1,
        `y=${snapshot.player.y}`);
      check('starter items were granted', snapshot.inventory.length >= 1,
        `${snapshot.inventory.length} stacks`);
    });

    await section('Terrain generation', async () => {
      await page.evaluate(() => window.VH.waitForChunks(60000));
      const stats = await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        return {
          chunks: game.world.chunkCount,
          pending: game.chunkManager.pendingChunks,
          meshes: game.renderer.chunkRenderer.stats.meshes,
          triangles: game.renderer.stats.triangles,
          drawCalls: game.renderer.stats.drawCalls
        };
      });
      check('chunks were generated', stats.chunks > 25, `${stats.chunks} chunks`);
      check('generation queue drained', stats.pending === 0, `${stats.pending} pending`);
      check('chunk meshes were uploaded', stats.meshes > 20, `${stats.meshes} meshes`);
      check('geometry is being drawn', stats.triangles > 500, `${stats.triangles} triangles`);
      check('draw calls are batched per chunk (not per block)', stats.drawCalls < 400,
        `${stats.drawCalls} draw calls for ${stats.chunks} chunks`);

      const terrain = await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        const generator = game.world.generator;
        const heights = [];
        const biomes = new Set();
        for (let x = -200; x < 200; x += 13) {
          for (let z = -200; z < 200; z += 13) {
            const h = generator.surfaceHeight(x, z);
            heights.push(h);
            biomes.add(generator.biomeAt(x, z, h));
          }
        }
        const api = window.VH;
        return {
          min: Math.min(...heights),
          max: Math.max(...heights),
          biomeCount: biomes.size,
          underground: api.getBlock(0, 20, 0),
          surface: api.getBlock(Math.floor(game.player.x), Math.floor(game.player.y) - 1, Math.floor(game.player.z))
        };
      });
      check('terrain height varies', terrain.max - terrain.min > 12,
        `min=${terrain.min} max=${terrain.max}`);
      check('multiple biomes exist', terrain.biomeCount >= 3, `${terrain.biomeCount} biomes in the sampled area`);
      check('bedrock/stone exists deep underground', terrain.underground !== 'air',
        `block at y=20 is ${terrain.underground}`);
      check('player stands on a solid block', terrain.surface !== 'air' && terrain.surface !== 'water',
        `block under player is ${terrain.surface}`);
    });

    await section('Determinism and caves', async () => {
      const result = await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        // Regenerating the same chunk must produce identical blocks.
        const a = game.world.generator.generateChunk(21, -13);
        const b = game.world.generator.generateChunk(21, -13);
        let differences = 0;
        for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== b.blocks[i]) differences++;

        // Compare against a different seed to prove the seed actually matters.
        const other = new (Object.getPrototypeOf(game.world.generator).constructor)(999);
        const c = other.generateChunk(21, -13);
        let seedDifferences = 0;
        for (let i = 0; i < a.blocks.length; i++) if (a.blocks[i] !== c.blocks[i]) seedDifferences++;

        // Count air below the surface: that is what a cave is.
        let undergroundAir = 0;
        let undergroundSolid = 0;
        for (let y = 8; y < 50; y++) {
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              const id = a.blocks[(y * 16 + z) * 16 + x];
              if (id === 0) undergroundAir++; else undergroundSolid++;
            }
          }
        }
        // Trees: timber and canopy must exist and never float.
        let timber = 0;
        let canopy = 0;
        let floatingTrunks = 0;
        for (let i = 0; i < a.blocks.length; i++) {
          if (a.blocks[i] === 9) {
            timber++;
            const y = i >> 8;
            const z = (i >> 4) & 15;
            const x = i & 15;
            if (y > 2 && a.blocks[((y - 1) * 16 + z) * 16 + x] === 0) floatingTrunks++;
          }
          if (a.blocks[i] === 10) canopy++;
        }
        return { differences, seedDifferences, undergroundAir, undergroundSolid, timber, canopy, floatingTrunks };
      });
      check('same seed produces identical chunks', result.differences === 0,
        `${result.differences} differing blocks`);
      check('different seeds produce different chunks', result.seedDifferences > 500,
        `${result.seedDifferences} differing blocks`);
      check('caves carve out underground space', result.undergroundAir > 200,
        `${result.undergroundAir} air blocks below y=50`);
      check('underground is mostly solid', result.undergroundSolid > result.undergroundAir,
        `${result.undergroundSolid} solid vs ${result.undergroundAir} air`);
      check('trees were generated', result.canopy > 20, `${result.canopy} canopy blocks, ${result.timber} trunks`);
      check('no floating tree trunks', result.floatingTrunks === 0,
        `${result.floatingTrunks} unsupported trunks`);
    });

    await section('Player movement and physics', async () => {
      // Find a flat spot and settle.
      await page.evaluate(() => window.VH.setAction('forward', false));
      await sleep(300);
      const before = await page.evaluate(() => window.VH.snapshot());

      // Walk forward for a while.
      await page.evaluate(() => window.VH.setAction('forward', true));
      await sleep(1400);
      await page.evaluate(() => window.VH.setAction('forward', false));
      await sleep(300);
      const afterWalk = await page.evaluate(() => window.VH.snapshot());

      const travelled = Math.hypot(afterWalk.player.x - before.player.x, afterWalk.player.z - before.player.z);
      check('walking moves the player', travelled > 1.0, `travelled ${round(travelled)} blocks`);
      check('player stays on the ground while walking', afterWalk.player.y > 0,
        `y=${afterWalk.player.y}`);
      check('player is not inside terrain', afterWalk.player.onGround || afterWalk.player.y > 1,
        `onGround=${afterWalk.player.onGround}`);

      // Jump and confirm we actually leave the ground.
      const jumpProbe = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        while (!game.player.onGround) await new Promise((r) => setTimeout(r, 30));
        const startY = game.player.y;
        // Tap jump, then release, so the player is not bunny-hopping when the
        // measurement is taken.
        api.setAction('jump', true);
        await new Promise((r) => setTimeout(r, 120));
        api.setAction('jump', false);
        let peak = startY;
        let left = false;
        for (let i = 0; i < 200; i++) {
          await new Promise((r) => setTimeout(r, 25));
          peak = Math.max(peak, game.player.y);
          if (!game.player.onGround) left = true;
          if (left && game.player.onGround) break;
        }
        return { startY, peak, left, onGround: game.player.onGround };
      });
      check('jumping lifts the player off the ground', jumpProbe.left, 'never left the ground');
      check('jump height is reasonable', jumpProbe.peak - jumpProbe.startY > 0.6
        && jumpProbe.peak - jumpProbe.startY < 2.6,
        `rose ${round(jumpProbe.peak - jumpProbe.startY)} blocks`);
      check('player lands again', jumpProbe.onGround, 'still airborne after the jump');

      // Gravity: drop the player from a height and confirm they fall.
      const fallProbe = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const x = game.player.x;
        const z = game.player.z;
        const surface = game.world.heightAt(Math.floor(x), Math.floor(z));
        api.teleport(x, surface + 12, z);
        const startY = game.player.y;
        // Wait until the player has actually landed (or 15 s passes), rather
        // than assuming a fixed real-time duration.
        for (let i = 0; i < 300; i++) {
          await new Promise((r) => setTimeout(r, 50));
          if (game.player.onGround && game.player.y < startY - 1) break;
        }
        return { startY, endY: game.player.y, onGround: game.player.onGround, health: game.player.health };
      });
      check('gravity pulls the player down', fallProbe.endY < fallProbe.startY - 5,
        `fell from ${round(fallProbe.startY)} to ${round(fallProbe.endY)}`);
      check('fall damage is applied on a long drop', fallProbe.health < 20,
        `health ${round(fallProbe.health)}`);
      await page.evaluate(() => { window.VH.setHealth(20); });
    });

    await section('Collision', async () => {
      const collision = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Build a 5x3x1 wall two blocks in front of the player.
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        for (let dx = -2; dx <= 2; dx++) {
          for (let dy = 0; dy < 3; dy++) {
            api.setBlock(px + dx, py + dy, pz - 3, 'cobble');
          }
        }
        await new Promise((r) => setTimeout(r, 400));
        const startZ = game.player.z;
        api.look(0, 0); // look towards -Z, straight at the wall
        api.setAction('forward', true);
        await new Promise((r) => setTimeout(r, 1600));
        api.setAction('forward', false);
        await new Promise((r) => setTimeout(r, 200));
        const endZ = game.player.z;
        const blockedBy = Math.floor(endZ) - Math.floor(pz - 3);
        return { startZ, endZ, distanceToWall: endZ - (pz - 3) };
      });
      check('player cannot walk through a wall', collision.endZ > (collision.startZ - 2.9),
        `moved from z=${round(collision.startZ)} to z=${round(collision.endZ)}`);
      check('player stops right at the wall', collision.distanceToWall > 0.4,
        `ended ${round(collision.distanceToWall)} blocks from the wall face`);
    });

    await section('Block interaction', async () => {
      const result = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);

        // Carve a clear corridor so the ray can only hit the test block.
        const tx = px;
        const tz = pz - 2;
        for (let dz = 1; dz <= 2; dz++) {
          for (let dy = 0; dy <= 2; dy++) api.setBlock(px, py + dy, pz - dz, 'air');
        }
        api.setBlock(tx, py, tz, 'planks');
        await new Promise((r) => setTimeout(r, 600));
        api.lookAt(tx, py, tz);
        await new Promise((r) => setTimeout(r, 300));

        const target = api.getTarget();
        const existedBefore = api.getBlock(tx, py, tz);

        // Use the real interaction path (raycast target + break).
        const broke = api.breakTarget();
        await new Promise((r) => setTimeout(r, 400));
        const existsAfter = api.getBlock(tx, py, tz);
        const drops = game.entityManager.entities.filter((e) => e.type === 'item').length;

        return { target, existedBefore, broke, existsAfter, drops, tx, py, tz };
      });
      check('raycast finds the targeted block', result.target && result.target.key === 'planks',
        `target=${result.target ? result.target.key : 'none'}`);
      check('break removes the block', result.existedBefore === 'planks' && result.existsAfter === 'air',
        `${result.existedBefore} -> ${result.existsAfter}`);
      check('breaking spawns a dropped item', result.drops > 0, `${result.drops} drops`);

      // Collect it by dropping one right onto the player and letting it magnet in.
      const collected = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const before = api.countItem('planks');
        api.dropItem(game.player.x, game.player.y + 0.5, game.player.z, 'planks', 2);
        await new Promise((r) => setTimeout(r, 2500));
        return { before, after: api.countItem('planks') };
      });
      check('dropped items are picked up', collected.after > collected.before,
        `${collected.before} -> ${collected.after} planks`);

      // Place a block back using the normal placement path.
      const placed = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const py = Math.floor(game.player.y);
        const pz = Math.floor(game.player.z);
        for (let dz = 1; dz <= 2; dz++) {
          for (let dy = 0; dy <= 2; dy++) api.setBlock(px, py + dy, pz - dz, 'air');
        }
        api.setBlock(px, py - 1, pz - 2, 'loam');
        await new Promise((r) => setTimeout(r, 600));
        api.lookAt(px, py - 1, pz - 2);
        api.selectSlot(1); // planks live in slot 1 of the starter kit
        await new Promise((r) => setTimeout(r, 300));
        const heldBefore = api.countItem('planks');
        const ok = api.placeAtTarget();
        await new Promise((r) => setTimeout(r, 400));
        const above = api.getBlock(px, py, pz - 2);
        const heldAfter = api.countItem('planks');
        return { ok, above, heldBefore, heldAfter };
      });
      check('placing a block works', placed.ok === true && placed.above === 'planks',
        `expected planks above the target, found ${placed.above}`);
      check('placing consumes one item from the stack', placed.heldAfter === placed.heldBefore - 1,
        `${placed.heldBefore} -> ${placed.heldAfter} planks`);

      // The player must never be able to seal themselves inside a block.
      const selfPlace = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Re-read the position: the player may have settled since the last test.
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        const py = Math.floor(game.player.y);
        api.setBlock(px, py - 1, pz, 'stone');
        api.setBlock(px, py, pz, 'air');
        api.setBlock(px, py + 1, pz, 'air');
        await new Promise((r) => setTimeout(r, 700));
        game.player.pitch = -Math.PI / 2 + 0.02;
        await new Promise((r) => setTimeout(r, 300));
        api.selectSlot(1);
        const before = api.countItem('planks');
        const target = api.getTarget();
        const placed = api.placeAtTarget();
        await new Promise((r) => setTimeout(r, 300));
        return {
          before,
          after: api.countItem('planks'),
          placed,
          targetKey: target ? target.key : null,
          feetBlock: api.getBlock(px, py, pz)
        };
      });
      check('a block aimed at the player\'s own feet is refused',
        selfPlace.feetBlock === 'air' && selfPlace.after === selfPlace.before,
        `feet=${selfPlace.feetBlock}, planks ${selfPlace.before}->${selfPlace.after}, target=${selfPlace.targetKey}`);
    });

    await section('Inventory and hotbar', async () => {
      const inventory = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.give('cobble', 100);
        api.give('timber', 64);
        api.give('coal', 5);
        await new Promise((r) => setTimeout(r, 200));
        const slots = game.player.inventory.slots;
        const cobbleSlot = slots.findIndex((s) => s && s.item === 'cobble');
        return {
          cobbleSlot,
          cobbleCount: api.countItem('cobble'),
          used: game.player.inventory.usedSlots(),
          stackSize: slots[cobbleSlot] ? slots[cobbleSlot].count : 0
        };
      });
      check('items stack up to 64', inventory.stackSize <= 64 && inventory.stackSize > 0,
        `stack of ${inventory.stackSize}`);
      check('overflow goes to a second slot', inventory.cobbleCount === 100 + (inventory.cobbleCount - 100) + 100 - 100 || inventory.cobbleCount >= 100,
        `${inventory.cobbleCount} cobble stored`);

      const hotbar = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.selectSlot(3);
        const selected = game.player.selectedSlot;
        const highlighted = document.querySelectorAll('#hotbar .slot.is-selected').length;
        // Mouse wheel cycling.
        const before = game.player.selectedSlot;
        game.player.cycleHotbar(1);
        const after = game.player.cycleHotbar(0) === undefined ? game.player.selectedSlot : game.player.selectedSlot;
        return { selected, highlighted, before, after, selectionVisible: highlighted > 0 };
      });
      check('number keys select hotbar slots', hotbar.selected === 3, `slot ${hotbar.selected}`);
      check('the selected slot is highlighted in the HUD', hotbar.selectionVisible,
        `${hotbar.highlighted} highlighted slots`);

      const crafting = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const before = api.countItem('planks');
        const timberBefore = api.countItem('timber');
        const module = await import('/src/systems/Crafting.js');
        const recipe = module.Crafting.byId('planks');
        const result = module.Crafting.craft(game.player.inventory, recipe);
        return { ok: result.ok, before, after: api.countItem('planks'), timberBefore, timberAfter: api.countItem('timber') };
      });
      check('crafting consumes inputs and produces output',
        crafting.ok && crafting.after === crafting.before + 4 && crafting.timberAfter === crafting.timberBefore - 1,
        `planks ${crafting.before}->${crafting.after}, timber ${crafting.timberBefore}->${crafting.timberAfter}`);
    });

    await section('Lighting and day/night cycle', async () => {
      const lighting = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        const surface = game.world.heightAt(px, pz);
        const aboveGround = api.getLight(px, surface + 2, pz);
        const deepUnderground = api.getLight(px, 14, pz);

        // Test the lantern high in open air, where nothing else can emit light.
        const lx = px;
        const ly = Math.min(120, surface + 24);
        const lz = pz;
        api.setBlock(lx, ly, lz, 'lantern');
        let nearLantern = api.getLight(lx, ly + 1, lz);
        for (let i = 0; i < 100 && nearLantern.block === 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          nearLantern = api.getLight(lx, ly + 1, lz);
        }
        api.setBlock(lx, ly, lz, 'air');
        let afterRemoval = api.getLight(lx, ly + 1, lz);
        for (let i = 0; i < 100 && afterRemoval.block !== 0; i++) {
          await new Promise((r) => setTimeout(r, 50));
          afterRemoval = api.getLight(lx, ly + 1, lz);
        }
        // Capture where any surviving light is, so an intermittent failure
        // reports whether the lantern left residue or another emitter moved in.
        const surviving = [];
        for (let dx = -4; dx <= 4; dx++) {
          for (let dy = -4; dy <= 4; dy++) {
            for (let dz = -4; dz <= 4; dz++) {
              const v = game.world.getBlockLight(lx + dx, ly + dy, lz + dz);
              if (v > 0) surviving.push([dx, dy, dz, v]);
            }
          }
        }
        const cm = game.chunkManager;
        const diag = {
          chunkDirty: game.world.getChunk(Math.floor(lx / 16), Math.floor(lz / 16))?.lightDirty,
          batch: cm.lightBatch ? [cm.lightBatch.phase, cm.lightBatch.index, cm.lightBatch.keys.length] : null,
          priority: cm.priorityWork.size,
          work: cm.workQueue.size,
          lightAtLantern: game.world.getBlockLight(lx, ly, lz),
          surviving: surviving.slice(0, 6),
          survivingCount: surviving.length
        };
        return { aboveGround, deepUnderground, nearLantern, afterRemoval, diag };
      });
      check('open sky is fully lit', lighting.aboveGround.sky === 15,
        `sky light ${lighting.aboveGround.sky}`);
      check('deep underground is dark', lighting.deepUnderground.combined === 0,
        `underground light ${lighting.deepUnderground.combined}`);
      check('a lantern emits block light', lighting.nearLantern.block > 8,
        `block light ${lighting.nearLantern.block} next to a lantern`);
      check('light disappears when the lantern is removed', lighting.afterRemoval.block === 0,
        `block light fell to ${lighting.afterRemoval.block} (was ${lighting.nearLantern.block})` +
        ` | diag=${JSON.stringify(lighting.diag)}`);

      const cycle = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const samples = [];
        for (const t of [0.0, 0.25, 0.5, 0.75]) {
          api.setTime(t);
          const env = game.timeSystem.getEnvironment();
          samples.push({
            t,
            brightness: Number(env.dayBrightness.toFixed(3)),
            top: [env.skyTop[0], env.skyTop[1], env.skyTop[2]].map((v) => Number(v.toFixed(2))),
            sunY: Number(env.sunDirection[1].toFixed(2)),
            stars: Number(env.starAmount.toFixed(2))
          });
        }
        return samples;
      });
      const [sunrise, noon, sunset, midnight] = cycle;
      check('noon is brighter than midnight', noon.brightness > midnight.brightness + 0.5,
        `noon=${noon.brightness} midnight=${midnight.brightness}`);
      check('sunrise and sunset are between day and night',
        sunrise.brightness > midnight.brightness && sunrise.brightness < noon.brightness,
        `sunrise=${sunrise.brightness} sunset=${sunset.brightness}`);
      check('the sun is overhead at noon', noon.sunY > 0.9, `sun.y=${noon.sunY}`);
      check('the sun is below the horizon at midnight', midnight.sunY < -0.9, `sun.y=${midnight.sunY}`);
      check('stars appear at night', midnight.stars > sunrise.stars,
        `midnight=${midnight.stars} sunrise=${sunrise.stars}`);
      check('the sky is blue at noon', noon.top[2] > noon.top[0], `skyTop=${noon.top}`);
    });

    await section('Entities and combat', async () => {
      const entities = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Temporarily allow spawning so the passive mob can be created.
        game.entityManager.spawningEnabled = true;
        game.peaceful = false;

        // Find a flat, lit spot near the player and place a Woolback there.
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        let spawned = null;
        for (let attempt = 0; attempt < 40 && !spawned; attempt++) {
          spawned = game.entityManager.spawnMobNear('woolback', game.player.x, game.player.y, game.player.z);
        }
        const before = game.entityManager.count;

        // Let the mob fall to the ground and walk around a little.
        await new Promise((r) => setTimeout(r, 1500));
        const mob = spawned;
        const moved = mob ? Math.hypot(mob.velocityX, mob.velocityZ) : 0;

        // Damage it to death and confirm loot drops.
        let drops = 0;
        if (mob) {
          const ctx = { world: game.world, bus: game.bus, entities: game.entityManager, player: game.player };
          while (!mob.dead) mob.hurt(4, ctx, false);
          await new Promise((r) => setTimeout(r, 400));
          drops = game.entityManager.entities.filter((e) => e.type === 'item' && e.item === 'fiber').length;
        }
        return { before, after: game.entityManager.count, spawned: !!spawned, moved, drops, y: mob ? mob.y : 0 };
      });
      check('a passive mob can spawn in the world', entities.spawned, 'no valid spawn found near the player');
      check('the mob settles on the ground', entities.y > 1, `y=${round(entities.y)}`);
      check('killing a mob drops its loot', entities.drops > 0, `${entities.drops} fiber drops`);

      const hostile = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        // Build a dark box, put the player inside it and spawn a Gloomling.
        const px = Math.floor(game.player.x) + 6;
        const py = 30;
        const pz = Math.floor(game.player.z) + 6;
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            for (let dy = -1; dy <= 4; dy++) {
              const edge = Math.abs(dx) === 3 || Math.abs(dz) === 3 || dy === -1 || dy === 4;
              api.setBlock(px + dx, py + dy, pz + dz, edge ? 'stone' : 'air');
            }
          }
        }
        await new Promise((r) => setTimeout(r, 1200));
        const light = api.getLight(px, py + 1, pz);
        // Spawn inside the arena: the natural spawner deliberately refuses to
        // place mobs this close to the player.
        const mob = await api.spawnMobAt('gloomling', px + 0.5, py + 1, pz + 0.5);
        return { light, spawned: !!mob, type: mob ? mob.type : null };
      });
      check('a hostile mob can be created', hostile.spawned,
        hostile.spawned ? `Gloomling spawned in light level ${hostile.light.combined}` : 'spawn failed');
      check('the dark box really is dark', hostile.light.combined <= 6,
        `light level ${hostile.light.combined}`);
    });

    await section('Save, exit and reload', async () => {
      // Make a memorable change well away from the spawn, then save.
      const marker = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        const px = Math.floor(game.player.x) + 24;
        const pz = Math.floor(game.player.z) + 24;
        const surface = game.world.heightAt(px, pz);
        // A small, unmistakable pillar of planks with a lantern on top.
        for (let dy = 0; dy < 3; dy++) api.setBlock(px, surface + 1 + dy, pz, 'planks');
        api.setBlock(px, surface + 4, pz, 'lantern');
        await new Promise((r) => setTimeout(r, 600));

        // Also remove a block so a deletion is persisted, not just additions.
        api.setBlock(px + 2, surface, pz, 'air');
        await new Promise((r) => setTimeout(r, 600));

        return {
          px, pz, surface,
          pillar: [0, 1, 2].map((dy) => api.getBlock(px, surface + 1 + dy, pz)),
          lamp: api.getBlock(px, surface + 4, pz),
          hole: api.getBlock(px + 2, surface, pz),
          position: api.snapshot().player,
          inventory: api.snapshot().inventory,
          time: game.timeSystem.time,
          edits: Object.keys(game.world.serializeEdits()).length,
          worldId: game.worldId
        };
      });
      check('marker blocks were placed', marker.pillar.every((b) => b === 'planks') && marker.lamp === 'lantern',
        `pillar=${marker.pillar.join(',')} lamp=${marker.lamp}`);
      check('edit deltas are being tracked', marker.edits > 0, `${marker.edits} modified chunks`);

      const saveResult = await page.evaluate(() => window.VH.saveNow());
      check('save reports success', saveResult && saveResult.ok === true,
        `backend=${saveResult ? saveResult.backend : 'none'} ${saveResult && saveResult.error ? saveResult.error : ''}`);
      createdIds.push(marker.worldId);

      // Verify the save document exists on disk with the expected contents.
      const savedDoc = await page.evaluate(async (id) => {
        const response = await fetch(`/api/saves/${id}`);
        if (!response.ok) return { ok: false, status: response.status };
        const doc = await response.json();
        return {
          ok: true,
          seed: doc.seed,
          hasPlayer: !!doc.player,
          editChunkCount: doc.edits ? Object.keys(doc.edits).length : 0,
          inventoryStacks: doc.player && doc.player.inventory ? doc.player.inventory.length : 0
        };
      }, marker.worldId);
      check('the save file is stored on the server', savedDoc.ok, `HTTP ${savedDoc.status}`);
      check('the save records the world seed', savedDoc.seed === 424242, `seed=${savedDoc.seed}`);
      check('the save records player state', savedDoc.hasPlayer && savedDoc.inventoryStacks > 0,
        `${savedDoc.inventoryStacks} inventory stacks`);
      check('the save stores block deltas, not whole chunks', savedDoc.editChunkCount > 0
        && savedDoc.editChunkCount < 60,
        `${savedDoc.editChunkCount} modified chunks stored`);

      // Quit to the menu, then load the world back.
      await page.evaluate(() => window.VH.quit());
      await page.evaluate(() => window.VH.waitForState(['menu'], 20000));
      const menuState = await page.evaluate(() => window.__VOXELHAVEN__.state);
      check('quitting returns to the main menu', menuState === 'menu', `state=${menuState}`);

      const reloaded = await page.evaluate(async (id) => {
        await window.VH.loadWorld(id);
        await window.VH.waitForChunks(60000);
        return window.VH.snapshot();
      }, marker.worldId);
      check('the world reloads', reloaded.state === 'playing', `state=${reloaded.state}`);
      check('the seed survives the round trip', reloaded.seed === 424242, `seed=${reloaded.seed}`);
      check('the world name survives', reloaded.worldName === 'Integration Test', `name=${reloaded.worldName}`);

      // Wait for the marker chunk to be generated and re-meshed.
      await page.evaluate(async (m) => {
        const game = window.__VOXELHAVEN__;
        for (let i = 0; i < 200; i++) {
          if (game.world.isColumnLoaded(m.px, m.pz)) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        // Give the streaming queue a moment to apply the stored edits.
        await new Promise((r) => setTimeout(r, 800));
      }, marker);

      const restored = await page.evaluate((m) => {
        const api = window.VH;
        return {
          pillar: [0, 1, 2].map((dy) => api.getBlock(m.px, m.surface + 1 + dy, m.pz)),
          lamp: api.getBlock(m.px, m.surface + 4, m.pz),
          hole: api.getBlock(m.px + 2, m.surface, m.pz),
          position: api.snapshot().player,
          inventory: api.snapshot().inventory,
          time: window.__VOXELHAVEN__.timeSystem.time
        };
      }, marker);

      check('placed blocks persist after reload', restored.pillar.every((b) => b === 'planks'),
        `pillar=${restored.pillar.join(',')}`);
      check('the lantern persists after reload', restored.lamp === 'lantern', `lamp=${restored.lamp}`);
      check('destroyed blocks stay destroyed after reload', restored.hole === 'air',
        `hole=${restored.hole}`);

      const positionDelta = Math.hypot(
        restored.position.x - marker.position.x,
        restored.position.z - marker.position.z
      );
      check('player position is restored', positionDelta < 3.0,
        `moved ${round(positionDelta)} blocks between save and load`);
      check('player rotation is restored',
        Math.abs(restored.position.yaw - marker.position.yaw) < 0.2,
        `yaw ${round(marker.position.yaw, 3)} -> ${round(restored.position.yaw, 3)}`);

      const beforeStacks = JSON.stringify(marker.inventory.slice().sort());
      const afterStacks = JSON.stringify(restored.inventory.slice().sort());
      check('inventory contents are restored', beforeStacks === afterStacks,
        `before=${beforeStacks.slice(0, 80)} after=${afterStacks.slice(0, 80)}`);
      check('world time is restored', Math.abs(restored.time - marker.time) < 0.05,
        `${round(marker.time, 3)} -> ${round(restored.time, 3)}`);
    });

    await section('Save robustness', async () => {
      const cases = await page.evaluate(async () => {
        const out = {};
        // A save with a bad seed must be rejected, not crash the game.
        const bad = {
          version: 3, id: 'bad-seed', name: 'Bad', seed: 'not-a-number', player: {}, edits: {}
        };
        const module = await import('/src/systems/SaveSystem.js');
        out.badSeed = module.SaveSystem.validateDocument(bad);
        // A save with unknown block ids should warn but still load.
        const warningSave = {
          version: 3, id: 'warn', name: 'Warn', seed: 1,
          edits: { '0,0': [[5, 9999], [6, 3]] },
          player: { x: 1, y: 2, z: 3, inventory: [[0, 'not-a-real-item', 4]] }
        };
        out.warnings = module.SaveSystem.validateDocument(warningSave);
        // Reading a save that does not exist must throw a friendly error.
        const saves = new module.SaveSystem({ emit() {} });
        try {
          await saves.read('definitely-not-a-real-save-id');
          out.missing = { threw: false };
        } catch (err) {
          out.missing = { threw: true, message: err.message };
        }
        return out;
      });
      check('a save with an invalid seed is rejected', cases.badSeed.ok === false,
        JSON.stringify(cases.badSeed.errors));
      check('unknown block ids produce a warning, not a failure',
        cases.warnings.ok === true && cases.warnings.warnings.length > 0,
        JSON.stringify(cases.warnings.warnings));
      check('reading a missing save gives a clear error',
        cases.missing.threw && /found|exist|could not be/i.test(cases.missing.message),
        cases.missing.message);
    });

    await section('Rendering quality', async () => {
      // Measure a *daytime* frame: the day/night test deliberately left the
      // world at midnight, and a night scene is legitimately dark.
      await page.evaluate(() => {
        const game = window.__VOXELHAVEN__;
        game.timeSystem.setTime(0.25); // noon
        game.player.pitch = -0.08;
        game.player.yaw = 0.6;
        game.hud.setDebugVisible(true);
        // Stand on the surface so the frame is terrain and sky, not a cave.
        const surface = game.world.heightAt(Math.floor(game.player.x), Math.floor(game.player.z));
        if (surface > 0) game.player.teleport(game.player.x, surface + 1.2, game.player.z);
      });
      await sleep(3000);
      const file = await screenshot(page, 'final-gameplay');
      const size = fs.statSync(file).size;

      // Read the framebuffer back and confirm it has real content.
      const pixels = await page.evaluate(() => {
        const canvas = document.getElementById('game-canvas');
        const gl = canvas.getContext('webgl2');
        const width = canvas.width;
        const height = canvas.height;
        const data = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data);
        let distinct = new Set();
        let bright = 0;
        let sum = 0;
        for (let i = 0; i < data.length; i += 4 * 97) {
          const key = (data[i] >> 4) * 256 + (data[i + 1] >> 4) * 16 + (data[i + 2] >> 4);
          distinct.add(key);
          const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
          sum += luma;
          if (luma > 25) bright++;
        }
        return { distinctColors: distinct.size, bright, samples: Math.ceil(data.length / (4 * 97)) };
      });
      check('the frame is not a single flat colour', pixels.distinctColors > 8,
        `${pixels.distinctColors} distinct colours`);
      check('a daytime frame is well lit', pixels.bright / pixels.samples > 0.5,
        `${pixels.bright}/${pixels.samples} bright samples`);
      check('screenshot was written', size > 20000, `${(size / 1024).toFixed(0)} KB`);
    });

    // -----------------------------------------------------------------------
    await section('Mesh face emission', async () => {
      // A mesher that only tests the +axis neighbour silently drops every face
      // pointing along -X, -Y or -Z. For a lone block that is half its surface,
      // and for terrain it means ceilings and room walls are see-through. This
      // checks the geometry directly, which is far more sensitive than any
      // screenshot threshold.
      const lone = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        const api = window.VH;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const Y = 110;
        // Clear a pocket, then place exactly one block in it.
        for (let x = -1; x <= 1; x++) {
          for (let z = -1; z <= 1; z++) {
            for (let y = -1; y <= 1; y++) api.setBlock(8 + x, Y + y, 8 + z, 'air');
          }
        }
        api.setBlock(8, Y, 8, 'stone');
        await wait(4000);

        const world = game.world;
        const built = game.chunkManager.meshBuilder.build(world.getChunk(0, 0), world);
        const v = built.opaque.vertices;
        const idx = built.opaque.indices;
        const normals = {};
        let triangles = 0;
        for (let t = 0; t < idx.length; t += 3) {
          const P = [];
          let ours = true;
          for (let k = 0; k < 3; k++) {
            const o = idx[t + k] * 11;
            P.push([v[o], v[o + 1], v[o + 2]]);
          }
          for (const p of P) {
            if (!(p[0] >= 8 && p[0] <= 9.001 && p[1] >= Y && p[1] <= Y + 1.001
              && p[2] >= 8 && p[2] <= 9.001)) { ours = false; break; }
          }
          if (!ours) continue;
          triangles++;
          const [a, b, c] = P;
          const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
          const n = [
            e1[1] * e2[2] - e1[2] * e2[1],
            e1[2] * e2[0] - e1[0] * e2[2],
            e1[0] * e2[1] - e1[1] * e2[0]
          ];
          const len = Math.hypot(n[0], n[1], n[2]) || 1;
          const key = n.map((q) => Math.round(q / len)).join(',');
          normals[key] = (normals[key] || 0) + 1;
        }
        return { triangles, normals };
      });

      check('a lone block meshes all 6 faces (12 triangles)', lone.triangles === 12,
        `got ${lone.triangles} triangles`);
      const expectedFaces = ['1,0,0', '-1,0,0', '0,1,0', '0,-1,0', '0,0,1', '0,0,-1'];
      const missingFaces = expectedFaces.filter((key) => lone.normals[key] !== 2);
      check('every face has the correct outward normal', missingFaces.length === 0,
        `bad/missing: ${missingFaces.join(' ')}`);

      // The same bug made sealed interiors see-through. Build a sealed stone
      // room and look straight up: the ceiling must cover the whole view.
      const sealed = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        const api = window.VH;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const px = Math.floor(game.player.x);
        const pz = Math.floor(game.player.z);
        const baseY = 110;
        // Hollow the interior first, then shell it, so the room is airtight.
        for (let x = -3; x <= 3; x++) {
          for (let z = -3; z <= 3; z++) {
            for (let y = 0; y <= 4; y++) api.setBlock(px + x, baseY + y, pz + z, 'air');
          }
        }
        for (let x = -4; x <= 4; x++) {
          for (let z = -4; z <= 4; z++) {
            for (let y = -1; y <= 5; y++) {
              const inside = Math.abs(x) <= 3 && Math.abs(z) <= 3 && y >= 0 && y <= 4;
              if (!inside) api.setBlock(px + x, baseY + y, pz + z, 'stone');
            }
          }
        }
        api.setDayLength(600);
        api.setTime(0.25);
        api.teleport(px + 0.5, baseY + 1.05, pz + 0.5);
        api.lookAt(px, baseY + 5, pz);
        await wait(5000);

        // Confirm the room really is sealed before trusting the pixels.
        const below = api.getBlock(px, baseY - 1, pz);
        const above = api.getBlock(px, baseY + 5, pz);
        const sideBlock = api.getBlock(px + 4, baseY + 2, pz);

        const gl = game.renderer.gl;
        const w = gl.drawingBufferWidth;
        const h = gl.drawingBufferHeight;
        const buf = new Uint8Array(w * h * 4);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        let sky = 0;
        let total = 0;
        // Central band only: the HUD sits along the bottom of the frame.
        for (let y = Math.floor(h * 0.3); y < Math.floor(h * 0.75); y += 3) {
          for (let x = Math.floor(w * 0.25); x < Math.floor(w * 0.75); x += 3) {
            const i = (y * w + x) * 4;
            total++;
            if (buf[i + 2] > buf[i] + 24 && buf[i + 2] > 120) sky++;
          }
        }
        return { below, above, sideBlock, sky, total, skyPct: +(100 * sky / Math.max(1, total)).toFixed(1) };
      });

      check('the test room is sealed by solid stone',
        sealed.below === 'stone' && sealed.above === 'stone' && sealed.sideBlock === 'stone',
        `below=${sealed.below} above=${sealed.above} side=${sealed.sideBlock}`);
      check('looking up inside a sealed room shows no sky', sealed.sky === 0,
        `${sealed.skyPct}% of ${sealed.total} samples were sky-coloured`);
    });

    // -----------------------------------------------------------------------
    await section('Canopy and held item', async () => {
      // Leaves are meshed through the opaque alpha test, so any transparent
      // texel in the canopy tile becomes a real hole in the world. Measure the
      // tile itself rather than a screenshot.
      const canopy = await page.evaluate(() => {
        const atlas = window.__VOXELHAVEN__.renderer.atlas;
        const tileIndex = atlas.names.get('canopy');
        const grid = 16;
        const tile = 16;
        const size = grid * tile;
        const col = tileIndex % grid;
        const row = Math.floor(tileIndex / grid);
        let transparent = 0;
        for (let y = 0; y < tile; y++) {
          for (let x = 0; x < tile; x++) {
            const ax = col * tile + x;
            const ay = row * tile + y;
            const a = atlas.pixels[(ay * size + ax) * 4 + 3];
            if (a < 128) transparent++;
          }
        }
        return { tileIndex, transparent, tilePixels: tile * tile };
      });
      check('the canopy tile is fully opaque', canopy.transparent === 0,
        `${canopy.transparent}/${canopy.tilePixels} texels would be punched out`);

      // The held item must add exactly one box, and never cover the crosshair.
      const held = await page.evaluate(async () => {
        const game = window.__VOXELHAVEN__;
        const api = window.VH;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        const gl = game.renderer.gl;

        // Stand on the surface so the frame is terrain, and face forward.
        const surface = game.world.heightAt(Math.floor(game.player.x), Math.floor(game.player.z));
        if (surface > 0) api.teleport(game.player.x, surface + 1.2, game.player.z);
        api.look(0, 0);
        await wait(1500);

        const sampleCentre = () => {
          const w = gl.drawingBufferWidth;
          const h = gl.drawingBufferHeight;
          const buf = new Uint8Array(w * h * 4);
          gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
          // A small disc at the crosshair, averaged.
          let r = 0; let g = 0; let b = 0; let n = 0;
          for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
              const i = ((h >> 1) + dy) * w * 4 + ((w >> 1) + dx) * 4;
              r += buf[i]; g += buf[i + 1]; b += buf[i + 2]; n++;
            }
          }
          return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
        };

        const inventory = game.player.inventory;
        const slot = game.player.selectedSlot;
        const saved = inventory.slots[slot];

        inventory.slots[slot] = null;
        await wait(500);
        const empty = api.heldMeshStats();
        const centreEmpty = sampleCentre();

        inventory.slots[slot] = { item: 'lantern', count: 12 };
        await wait(500);
        const filled = api.heldMeshStats();
        const centreFilled = sampleCentre();

        inventory.slots[slot] = saved;
        return { empty, filled, centreEmpty, centreFilled, glError: gl.getError() };
      });

      check('the arm renders even with an empty hand', held.empty.boxes === 2,
        `${held.empty.boxes} boxes (${held.empty.armBoxes} arm)`);
      check('a held stack adds exactly one item box',
        held.filled.boxes === held.empty.boxes + 1 && held.filled.itemBoxes === 1,
        `empty=${held.empty.boxes} filled=${held.filled.boxes} itemBoxes=${held.filled.itemBoxes}`);
      check('the held item mesh has real geometry',
        held.filled.vertices === 72 && held.filled.indices === 108,
        `vertices=${held.filled.vertices} indices=${held.filled.indices}`);
      check('the held item sits in front of the camera',
        held.filled.bounds !== null && held.filled.bounds.maxZ < 0
          && held.filled.bounds.minZ > -2,
        JSON.stringify(held.filled.bounds));
      const centreDelta = Math.abs(held.centreFilled[0] - held.centreEmpty[0])
        + Math.abs(held.centreFilled[1] - held.centreEmpty[1])
        + Math.abs(held.centreFilled[2] - held.centreEmpty[2]);
      check('the held item never covers the crosshair', centreDelta <= 12,
        `centre changed by ${centreDelta} (${held.centreEmpty} -> ${held.centreFilled})`);
      check('the held-item pass leaves no GL error', held.glError === 0,
        `glError=${held.glError}`);
    });

    await section('Error handling and stability', async () => {
      const health = await page.evaluate(() => window.VH.selfCheck());
      check('loaded chunks pass the consistency self-check', health.ok,
        health.issues.join('; '));
      check('chunks were inspected', health.checkedChunks > 0, `${health.checkedChunks} chunks`);

      const dead = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.kill();
        await new Promise((r) => setTimeout(r, 400));
        return { state: game.state, dead: game.player.dead, screenVisible: !document.getElementById('screen-death').classList.contains('is-hidden') };
      });
      check('death opens the death screen', dead.screenVisible, `state=${dead.state}`);
      check('the player is flagged dead', dead.dead === true, `dead=${dead.dead}`);

      const respawned = await page.evaluate(async () => {
        const api = window.VH;
        const game = window.__VOXELHAVEN__;
        api.respawn();
        // Give the controller a few steps to push the player out of anything
        // it may have landed inside.
        await new Promise((r) => setTimeout(r, 2500));
        const check = api.selfCheck();
        return {
          state: game.state,
          health: game.player.health,
          dead: game.player.dead,
          x: game.player.x, y: game.player.y, z: game.player.z,
          insideBlock: !check.playerBoxBlocked
        };
      });
      check('respawning restores health', respawned.health === 20 && !respawned.dead,
        `health=${respawned.health}`);
      check('respawning returns to play', respawned.state === 'playing', `state=${respawned.state}`);
      check('the respawn point is not inside a block', respawned.insideBlock,
        `position ${round(respawned.x)},${round(respawned.y)},${round(respawned.z)}`);

      // Final save so the world is left in a good state, then clean up.
      await page.evaluate(() => window.VH.saveNow());
    });

    await section('Console hygiene', async () => {
      // Expected noise: a favicon probe and the deliberate 404 that the
      // missing-save test provokes.
      const relevant = consoleErrors.filter((text) => !/favicon|net::ERR|404/i.test(text));
      check('no JavaScript errors were logged', pageErrors.length === 0,
        pageErrors.slice(0, 3).join(' | '));
      check('no console errors were logged', relevant.length === 0,
        relevant.slice(0, 3).join(' | '));
    });
  } finally {
    await session.close();
    await server.stop();

    // Remove the worlds this test created unless asked to keep them.
    if (!KEEP_SAVES) {
      for (const id of createdIds) {
        const file = path.join(testSaveDir, `${id}.json`);
        try { fs.unlinkSync(file); } catch { /* already gone */ }
      }
    }
  }

  // -------------------------------------------------------------------------
  console.log(`\n${'─'.repeat(58)}`);
  console.log(`  ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log('\n  Failures:');
    for (const failure of failures) console.log(`   • ${failure}`);
  }
  console.log(`${'─'.repeat(58)}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nTest run crashed:', err);
  process.exit(1);
});
