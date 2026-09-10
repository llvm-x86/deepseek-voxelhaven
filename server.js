/**
 * Voxelhaven development / play server.
 *
 * Zero dependencies: uses only Node's built-in modules.
 *
 * Responsibilities
 *  1. Serve the static game client (index.html, styles.css, src/**) with correct MIME types.
 *  2. Provide a tiny JSON document store for world saves under ./saves/<id>.json.
 *     The browser cannot write files directly, so the save system talks to this API.
 *     A localStorage backend exists as a fallback when the API is unreachable.
 *
 * Usage:  node server.js [--port 8080] [--host 127.0.0.1] [--no-saves]
 */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
function readFlag(name, fallback) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PORT = Number(readFlag('--port', process.env.PORT || 8123));
const HOST = readFlag('--host', '127.0.0.1');
const SAVES_ENABLED = !argv.includes('--no-saves');
const SAVES_DIR = path.join(__dirname, 'saves');
const ROOT = __dirname;

/** Maximum accepted save payload (bytes). Voxel deltas are small; 48 MB is generous. */
const MAX_SAVE_BYTES = 48 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.woff2': 'font/woff2'
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

/**
 * Resolve a request path to a real file inside ROOT.
 * Returns null when the path escapes the root or contains a NUL byte.
 */
function resolveStaticPath(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const abs = path.resolve(ROOT, rel);
  if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) return null;
  return abs;
}

/** Save ids become filenames, so they must be strictly sanitised. */
function isValidSaveId(id) {
  return typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);
}

function saveFilePath(id) {
  return path.join(SAVES_DIR, `${id}.json`);
}

async function ensureSavesDir() {
  await fsp.mkdir(SAVES_DIR, { recursive: true });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_SAVE_BYTES) {
        reject(Object.assign(new Error('payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

async function handleApi(req, res, url) {
  if (!SAVES_ENABLED) {
    sendJson(res, 503, { error: 'save storage disabled (server started with --no-saves)' });
    return true;
  }
  const parts = url.pathname.split('/').filter(Boolean); // ['api','saves', id?]

  if (parts[1] !== 'saves') return false;

  const id = parts[2];

  // GET /api/saves  -> list of {id, name, seed, updatedAt, createdAt, version}
  if (req.method === 'GET' && !id) {
    await ensureSavesDir();
    const files = (await fsp.readdir(SAVES_DIR)).filter((f) => f.endsWith('.json'));
    const summaries = [];
    for (const file of files) {
      try {
        const raw = await fsp.readFile(path.join(SAVES_DIR, file), 'utf8');
        const data = JSON.parse(raw);
        summaries.push({
          id: file.replace(/\.json$/, ''),
          name: typeof data?.name === 'string' ? data.name : 'Unnamed World',
          seed: data?.seed ?? null,
          createdAt: data?.createdAt ?? null,
          updatedAt: data?.updatedAt ?? null,
          version: data?.version ?? 1,
          playTimeMs: data?.stats?.playTimeMs ?? 0
        });
      } catch {
        // A corrupt save must never take down the whole list; surface it instead.
        summaries.push({
          id: file.replace(/\.json$/, ''),
          name: '⚠ Corrupt save',
          corrupt: true,
          updatedAt: null
        });
      }
    }
    summaries.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    sendJson(res, 200, { saves: summaries });
    return true;
  }

  if (id && !isValidSaveId(id)) {
    sendJson(res, 400, { error: 'invalid save id' });
    return true;
  }

  // GET /api/saves/:id -> full save document
  if (req.method === 'GET' && id) {
    try {
      const raw = await fsp.readFile(saveFilePath(id), 'utf8');
      const parsed = JSON.parse(raw);
      sendJson(res, 200, parsed);
    } catch (err) {
      if (err.code === 'ENOENT') sendJson(res, 404, { error: 'save not found' });
      else sendJson(res, 500, { error: 'save is corrupt and could not be parsed' });
    }
    return true;
  }

  // PUT /api/saves/:id -> create or overwrite
  if (req.method === 'PUT' && id) {
    await ensureSavesDir();
    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      sendJson(res, err.statusCode || 400, { error: err.message });
      return true;
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      sendJson(res, 400, { error: 'request body is not valid JSON' });
      return true;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { error: 'save must be a JSON object' });
      return true;
    }
    // Atomic-ish write: write to a temp file then rename so a crash mid-write
    // cannot leave a half-written save behind.
    const target = saveFilePath(id);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await fsp.writeFile(tmp, body, 'utf8');
      await fsp.rename(tmp, target);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      sendJson(res, 500, { error: `could not write save: ${err.message}` });
      return true;
    }
    sendJson(res, 200, { ok: true, id, bytes: Buffer.byteLength(body) });
    return true;
  }

  // DELETE /api/saves/:id
  if (req.method === 'DELETE' && id) {
    try {
      await fsp.unlink(saveFilePath(id));
      sendJson(res, 200, { ok: true });
    } catch (err) {
      if (err.code === 'ENOENT') sendJson(res, 404, { error: 'save not found' });
      else sendJson(res, 500, { error: err.message });
    }
    return true;
  }

  sendJson(res, 405, { error: `method ${req.method} not allowed` });
  return true;
}

// ---------------------------------------------------------------------------
// Static file serving
// ---------------------------------------------------------------------------

async function handleStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';

  const abs = resolveStaticPath(pathname);
  if (!abs) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`404 Not Found: ${pathname}`);
    return;
  }

  if (stat.isDirectory()) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';
  const etag = `W/"${stat.size}-${stat.mtimeMs}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304);
    res.end();
    return;
  }

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
    ETag: etag
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(abs).pipe(res);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    res.writeHead(400).end('400 Bad Request');
    return;
  }

  // Permissive CORS so the client also works when served from a different origin
  // (for example a static file server) while the API stays on this port.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  try {
    if (url.pathname.startsWith('/api/')) {
      const handled = await handleApi(req, res, url);
      if (!handled && !res.writableEnded) sendJson(res, 404, { error: 'unknown api route' });
      return;
    }
    await handleStatic(req, res, url);
  } catch (err) {
    console.error('[server] unhandled error:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('500 Internal Server Error');
    } else {
      res.end();
    }
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log('');
  console.log('  ⛏  Voxelhaven server running');
  console.log(`     Open:  http://${shown}:${PORT}/`);
  console.log(`     Saves: ${SAVES_ENABLED ? SAVES_DIR : 'disabled'}`);
  console.log('     Stop:  Ctrl+C');
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[server] port ${PORT} is already in use. Try: node server.js --port ${PORT + 1}`);
  } else {
    console.error('[server] fatal:', err);
  }
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    // Do not hang forever waiting for keep-alive sockets.
    setTimeout(() => process.exit(0), 500).unref();
  });
}
