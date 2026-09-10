/**
 * probe-mob-color.mjs — why does the gloomling render as a flat red silhouette?
 *
 * Decodes the PNG screenshots with node's zlib (no dependencies) and samples the
 * mob's pixels, so the answer comes from the actual framebuffer rather than from
 * any assumption about which tint is applied.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { startServer, launchGame, waitForState, sleep, screenshot, PROJECT_ROOT } from './headless.mjs';

const PORT = 8502;
const OUT = path.join(PROJECT_ROOT, 'test', 'screenshots');

/** Minimal PNG decoder: returns {width, height, data} with 8-bit RGB(A) rows. */
function decodePng(file) {
  const buf = fs.readFileSync(file);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : null;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = raw.subarray(rp, rp + stride);
    rp += stride;
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : Buffer.alloc(stride);
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
      }
      cur[x] = v & 255;
    }
  }
  return { width, height, channels, data: out };
}

function stats(img, x0, y0, w, h) {
  const { channels, width, data } = img;
  const colours = new Map();
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const o = (y * width + x) * channels;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      rs += r; gs += g; bs += b; n++;
      const key = (r << 16) | (g << 8) | b;
      colours.set(key, (colours.get(key) || 0) + 1);
    }
  }
  const top = [...colours.entries()].sort((a, c) => c[1] - a[1]).slice(0, 6)
    .map(([k, c]) => `rgb(${(k >> 16) & 255},${(k >> 8) & 255},${k & 255})x${c}`);
  return { mean: [Math.round(rs / n), Math.round(gs / n), Math.round(bs / n)], distinct: colours.size, top };
}

