/**
 * headless.mjs — a small helper around puppeteer-core for driving Voxelhaven
 * in a real browser.
 *
 * Used by run-tests.mjs. It boots the game server, launches Chrome (headless by
 * default) with software WebGL so it works without a GPU, and exposes helpers
 * for clicking, pressing keys and evaluating code inside the page.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

/** Chrome locations to try, in order. */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  `${process.env.HOME}/.cache/puppeteer/chrome`,
  `${process.env.HOME}/.cache/ms-playwright`
].filter(Boolean);

/** Recursively find a chrome binary under a directory. */
function findChromeIn(dir, depth = 0) {
  if (depth > 4) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && (entry.name === 'chrome' || entry.name === 'headless_shell')) return full;
    if (entry.isDirectory()) {
      const found = findChromeIn(full, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Resolve an executable Chrome binary, or throw with a helpful message. */
export function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile()) return candidate;
      if (stat.isDirectory()) {
        const found = findChromeIn(candidate);
        if (found) return found;
      }
    } catch {
      // Not present; try the next candidate.
    }
  }
  throw new Error(
    'Could not find a Chrome/Chromium binary. Set CHROME_PATH to the executable, ' +
    'or install Chrome. Headless tests need a WebGL2-capable browser.'
  );
}

/**
 * Start the Voxelhaven server as a child process.
 * @param {number} port
 * @returns {Promise<{process:import('node:child_process').ChildProcess, url:string, stop:()=>Promise<void>}>}
 */
export function startServer(port) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js', '--port', String(port), '--host', '127.0.0.1'], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let settled = false;
    const onData = (buffer) => {
      const text = buffer.toString();
      if (!settled && text.includes('Voxelhaven server running')) {
        settled = true;
        resolve({
          process: child,
          url: `http://127.0.0.1:${port}/`,
          stop: () => new Promise((done) => {
            child.once('exit', () => done());
            child.kill('SIGTERM');
            setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } done(); }, 1500);
          })
        });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (buffer) => {
      const text = buffer.toString();
      if (!settled) reject(new Error(`server failed to start: ${text}`));
      else process.stderr.write(`[server] ${text}`);
    });
    child.on('exit', (code) => {
      if (!settled) reject(new Error(`server exited early with code ${code}`));
    });
    setTimeout(() => {
      if (!settled) reject(new Error('server did not start within 15 seconds'));
    }, 15000);
  });
}

/**
 * Launch a browser and open the game.
 * @param {object} options
 * @param {string} options.url
 * @param {boolean} [options.headless]
 * @param {number} [options.width]
 * @param {number} [options.height]
 */
export async function launchGame({ url, headless = true, width = 1280, height = 720 }) {
  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      // Force a software GL implementation so the tests run on machines with
      // no GPU and inside containers.
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-gpu-sandbox',
      `--window-size=${width},${height}`,
      '--mute-audio',
      '--hide-scrollbars'
    ],
    defaultViewport: { width, height },
    protocolTimeout: 180000
  });

  const page = await browser.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (message) => {
    const type = message.type();
    const text = message.text();
    if (type === 'error') consoleErrors.push(text);
    if (process.env.VERBOSE_TESTS) console.log(`  [page:${type}] ${text}`);
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
    if (process.env.VERBOSE_TESTS) console.log(`  [pageerror] ${error.message}`);
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Wait for the game object and for boot to reach the main menu, so callers
  // never race the startup sequence.
  const bootStart = Date.now();
  for (;;) {
    const ready = await page.evaluate(() => {
      const game = window.__VOXELHAVEN__;
      return !!game && game.state !== 'boot';
    }).catch(() => false);
    if (ready) break;
    if (Date.now() - bootStart > 60000) throw new Error('the game did not finish booting within 60 seconds');
    await new Promise((r) => setTimeout(r, 100));
  }

  return {
    browser,
    page,
    consoleErrors,
    pageErrors,
    async close() {
      await browser.close().catch(() => {});
    }
  };
}

/**
 * Wait until the debug API exists and the game reaches one of the given states.
 * @param {import('puppeteer-core').Page} page
 * @param {string[]} states
 * @param {number} [timeoutMs]
 */
export async function waitForState(page, states, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const state = await page.evaluate(() => {
      const game = window.__VOXELHAVEN__;
      return game ? game.state : null;
    }).catch(() => null);
    if (state && states.includes(state)) return state;
    await sleep(120);
  }
  const actual = await page.evaluate(() => (window.__VOXELHAVEN__ ? window.__VOXELHAVEN__.state : 'no game object')).catch(() => 'unreadable');
  throw new Error(`timed out waiting for state ${states.join('|')} (currently "${actual}")`);
}

/** Wait until a predicate evaluated in the page returns true. */
export async function waitFor(page, predicateSource, timeoutMs = 60000, label = 'condition') {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await page.evaluate(predicateSource).catch(() => false);
    if (ok) return true;
    await sleep(120);
  }
  throw new Error(`timed out waiting for ${label}`);
}

/** Click a DOM element by CSS selector (via the page, not real mouse input). */
export async function clickSelector(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 15000 });
  await page.click(selector);
}

/** Sleep helper. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Take a screenshot into the test output directory. */
export async function screenshot(page, name) {
  const dir = path.join(PROJECT_ROOT, 'test', 'screenshots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${name}.png`);
  await page.screenshot({ path: file });
  return file;
}

export { PROJECT_ROOT };
