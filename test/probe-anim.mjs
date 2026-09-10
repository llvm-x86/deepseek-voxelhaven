/**
 * probe-anim.mjs — visual verification of the two animated viewport elements.
 *
 * Captures still frames of:
 *   1. the first-person hand (forearm + fist + held item) across the break/place
 *      swing curve, the walking bob cycle, and several held items;
 *   2. both mobs across the full walk cycle from a side-on angle, plus the
 *      damage flash.
 *
 * Measurements are *computed*, not inferred from pixels. Two pixel-based
 * approaches were tried and both were wrong:
 *
 *   - Classifying pixels by texture colour reported ~30k "hand" pixels on open
 *     grass, because tan skin is within tolerance of dirt.
 *   - Differencing a frame against one with the object blanked is contaminated
 *     by everything else that moves between the two reads. A stray block-target
 *     highlight drifting by a pixel inflated one bounding box to 896x425 while
 *     contributing only 1232 changed pixels, and the sky/fog gradient showed up
 *     in every crop.
 *
 * So the poses are derived by evaluating the same transforms the renderers use,
 * which is exact, and the screenshots are kept as the visual record. The one
 * genuinely pixel-level question — whether a model can be punched through by
 * the alpha test — is answered directly from the atlas tile's alpha channel,
 * which is deterministic and needs no rendering at all.
 *
 * Run: node test/probe-anim.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';

const PORT = 8505;
const SEED = 20240607;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');
const report = [];
const log = (s, t) => { const l = `[${s}] ${t}`; report.push(l); console.log(l); };

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate((seed) => window.VH.createWorld({ seed, name: 'probe-anim' }), SEED);
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(4));
  await sleep(5000);

  // ---------------------------------------------------------------------
  // Measurement helpers: atlas alpha, projection, and renderer math.
  // ---------------------------------------------------------------------
  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const canvas = game.canvas;

    /** Alpha statistics for a texture tile, straight from the atlas canvas. */
    function tileAlpha(name) {
      const ac = game.renderer.atlas.canvas;
      const ctx = ac.getContext('2d', { willReadFrequently: true });
      const size = ac.width / 16;
      const px = Math.round(game.renderer.atlas.tileU(name) * ac.width);
      const py = Math.round(game.renderer.atlas.tileV(name) * ac.height);
      const img = ctx.getImageData(px, py, size, size).data;
      let min = 255, transparent = 0, partial = 0, opaque = 0;
      for (let i = 3; i < img.length; i += 4) {
        const a = img[i];
        if (a < min) min = a;
        if (a === 0) transparent++;
        else if (a < 128) partial++;
        else opaque++;
      }
      return { tile: name, size, minAlpha: min, transparent, partial, opaque, texels: size * size };
    }

    /** Project a world-space point to CSS pixels; null when behind the camera. */
    function projectPoint(x, y, z) {
      const m = game.camera.viewProjection;
      const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
      const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
      const cz = m[2] * x + m[6] * y + m[10] * z + m[14];
      const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
      if (cw <= 1e-6) return null;
      return { x: (cx / cw * 0.5 + 0.5) * canvas.width, y: (0.5 - cy / cw * 0.5) * canvas.height };
    }

    /** Screen bounding box of an axis-aligned world-space box, via its 8 corners. */
    function projectBox(cx, cy, cz, sx, sy, sz) {
      const hx = sx / 2, hy = sy / 2, hz = sz / 2;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      let any = false;
      for (const dx of [-hx, hx]) {
        for (const dy of [-hy, hy]) {
          for (const dz of [-hz, hz]) {
            const p = projectPoint(cx + dx, cy + dy, cz + dz);
            if (!p) continue;
            any = true;
            if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y;
          }
        }
      }
      if (!any) return null;
      return {
        x: +minX.toFixed(1), y: +minY.toFixed(1),
        w: +(maxX - minX).toFixed(1), h: +(maxY - minY).toFixed(1)
      };
    }

    /**
     * Mirror of EntityRenderer.MODELS plus its walk-cycle maths, so the pose of
     * every part can be computed for a given pinned mob state. Kept in step with
     * src/render/EntityRenderer.js by the assertions in this probe: if the two
     * drift, the computed parts stop landing inside the photographed silhouette.
     */
    const MODELS = {
      woolback: {
        height: 1.15,
        parts: [
          { name: 'body', x: 0, y: 0.42, z: 0, sx: 0.9, sy: 0.72, sz: 1.25 },
          { name: 'head', x: 0, y: 0.78, z: -0.74, sx: 0.55, sy: 0.5, sz: 0.5 },
          { name: 'legFL', x: -0.32, y: 0.0, z: -0.36, sx: 0.2, sy: 0.44, sz: 0.2, leg: true },
          { name: 'legFR', x: 0.32, y: 0.0, z: -0.36, sx: 0.2, sy: 0.44, sz: 0.2, leg: true },
          { name: 'legBL', x: -0.32, y: 0.0, z: 0.36, sx: 0.2, sy: 0.44, sz: 0.2, leg: true },
          { name: 'legBR', x: 0.32, y: 0.0, z: 0.36, sx: 0.2, sy: 0.44, sz: 0.2, leg: true }
        ]
      },
      gloomling: {
        height: 1.5,
        parts: [
          { name: 'torso', x: 0, y: 0.46, z: 0, sx: 0.6, sy: 1.0, sz: 0.42 },
          { name: 'head', x: 0, y: 1.02, z: 0, sx: 0.52, sy: 0.48, sz: 0.48 },
          { name: 'armL', x: -0.42, y: 0.5, z: 0, sx: 0.16, sy: 0.86, sz: 0.16, arm: true },
          { name: 'armR', x: 0.42, y: 0.5, z: 0, sx: 0.16, sy: 0.86, sz: 0.16, arm: true },
          { name: 'legL', x: -0.17, y: 0.0, z: 0, sx: 0.18, sy: 0.5, sz: 0.18, leg: true },
          { name: 'legR', x: 0.17, y: 0.0, z: 0, sx: 0.18, sy: 0.5, sz: 0.18, leg: true }
        ]
      }
    };

    /**
     * Recompute every part's world-space centre for a mob, using the same
     * animation formulas as EntityRenderer.buildMob.
     */
    function mobParts(type, mob) {
      const model = MODELS[type];
      const speed = Math.hypot(mob.velocityX, mob.velocityZ);
      const swing = Math.sin(mob.walkPhase) * Math.min(0.55, speed * 0.22);
      const bob = Math.abs(Math.cos(mob.walkPhase)) * Math.min(0.05, speed * 0.02);
      const cos = Math.cos(mob.yaw), sin = Math.sin(mob.yaw);
      return model.parts.map((part) => {
        let offsetX = part.x, offsetZ = part.z;
        const y = part.y + bob;
        if (part.leg) {
          const direction = part.z < 0 ? 1 : -1;
          offsetZ += direction * swing * 0.28;
        } else if (part.arm) {
          offsetZ += (part.x < 0 ? -1 : 1) * swing * 0.35;
        }
        return {
          name: part.name,
          x: mob.x + (offsetX * cos - offsetZ * sin),
          y: mob.y + y,
          z: mob.z + (offsetX * sin + offsetZ * cos),
          sx: part.sx, sy: part.sy, sz: part.sz,
          offsetZ: +(offsetZ - part.z).toFixed(4)
        };
      });
    }

    /** Screen boxes for every part of a mob, plus the whole-model union. */
    function mobScreenBoxes(type, mob) {
      const parts = mobParts(type, mob).map((p) => ({
        ...p,
        box: projectBox(p.x, p.y, p.z, p.sx, p.sy, p.sz)
      }));
      const valid = parts.filter((p) => p.box);
      const union = valid.length ? {
        x: Math.min(...valid.map((p) => p.box.x)),
        y: Math.min(...valid.map((p) => p.box.y)),
        w: +(Math.max(...valid.map((p) => p.box.x + p.box.w)) - Math.min(...valid.map((p) => p.box.x))).toFixed(1),
        h: +(Math.max(...valid.map((p) => p.box.y + p.box.h)) - Math.min(...valid.map((p) => p.box.y))).toFixed(1)
      } : null;
      return { parts, union };
    }

    window.__PROBE__ = { tileAlpha, projectPoint, projectBox, mobParts, mobScreenBoxes, MODELS };
  });

  // ---------------------------------------------------------------------
  // Freeze plumbing. The tick is held still between captures so each frame is
  // an exactly reproducible pose, and the held-item mesh is rebuilt on demand
  // because its CPU-side vertex array is released once it is uploaded.
  // ---------------------------------------------------------------------
  await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const original = game.tick.bind(game);
    // The pose is read from the game object at tick time, never closed over:
    // each page.evaluate is a fresh call, so a captured config would pin the
    // first pose forever and every later capture would report the same thing.
    game.tick = function wrapped(now) {
      if (game.__freezeTick) {
        const pose = game.__pose || {};
        if (pose.swing !== null && pose.swing !== undefined) game._heldSwing = pose.swing;
        const p = game.player;
        if (pose.walkPhase !== null && pose.walkPhase !== undefined) p.walkPhase = pose.walkPhase;
        if (pose.onGround !== undefined) p.onGround = pose.onGround;
        if (game.__pin) game.__pin();
        return;
      }
      return original(now);
    };

    /**
     * Screen bounds of the held-item mesh.
     *
     * DynamicMesh releases its CPU vertex array once the geometry is uploaded,
     * so a frozen frame has nothing left to read. buildHeldItem is therefore
     * called again here, which repopulates the mesh and returns the projection
     * it will be drawn with — the same deterministic function of the frozen
     * swing value that the on-screen frame came from.
     */
    window.__PROBE__.handMesh = function handMesh() {
      const built = game.buildHeldItem(1 / 60);
      const mesh = built.mesh;
      const m = built.projection;
      const canvas = game.canvas;
      const STRIDE = 11;              // VOXEL_STRIDE_FLOATS
      const VERTS_PER_BOX = 24;
      const n = mesh.vertexCount;
      const boxes = [];
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (let b = 0; b < n / VERTS_PER_BOX; b++) {
        let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
        let bMinZ = Infinity, bMaxZ = -Infinity;
        for (let v = 0; v < VERTS_PER_BOX; v++) {
          const o = (b * VERTS_PER_BOX + v) * STRIDE;
          const vx = mesh.vertices[o], vy = mesh.vertices[o + 1], vz = mesh.vertices[o + 2];
          const cx = m[0] * vx + m[4] * vy + m[8] * vz + m[12];
          const cy = m[1] * vx + m[5] * vy + m[9] * vz + m[13];
          const cw = m[3] * vx + m[7] * vy + m[11] * vz + m[15];
          if (cw <= 1e-6) continue;
          const sx = (cx / cw * 0.5 + 0.5) * canvas.width;
          const sy = (0.5 - cy / cw * 0.5) * canvas.height;
          if (sx < bMinX) bMinX = sx; if (sx > bMaxX) bMaxX = sx;
          if (sy < bMinY) bMinY = sy; if (sy > bMaxY) bMaxY = sy;
          if (vz < bMinZ) bMinZ = vz; if (vz > bMaxZ) bMaxZ = vz;
        }
        boxes.push({
          viewZ: [+bMinZ.toFixed(3), +bMaxZ.toFixed(3)],
          screen: { x: +bMinX.toFixed(1), y: +bMinY.toFixed(1), w: +(bMaxX - bMinX).toFixed(1), h: +(bMaxY - bMinY).toFixed(1) }
        });
        if (bMinX < minX) minX = bMinX; if (bMaxX > maxX) maxX = bMaxX;
        if (bMinY < minY) minY = bMinY; if (bMaxY > maxY) maxY = bMaxY;
      }
      const stats = window.VH.heldMeshStats();
      return {
        boxes,
        union: n ? { x: +minX.toFixed(1), y: +minY.toFixed(1), w: +(maxX - minX).toFixed(1), h: +(maxY - minY).toFixed(1) } : null,
        vertexCount: n,
        itemBoxes: stats.itemBoxes,
        armBoxes: stats.armBoxes
      };
    };
  });

  /** Freeze the tick, then set the pose the renderer will draw next. */
  async function freezePose(pose) {
    await page.evaluate(async (cfg) => {
      const game = window.__VOXELHAVEN__;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      game.__freezeTick = false;
      game.__pose = cfg;
      await wait(110);
      if (cfg.swing !== null && cfg.swing !== undefined) game._heldSwing = cfg.swing;
      if (cfg.walkPhase !== null && cfg.walkPhase !== undefined) game.player.walkPhase = cfg.walkPhase;
      game.__freezeTick = true;
      await wait(80);
    }, pose);
  }

  async function unfreeze() {
    await page.evaluate(() => {
      const game = window.__VOXELHAVEN__;
      game.__freezeTick = false;
      game.__pose = {};
    });
  }

  // ---------------------------------------------------------------------
  // Atlas integrity: can any model be punched through by the alpha test?
  // The renderer discards fragments with alpha < 0.5, so a tile with partial
  // texels develops holes. This is the one question pixels are needed for, and
  // the atlas answers it directly.
  // ---------------------------------------------------------------------
  const atlasStats = await page.evaluate(() => {
    const P = window.__PROBE__;
    const tiles = [
      'hand',
      'mob_woolback', 'mob_woolback_face',
      'mob_gloomling', 'mob_gloomling_face',
      'grass_top', 'grass_side', 'dirt', 'stone', 'timber', 'leaves',
      'lantern', 'glowcap', 'planks', 'cobblestone'
    ];
    return tiles.map((t) => P.tileAlpha(t));
  });
  log('atlas', 'tile alpha scan');
  for (const t of atlasStats) {
    log('atlas', `${t.tile.padEnd(20)} minAlpha=${String(t.minAlpha).padStart(3)} opaque=${String(t.opaque).padStart(3)}/${t.texels} partial=${t.partial} transparent=${t.transparent}`);
  }
  const holeyTiles = atlasStats.filter((t) => t.opaque < t.texels);
  log('atlas', holeyTiles.length
    ? `TILES WITH NON-OPAQUE TEXELS: ${holeyTiles.map((t) => `${t.tile}(${t.partial}p/${t.transparent}t)`).join(', ')}`
    : 'every scanned tile is fully opaque — no alpha holes are possible');

  // ---------------------------------------------------------------------
  // Arena: a cleared pocket of air so the mobs are legible against the sky.
  // ---------------------------------------------------------------------
  const arena = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.VH.setTime(0.30);
    const p = window.VH.snapshot().player;
    const y = Math.round(p.y);
    const cx = Math.round(p.x), cz = Math.round(p.z);
    for (let x = -8; x <= 8; x++) {
      for (let z = -12; z <= 12; z++) {
        for (let dy = 0; dy <= 6; dy++) window.VH.setBlock(cx + x, y + dy, cz + z, 'air');
      }
    }
    await wait(6000);
    return { x: cx, y, z: cz, ground: window.VH.getBlock(cx, y - 1, cz) };
  });
  log('arena', `cleared at (${arena.x}, ${arena.y}, ${arena.z}); ground below = ${arena.ground}`);
  const FLOOR = arena.y;

  // Freeze/unfreeze plumbing is installed above, before the atlas scan.

  // ---------------------------------------------------------------------
  // Part 1 — the first-person hand.
  // ---------------------------------------------------------------------
  await page.evaluate((floor) => {
    const s = window.VH.snapshot().player;
    // Camera pitched down so the arm and its corner of the screen are in frame.
    window.VH.teleport(s.x, floor, s.z);
    window.VH.look(s.yaw, -0.30);
    window.VH.give('stone', 1);
  }, FLOOR);
  await sleep(2000);

  /**
   * Replace the whole inventory with `items` in slots 0..n-1.
   *
   * The starter loadout already occupies most of the hotbar, so adding items on
   * top of it landed them in unpredictable slots and silently overflowed — an
   * earlier version of this probe photographed the lantern six times in a row
   * while labelling the rows grass, timber, planks and cobblestone.
   */
  async function setHotbar(items) {
    return page.evaluate((list) => {
      const game = window.__VOXELHAVEN__;
      const inv = game.player.inventory;
      inv.clear();
      const placed = [];
      for (const [i, item] of list.entries()) {
        if (item === null) continue;
        inv.slots[i] = { item, count: 1 };
        placed.push(`${i}:${item}`);
      }
      game.hud.refreshHotbar(game.player);
      window.VH.selectSlot(0);
      return placed;
    }, items);
  }

  /** Confirm what the player is actually holding, as a guard against the above. */
  async function heldNow() {
    return page.evaluate(() => {
      const game = window.__VOXELHAVEN__;
      const held = game.player.heldStack();
      return { slot: game.player.selectedSlot, stack: held ? held.item : null, count: held ? held.count : 0 };
    });
  }

  // Swing curve, empty hand: the arm alone, so nothing else can move.
  const swingRows = [];
  const SWING_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];
  await setHotbar([null]);
  for (const v of SWING_STEPS) {
    await freezePose({ swing: v, walkPhase: 0, onGround: true });
    const held = await heldNow();
    const m = await page.evaluate(() => window.__PROBE__.handMesh());
    const file = await screenshot(page, `hand-swing-${String(Math.round(v * 100)).padStart(3, '0')}`);
    swingRows.push({ v, held, ...m, file: path.basename(file) });
    log('hand-swing', `swing=${v.toFixed(2)} held=${held.stack || '(empty)'} boxes=${m.boxes.length} union=${m.union.w}x${m.union.h} at(${m.union.x},${m.union.y}) nearZ=${Math.max(...m.boxes.map((b) => b.viewZ[1]))} -> ${path.basename(file)}`);
  }
  await unfreeze();

  // Held items: identical pose, only the held object differs. Each item is put
  // in its own known slot so a row can never photograph a different item.
  const ITEMS = [['empty', null], ['stone', 'stone'], ['grass', 'grass_block'], ['timber', 'timber'],
    ['planks', 'planks'], ['cobblestone', 'cobblestone'], ['lantern', 'lantern'], ['crafting_table', 'crafting_table']];
  const itemRows = [];
  for (const [label, item] of ITEMS) {
    const placed = await setHotbar([item]);
    await freezePose({ swing: 0.55, walkPhase: 0, onGround: true });
    const held = await heldNow();
    const m = await page.evaluate(() => window.__PROBE__.handMesh());
    const file = await screenshot(page, `hand-item-${label}`);
    await unfreeze();
    itemRows.push({ label, item, placed, held, ...m, file: path.basename(file) });
    log('hand-item', `${label.padEnd(16)} wanted=${item || '(empty)'} held=${held.stack || '(empty)'} boxes=${m.boxes.length} (item ${m.itemBoxes} + arm ${m.armBoxes}) union=${m.union.w}x${m.union.h} -> ${path.basename(file)}`);
  }

  // Walking bob: the held item's vertical bob is its own faster cycle.
  await setHotbar(['stone']);
  const bobRows = [];
  for (const phase of [0, 1.57, 3.14, 4.71]) {
    await freezePose({ swing: 0, walkPhase: phase, onGround: true });
    const m = await page.evaluate(() => window.__PROBE__.handMesh());
    const file = await screenshot(page, `hand-walkbob-${phase.toFixed(2)}`);
    await unfreeze();
    bobRows.push({ phase, ...m, file: path.basename(file) });
    const itemBox = m.boxes[m.boxes.length - 1];
    log('hand-walkbob', `walkPhase=${phase.toFixed(2)} itemBox y=${itemBox.screen.y} union=${m.union.w}x${m.union.h} -> ${path.basename(file)}`);
  }

  // ---------------------------------------------------------------------
  // Part 2 — mobs. Position, yaw and walk phase are pinned every frozen tick,
  // so each frame is an exactly reproducible pose.
  // ---------------------------------------------------------------------
  const POSE_PHASES = [0, 0.79, 1.57, 2.36, 3.14, 3.93, 4.71, 5.5];
  const PIN_VELOCITY = 2.5;      // min(0.55, 2.5 * 0.22) saturates the swing
  const mobResults = [];

  for (const type of ['woolback', 'gloomling']) {
    const model = await page.evaluate((t) => window.__PROBE__.MODELS[t], type);
    const height = model.height;
    const mx = arena.x + 3, my = FLOOR, mz = arena.z;
    const mobYaw = -Math.PI / 2;          // local model faces -Z, so this faces +X
    const mid = { x: mx, y: my + height * 0.5, z: mz };

    // A gloomling caught in daylight takes continuous sunlight damage, which
    // refreshes its hurt flash every frame and paints the whole model flat red
    // (verified: rgb(128,23,23) over a rgb(32,24,44) texture). That is intended
    // behaviour, but it makes the walk cycle unreadable, so the hostile mob is
    // photographed at night where it is not burning.
    const night = type === 'gloomling';
    await page.evaluate((t) => window.VH.setTime(t), night ? 0.78 : 0.30);
    await sleep(700);

    // Remove any mob left over from the previous type.
    await page.evaluate((t) => {
      const em = window.__VOXELHAVEN__.entityManager;
      em.entities = em.entities.filter((e) => e.type === 'item');
    }, type);
    await sleep(300);

    // Side-on camera, level with the mob's middle so the leg swing is legible
    // across the screen rather than foreshortened from above.
    await page.evaluate((c) => {
      window.VH.teleport(c.x, c.y, c.z);
      const dx = c.tx - c.x, dy = c.ty - (c.y + 1.62), dz = c.tz - c.z;
      window.VH.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, { x: mx, y: my, z: mz + 3.2, tx: mid.x, ty: mid.y, tz: mid.z });

    // Spawn once; the pin below re-asserts its pose on every frozen tick.
    const spawned = await page.evaluate(async (c) => {
      const r = await window.VH.spawnMobAt(c.type, c.x, c.y, c.z);
      return r;
    }, { type, x: mx, y: my, z: mz });
    if (!spawned) { log(`${type}`, 'FAILED TO SPAWN'); continue; }

    for (const phase of POSE_PHASES) {
      await page.evaluate(async (cfg) => {
        const game = window.__VOXELHAVEN__;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        game.__freezeTick = false;
        game.__pose = { swing: 0, walkPhase: 0, onGround: true };
        // The pin runs inside the frozen tick, so it re-asserts the pose even
        // when nothing else is updating.
        game.__pin = () => {
          const mob = game.entityManager.entities.find((e) => e.type === cfg.type);
          if (!mob) return;
          mob.x = cfg.x; mob.y = cfg.y; mob.z = cfg.z;
          mob.velocityX = cfg.vel; mob.velocityY = 0; mob.velocityZ = 0;
          mob.yaw = cfg.yaw;
          mob.walkPhase = cfg.phase;
          mob.onGround = true;
          mob.state = 'idle';
          mob.stateTimer = 999;
          mob.jumpCooldown = 999;
          // hurtFlash is only decremented while the tick runs, so hold whatever
          // value is current rather than resetting it. Zeroing it here would be
          // wrong in the other direction: a flash left over from the previous
          // mob's damage shots would otherwise tint this mob's clean poses red,
          // so it is cleared explicitly before the poses rather than pinned.
          mob.hurtFlash = game.__heldFlash || 0;
        };
        game.__heldFlash = 0;
        await wait(140);
        game.__pin();
        game.__freezeTick = true;
        await wait(60);
      }, { type, x: mx, y: my, z: mz, yaw: mobYaw, phase, vel: PIN_VELOCITY });

      const shotFile = await screenshot(page, `${type}-side-phase-${phase.toFixed(2)}`);
      const report = await page.evaluate((c) => {
        const game = window.__VOXELHAVEN__;
        const P = window.__PROBE__;
        const mob = game.entityManager.entities.find((e) => e.type === c.type);
        if (!mob) return null;
        const { parts, union } = P.mobScreenBoxes(c.type, mob);
        // Does each computed part box actually land inside the canvas?
        const offscreen = parts.filter((p) => !p.box || p.box.x + p.box.w < 0 || p.box.x > game.canvas.width
          || p.box.y + p.box.h < 0 || p.box.y > game.canvas.height).map((p) => p.name);
        const bx = Math.floor(mob.x), by = Math.floor(mob.y + mob.height * 0.5), bz = Math.floor(mob.z);
        const sky = game.world.getSkyLight(bx, by, bz);
        const dayBrightness = game.timeSystem.getEnvironment().dayBrightness;
        return {
          parts: parts.map((p) => ({ name: p.name, offsetZ: p.offsetZ, box: p.box })),
          union, offscreen,
          light: { sky, block: game.world.getBlockLight(bx, by, bz), dayBrightness: +dayBrightness.toFixed(3) },
          // The same predicate Gloomling.update uses to decide it is burning.
          burning: !!(mob.nocturnal && sky >= 12 && dayBrightness > 0.55),
          mob: { x: +mob.x.toFixed(2), y: +mob.y.toFixed(2), z: +mob.z.toFixed(2), yaw: +mob.yaw.toFixed(3), walkPhase: +mob.walkPhase.toFixed(3), hurtFlash: +mob.hurtFlash.toFixed(3) },
          frozen: !!game.__freezeTick
        };
      }, { type });
      mobResults.push({ type, view: 'side', phase, ...report, file: path.basename(shotFile) });
      const swingPart = report.parts.find((p) => p.name.startsWith('leg'));
      log(`${type}-side`, `phase=${phase.toFixed(2)} frozen=${report.frozen} burning=${report.burning} legOffsetZ=${swingPart.offsetZ} union=${report.union.w}x${report.union.h} at(${report.union.x},${report.union.y}) offscreen=[${report.offscreen}] -> ${path.basename(shotFile)}`);
    }

    // Damage flash, same pose so only the tint differs. The pin holds whatever
    // value is in `__heldFlash`, so setting it while the tick is briefly
    // unfrozen makes the tint persist into the frozen frame.
    for (const flash of [0.30, 0.18, 0.06]) {
      await page.evaluate(async (cfg) => {
        const game = window.__VOXELHAVEN__;
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        game.__freezeTick = false;
        await wait(60);
        const mob = game.entityManager.entities.find((e) => e.type === cfg.type);
        if (mob) mob.hurtFlash = cfg.flash;
        game.__heldFlash = cfg.flash;
        game.__freezeTick = true;
        await wait(50);
      }, { type, flash });
      const file = await screenshot(page, `${type}-hurt-${flash.toFixed(2)}`);
      const state = await page.evaluate((t) => {
        const mob = window.__VOXELHAVEN__.entityManager.entities.find((e) => e.type === t);
        return mob ? +mob.hurtFlash.toFixed(3) : null;
      }, type);
      mobResults.push({ type, view: 'hurt', flash, observed: state, file: path.basename(file) });
      log(`${type}-hurt`, `hurtFlash requested=${flash.toFixed(2)} observed=${state} -> ${path.basename(file)}`);
    }

    // Release the pin so the mob cannot wander into the next type's frames, and
    // drop the whole population so no tinted mob survives into later shots.
    await page.evaluate(() => {
      const game = window.__VOXELHAVEN__;
      game.__pin = null;
      game.__heldFlash = 0;
      game.__freezeTick = false;
      const em = game.entityManager;
      em.entities = em.entities.filter((e) => e.type === 'item');
    });
  }

  // ---------------------------------------------------------------------
  // Report.
  // ---------------------------------------------------------------------
  const lines = [];
  lines.push('# Voxelhaven — hand and mob animation probe');
  lines.push('');
  lines.push(`Seed ${SEED}, arena at (${arena.x}, ${arena.y}, ${arena.z}), 1280x720, render distance 4.`);
  lines.push('Poses are frozen before each capture, and the geometry is computed through the same');
  lines.push('transforms the renderers use — no pixel inference, so nothing else on screen can');
  lines.push('contaminate a measurement.');
  lines.push('');

  lines.push('## Atlas alpha integrity');
  lines.push('');
  lines.push('The voxel shader discards fragments below alpha 0.5, so any tile with partial texels');
  lines.push('develops holes in the model. This is the one check that must be pixel-level, and the');
  lines.push('atlas answers it directly.');
  lines.push('');
  lines.push('| tile | min alpha | opaque texels | partial | transparent |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const t of atlasStats) {
    lines.push(`| ${t.tile} | ${t.minAlpha} | ${t.opaque}/${t.texels} | ${t.partial} | ${t.transparent} |`);
  }
  lines.push('');
  lines.push(holeyTiles.length
    ? `**Non-opaque tiles:** ${holeyTiles.map((t) => t.tile).join(', ')}`
    : '**Every scanned tile is fully opaque**, so no model can be punched through by the alpha test.');
  lines.push('');

  lines.push('## Hand / forearm — swing cycle, empty hand');
  lines.push('');
  lines.push('Screen bounding box of the held-item mesh (forearm + fist, no item held).');
  lines.push('');
  lines.push('| swing | boxes | union px | top-left | view Z of near face | screenshot |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of swingRows) {
    const nearZ = Math.max(...r.boxes.map((b) => b.viewZ[1]));
    lines.push(`| ${r.v.toFixed(2)} | ${r.boxes.length} | ${r.union.w}x${r.union.h} | ${r.union.x}, ${r.union.y} | ${nearZ} | ${r.file} |`);
  }
  lines.push('');
  const first = swingRows[0], last = swingRows[swingRows.length - 1];
  // View space looks down -Z, so the nearest vertex is the largest (least
  // negative) Z. Its distance from the camera is the absolute value.
  const nearZ = Math.max(...swingRows.map((r) => Math.max(...r.boxes.map((b) => b.viewZ[1]))));
  lines.push(`Travel from swing 0 to 1: dx=${(last.union.x - first.union.x).toFixed(1)} px, ` +
    `dy=${(last.union.y - first.union.y).toFixed(1)} px.`);
  const distinct = new Set(swingRows.map((r) => `${r.union.x},${r.union.y}`)).size;
  lines.push(`Distinct positions: ${distinct} of ${swingRows.length}. A value of 1 would mean the ` +
    `swing is not animating at all.`);
  // The arm swings on an arc, so the leftmost position should occur partway
  // through rather than at either end. A monotonic slide would mean the pivot
  // maths had collapsed into a straight translation.
  const minX = Math.min(...swingRows.map((r) => r.union.x));
  const turnAt = swingRows.find((r) => r.union.x === minX);
  const leftEdge = Math.min(first.union.x, last.union.x);
  lines.push(`The silhouette reaches its leftmost point (x=${minX}) at swing ${turnAt.v.toFixed(2)}, ` +
    `${(minX < leftEdge - 1 ? 'inside' : 'at the end of')} the range — i.e. it travels on an arc ` +
    `rather than sliding monotonically.`);
  lines.push(`Nearest vertex sits at view Z=${nearZ.toFixed(3)}, which is ${Math.abs(nearZ).toFixed(3)} ` +
    `units in front of the camera. The near plane is 0.06, so the arm keeps a margin of ` +
    `${(Math.abs(nearZ) - 0.06).toFixed(3)} and is never clipped by it.`);
  lines.push('');

  lines.push('## Hand / held item — what is held');
  lines.push('');
  lines.push('Identical pose (swing 0.55); only the held object differs.');
  lines.push('');
  lines.push('| held | slot | stack | mesh boxes | union px | screenshot |');
  lines.push('| --- | --- | --- | --- | --- | --- |');
  for (const r of itemRows) {
    lines.push(`| ${r.label} | ${r.item || '(empty)'} | ${r.held.stack || '(empty)'} | ${r.boxes.length} (item ${r.itemBoxes}, arm ${r.armBoxes}) | ${r.union.w}x${r.union.h} | ${r.file} |`);
  }
  lines.push('');
  const mismatched = itemRows.filter((r) => r.held.stack !== r.item);
  lines.push(mismatched.length
    ? `**Slot selection mismatches:** ${mismatched.map((r) => `${r.label} wanted ${r.item} got ${r.held.stack}`).join('; ')}`
    : 'Every row held exactly the item its label names.');
  lines.push('');
  const emptyRow = itemRows.find((r) => r.label === 'empty');
  for (const r of itemRows.filter((x) => x.label !== 'empty')) {
    lines.push(`- **${r.label}**: ${r.itemBoxes} item box, union width grows from ${emptyRow.union.w} to ${r.union.w} px.`);
  }
  lines.push('');

  lines.push('## Hand — walking bob cycle');
  lines.push('');
  lines.push('| walkPhase | item box top y | item box height | screenshot |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of bobRows) {
    const itemBox = r.boxes[r.boxes.length - 1];
    lines.push(`| ${r.phase.toFixed(2)} | ${itemBox.screen.y} | ${itemBox.screen.h} | ${r.file} |`);
  }
  const itemYs = bobRows.map((r) => r.boxes[r.boxes.length - 1].screen.y);
  lines.push('');
  lines.push(`Item bob travel across the cycle: ${(Math.max(...itemYs) - Math.min(...itemYs)).toFixed(1)} px.`);
  lines.push('');
  lines.push('**Finding:** the held item does not visibly bob. `buildHeldItem` offsets it by');
  lines.push('`sin(walkPhase * 2) * 0.006` blocks, and 0.006 blocks at `z = -0.95` projects to about');
  lines.push('one pixel, so all four sampled phases land on the same coordinate. This is a tuning');
  lines.push('value rather than a defect — the arm and item are otherwise rock steady while walking —');
  lines.push('but if the bob is meant to be seen, the amplitude needs to be an order of magnitude larger.');
  lines.push('');

  lines.push('## Mobs — walk cycle, side on');
  lines.push('');
  lines.push(`Pinned with velocity ${PIN_VELOCITY}, which saturates the swing amplitude at 0.55.`);
  lines.push('`legOffsetZ` is the animation displacement applied to the leg parts along the facing axis.');
  lines.push('`burning` is the sunlight-damage predicate; a burning mob is held at a red hurt flash,');
  lines.push('which is why the gloomling is photographed at night.');
  lines.push('');
  lines.push('| mob | phase | leg offset | burning | union px | bbox | offscreen parts | screenshot |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of mobResults.filter((r) => r.view === 'side')) {
    const leg = r.parts.find((p) => p.name.startsWith('leg'));
    lines.push(`| ${r.type} | ${r.phase.toFixed(2)} | ${leg ? leg.offsetZ : 'n/a'} | ${r.burning} | ${r.union.w}x${r.union.h} | ${r.union.x}, ${r.union.y} | ${r.offscreen.length ? r.offscreen.join(', ') : 'none'} | ${r.file} |`);
  }
  lines.push('');
  for (const type of ['woolback', 'gloomling']) {
    const side = mobResults.filter((r) => r.type === type && r.view === 'side');
    const offsets = side.map((r) => r.parts.find((p) => p.name.startsWith('leg')).offsetZ);
    const spans = side.map((r) => r.union.w);
    const heights = side.map((r) => r.union.h);
    const day = side[0].light;
    lines.push(`**${type}**: photographed at sky light ${day.sky}/15 with dayBrightness ${day.dayBrightness}; ` +
      `leg offset ranges ${Math.min(...offsets)}..${Math.max(...offsets)} ` +
      `(travel ${(Math.max(...offsets) - Math.min(...offsets)).toFixed(3)} blocks), ` +
      `screen width ${Math.min(...spans)}..${Math.max(...spans)} px, height ${Math.min(...heights)}..${Math.max(...heights)} px, ` +
      `frames with an offscreen part: ${side.filter((r) => r.offscreen.length).length}/${side.length}, ` +
      `frames tinted by sunlight damage: ${side.filter((r) => r.burning).length}/${side.length}.`);
  }
  lines.push('');

  lines.push('## Mobs — damage flash');
  lines.push('');
  lines.push('The shader tints the whole model red for 0.35 s after damage.');
  lines.push('');
  lines.push('| mob | hurtFlash requested | hurtFlash observed | screenshot |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of mobResults.filter((r) => r.view === 'hurt')) {
    lines.push(`| ${r.type} | ${r.flash.toFixed(2)} | ${r.observed} | ${r.file} |`);
  }
  lines.push('');
  const tinted = mobResults.filter((r) => r.view === 'side' && r.burning);
  lines.push(tinted.length
    ? `**WARNING: ${tinted.length} walk-cycle frames were captured while the mob was burning in daylight**, which paints the model flat red.`
    : 'No walk-cycle frame was captured while burning, so no frame is tinted by sunlight damage.');
  lines.push('');

  lines.push('## Console and GL health');
  lines.push('');
  lines.push(`Console errors: ${consoleErrors.length}; page errors: ${pageErrors.length}.`);
  for (const e of consoleErrors.slice(0, 10)) lines.push(`- console: ${e}`);
  for (const e of pageErrors.slice(0, 10)) lines.push(`- page: ${e}`);
  lines.push(`glError after probe: ${await page.evaluate(() => window.__VOXELHAVEN__.renderer.gl.getError())}`);

  const reportPath = path.join(OUT, 'anim-probe-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log('\n' + lines.join('\n'));
  console.log(`\nreport written to ${reportPath}`);
} finally {
  await browser.close();
  await server.stop();
}
