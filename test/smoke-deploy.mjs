/**
 * smoke-deploy.mjs — verify the *running* server serves a bootable, playable
 * game with the crafting system live.
 *
 * Checks the deployed URL rather than the filesystem, so it catches the case a
 * static file check cannot: modules that 200 individually but fail to boot
 * together (import errors, missing atlas tiles, a broken recipe fetch).
 *
 * Run: node test/smoke-deploy.mjs [url]
 */

import puppeteer from 'puppeteer-core';
import { findChrome } from './headless.mjs';

const url = process.argv[2] || 'http://127.0.0.1:8123/';
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--disable-gpu-sandbox', '--window-size=1280,720', '--mute-audio'
  ],
  defaultViewport: { width: 1280, height: 720 },
  protocolTimeout: 180000
});

const page = await browser.newPage();
const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('requestfailed', (r) => failedRequests.push(`${r.url()} — ${r.failure()?.errorText}`));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  \u2713 ${name}`); }
  else { fail++; console.log(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`); }
};

try {
  console.log(`\nSmoke-testing deployed server: ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Boot to the main menu.
  for (let i = 0; i < 600; i++) {
    const ready = await page.evaluate(() => {
      const g = window.__VOXELHAVEN__;
      return !!g && g.state !== 'boot';
    }).catch(() => false);
    if (ready) break;
    if (i === 599) throw new Error('game never finished booting');
    await new Promise((r) => setTimeout(r, 100));
  }
  check('the deployed page boots past the boot state', true);

  await page.evaluate(() => window.VH.createWorld({ seed: 777, name: 'deploy-smoke', peaceful: true }));
  for (let i = 0; i < 900; i++) {
    const s = await page.evaluate(() => window.__VOXELHAVEN__?.state).catch(() => null);
    if (s === 'playing') break;
    if (i === 899) throw new Error('world never reached playing');
    await new Promise((r) => setTimeout(r, 100));
  }
  check('a new world reaches the playing state', true);

  await page.evaluate(() => window.VH.setRenderDistance(3));
  await new Promise((r) => setTimeout(r, 6000));

  const info = await page.evaluate(() => {
    const g = window.__VOXELHAVEN__;
    const book = g.recipeBook ? g.recipeBook() : null;
    return {
      chunks: g.world ? g.world.chunkCount : 0,
      triangles: g.renderer ? g.renderer.stats.triangles : 0,
      drawCalls: g.renderer ? g.renderer.stats.drawCalls : 0,
      recipes: book && Array.isArray(book.recipes) ? book.recipes.length : -1,
      smelting: book && Array.isArray(book.smelting) ? book.smelting.length : -1,
      atlasTiles: g.renderer && g.renderer.atlas ? g.renderer.atlas.tileCount : 0,
      hasHandTile: g.renderer && g.renderer.atlas ? g.renderer.atlas.indexOf('hand') >= 0 : false
    };
  });

  check('chunks are loaded', info.chunks > 0, `${info.chunks} chunks`);
  check('the renderer is drawing geometry', info.triangles > 0, `${info.triangles} triangles, ${info.drawCalls} draw calls`);
  check('the recipe book loaded over the network', info.recipes === 30, `${info.recipes} recipes, ${info.smelting} smelting`);
  check('the hand atlas tile is present', info.hasHandTile, `${info.atlasTiles} tiles`);

  // The crafting screen must actually open and show its grid.
  await page.evaluate(() => window.VH.setAction('inventory', true));
  await page.evaluate(() => window.VH.setAction('inventory', false));
  await new Promise((r) => setTimeout(r, 900));
  const ui = await page.evaluate(() => {
    const g = window.__VOXELHAVEN__;
    const all = [...document.querySelectorAll('.slot')];
    const roles = all.map((el) => el.dataset.role);
    // The grid markup always holds 9 cells; only `grid.size` of them are shown.
    const visibleCraft = all.filter((el) => el.dataset.role === 'craft'
      && !el.classList.contains('is-hidden')).length;
    return {
      state: g.state,
      station: document.querySelector('#inventory')?.dataset.station
        || document.querySelector('[data-station]')?.dataset.station || '',
      title: (document.getElementById('inventory-title') || {}).textContent || '',
      visibleCraft,
      resultSlots: roles.filter((r) => r === 'result').length,
      totalSlots: all.length,
      recipeEntries: document.querySelectorAll('.craft-entry').length
    };
  });
  check('the inventory/crafting screen opens', ui.state === 'inventory', `state=${ui.state}`);
  check('the screen is titled "Inventory"', ui.title === 'Inventory', `title="${ui.title}"`);
  check('the inventory grid shows 2x2', ui.visibleCraft === 4, `${ui.visibleCraft} visible craft slots, station=${ui.station}`);
  check('a result slot is shown', ui.resultSlots >= 1, `${ui.resultSlots} result slots`);
  check('the recipe browser lists recipes', ui.recipeEntries > 0, `${ui.recipeEntries} entries`);

  // Pixel sanity: the frame must not be a single flat colour.
  const pixel = await page.evaluate(() => {
    const g = window.__VOXELHAVEN__;
    const gl = g.canvas.getContext('webgl2');
    const buf = new Uint8Array(1280 * 720 * 4);
    gl.readPixels(0, 0, 1280, 720, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    const seen = new Set();
    for (let i = 0; i < buf.length; i += 4 * 97) {
      seen.add((buf[i] << 16) | (buf[i + 1] << 8) | buf[i + 2]);
    }
    return { distinct: seen.size, glError: gl.getError() };
  });
  check('the frame is not a flat colour', pixel.distinct > 50, `${pixel.distinct} distinct sampled colours`);
  check('no GL error after rendering', pixel.glError === 0, `glError=${pixel.glError}`);
  check('no page errors', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '));
  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
  check('no failed requests', failedRequests.length === 0, failedRequests.slice(0, 3).join(' | '));

  await page.screenshot({ path: 'test/screenshots/deploy-smoke.png' });
  console.log('\n  screenshot: test/screenshots/deploy-smoke.png');
  console.log(`\n${'─'.repeat(50)}\n  ${pass} passed, ${fail} failed\n${'─'.repeat(50)}\n`);
} finally {
  await browser.close();
}
process.exit(fail === 0 ? 0 : 1);