const server = await startServer(PORT);
const { browser, page } = await launchGame({ url: server.url });
try {
  await page.evaluate(() => window.VH.createWorld({ seed: 20240607, name: 'color' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(4));
  await sleep(5000);

  // Atlas tile colour statistics, which is what the model should look like.
  const tiles = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const ac = game.renderer.atlas.canvas;
    const ctx = ac.getContext('2d', { willReadFrequently: true });
    const out = {};
    for (const name of ['mob_woolback', 'mob_woolback_face', 'mob_gloomling', 'mob_gloomling_face']) {
      const size = ac.width / 16;
      const px = Math.round(game.renderer.atlas.tileU(name) * ac.width);
      const py = Math.round(game.renderer.atlas.tileV(name) * ac.height);
      const d = ctx.getImageData(px, py, size, size).data;
      const set = new Map();
      let r = 0, g = 0, b = 0, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        set.set(`${d[i]},${d[i + 1]},${d[i + 2]}`, (set.get(`${d[i]},${d[i + 1]},${d[i + 2]}`) || 0) + 1);
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      out[name] = {
        mean: [Math.round(r / n), Math.round(g / n), Math.round(b / n)],
        distinct: set.size,
        top: [...set.entries()].sort((a, c) => c[1] - a[1]).slice(0, 4)
      };
    }
    return out;
  });
  console.log('=== atlas tiles ===');
  for (const [k, v] of Object.entries(tiles)) {
    console.log(`${k.padEnd(22)} mean=${v.mean.join(',')} distinct=${v.distinct} top=${JSON.stringify(v.top)}`);
  }

  // Stand in the arena and photograph the gloomling on a clean, unlit ground.
  const arena = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    window.VH.setTime(0.30);
    const p = window.VH.snapshot().player;
    const y = Math.round(p.y), cx = Math.round(p.x), cz = Math.round(p.z);
    for (let x = -8; x <= 8; x++) for (let z = -12; z <= 12; z++) for (let dy = 0; dy <= 6; dy++) {
      window.VH.setBlock(cx + x, y + dy, cz + z, 'air');
    }
    await wait(6000);
    return { x: cx, y, z: cz };
  });

  const results = {};
  // Two lighting conditions: bright daylight (where a gloomling burns and is
  // held at a constant damage flash) and night (where it is not burning).
  for (const [label, time] of [['day', 0.30], ['night', 0.78]]) {
  await page.evaluate((t) => window.VH.setTime(t), time);
  await sleep(600);
  for (const type of ['woolback', 'gloomling']) {
    await page.evaluate((c) => {
      const em = window.__VOXELHAVEN__.entityManager;
      em.entities = em.entities.filter((e) => e.type === 'item');
      window.VH.teleport(c.x, c.y, c.z);
      const dx = c.tx - c.x, dy = c.ty - (c.y + 1.62), dz = c.tz - c.z;
      window.VH.look(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    }, { x: arena.x + 3, y: arena.y, z: arena.z + 3.2, tx: arena.x + 3, ty: arena.y + 0.6, tz: arena.z });
    await sleep(800);
    const info = await page.evaluate(async (c) => {
      const game = window.__VOXELHAVEN__;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const mob = await window.VH.spawnMobAt(c.type, c.x, c.y, c.z);
      await wait(400);
      const e = game.entityManager.entities.find((x) => x.type === c.type);
      if (!e) return null;
      // Pin it and freeze so the shot is stable.
      const original = game.tick.bind(game);
      game.__pin = () => {
        e.x = c.x; e.y = c.y; e.z = c.z;
        e.velocityX = 0; e.velocityY = 0; e.velocityZ = 0;
        e.yaw = -Math.PI / 2; e.walkPhase = 0; e.hurtFlash = 0;
        e.state = 'idle'; e.stateTimer = 999;
      };
      game.tick = function (now) { if (game.__freezeTick) { game.__pin(); return; } return original(now); };
      game.__freezeTick = true;
      game.__pin();
      await wait(120);
      const bx = Math.floor(e.x), by = Math.floor(e.y + e.height * 0.5), bz = Math.floor(e.z);
      return {
        mob: { type: e.type, hurtFlash: e.hurtFlash, x: e.x, y: e.y, z: e.z, height: e.height },
        light: { sky: game.world.getSkyLight(bx, by, bz), block: game.world.getBlockLight(bx, by, bz) },
        time: game.timeSystem.getEnvironment().dayBrightness
      };
    }, { type, x: arena.x + 3, y: arena.y, z: arena.z });
    if (!info) { console.log(`${type}: failed to spawn`); continue; }
    const file = await screenshot(page, `probe-color-${label}-${type}`);
    // The mob's screen box, computed the same way as the main probe.
    const box = await page.evaluate((c) => {
      const game = window.__VOXELHAVEN__;
      const P = window.__PROBE__;
      const e = game.entityManager.entities.find((x) => x.type === c.type);
      // project the model union by hand
      const m = game.camera.viewProjection, canvas = game.canvas;
      const proj = (x, y, z) => {
        const cx = m[0] * x + m[4] * y + m[8] * z + m[12];
        const cy = m[1] * x + m[5] * y + m[9] * z + m[13];
        const cw = m[3] * x + m[7] * y + m[11] * z + m[15];
        return cw <= 1e-6 ? null : { x: (cx / cw * .5 + .5) * canvas.width, y: (.5 - cy / cw * .5) * canvas.height };
      };
      let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
      const h = e.height * 0.5, w = 0.5;
      for (const dx of [-w, w]) for (const dy of [-h, h]) for (const dz of [-w, w]) {
        const p = proj(e.x + dx, e.y + h + dy, e.z + dz);
        if (!p) continue;
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
      return { x: Math.round(minX), y: Math.round(minY), w: Math.round(maxX - minX), h: Math.round(maxY - minY) };
    }, { type });
    const img = decodePng(file);
    const centre = {
      x: Math.round(box.x + box.w * 0.35), y: Math.round(box.y + box.h * 0.3),
      w: Math.max(8, Math.round(box.w * 0.3)), h: Math.max(8, Math.round(box.h * 0.3))
    };
    results[`${label}-${type}`] = { info, box, sample: stats(img, centre.x, centre.y, centre.w, centre.h), file: path.basename(file) };
    console.log(`\n=== ${label} / ${type} ===`);
    console.log(`  mob state   ${JSON.stringify(info.mob)}`);
    console.log(`  light       sky=${info.light.sky} block=${info.light.block} dayBrightness=${info.time}`);
    console.log(`  screen box  ${JSON.stringify(box)}`);
    console.log(`  crop        ${JSON.stringify(centre)}`);
    console.log(`  mean rgb    ${results[`${label}-${type}`].sample.mean.join(',')}   distinct colours=${results[`${label}-${type}`].sample.distinct}`);
    console.log(`  top colours ${results[`${label}-${type}`].sample.top.join('  ')}`);
    console.log(`  file        ${results[`${label}-${type}`].file}`);
    await page.evaluate(() => { window.__VOXELHAVEN__.__freezeTick = false; });
  }
  }
} finally {
  await browser.close();
  await server.stop();
}
