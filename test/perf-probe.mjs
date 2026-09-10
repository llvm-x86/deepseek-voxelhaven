/**
 * perf-probe.mjs — measures meshing and generation cost so mesher changes can be
 * reported with real before/after numbers.
 *
 *   node test/perf-probe.mjs [label]
 *
 * Prints a single JSON blob to stdout. Deliberately does not touch the network
 * and uses a fixed seed so runs are comparable.
 */

import { startServer, launchGame, waitForState, sleep } from './headless.mjs';

const label = process.argv[2] || 'run';
const PORT = 8396;

const server = await startServer(PORT);
const { browser, page, consoleErrors, pageErrors } = await launchGame({ url: server.url });

try {
  await page.evaluate(() => window.VH.createWorld({ seed: 4242, name: 'perf' }));
  await waitForState(page, ['playing'], 120000);
  await page.evaluate(() => window.VH.setRenderDistance(8));

  // Let the world stream in fully so we measure steady state, not backlog.
  await sleep(30000);

  const result = await page.evaluate(() => {
    const game = window.__VOXELHAVEN__;
    const world = game.world;
    const builder = game.chunkManager.meshBuilder;

    // --- Generation cost: time raw terrain generation for fresh chunks. ----
    const genTimes = [];
    for (let i = 0; i < 30; i++) {
      const cx = 400 + i;
      const cz = 400;
      const t0 = performance.now();
      const data = world.generator.generateChunk(cx, cz);
      genTimes.push(performance.now() - t0);
      void data;
    }

    // --- Mesh cost + geometry counts on the live chunks around the player. --
    const chunks = Array.from(world.chunks.values()).filter((c) => c.state >= 3);
    const meshTimes = [];
    let verts = 0, quads = 0, counted = 0;
    let minY = Infinity, maxY = -Infinity;

    // Three passes over the same chunk set: the first warms the JIT and the
    // scratch buffers, so report the median pass rather than the cold one.
    const passTimes = [];
    for (let pass = 0; pass < 3; pass++) {
      meshTimes.length = 0;
      let pv = 0, pq = 0, pc = 0;
      for (const chunk of chunks) {
        const t0 = performance.now();
        const built = builder.build(chunk, world);
        meshTimes.push(performance.now() - t0);
        if (pass === 2) {
          if (built.opaque) {
            pv += built.opaque.vertices.length / 11;
            pq += built.opaque.indices.length / 6;
            const v = built.opaque.vertices;
            for (let i = 1; i < v.length; i += 11) {
              const y = v[i];
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
            }
          }
          if (built.transparent) {
            pv += built.transparent.vertices.length / 11;
            pq += built.transparent.indices.length / 6;
          }
          pc++;
        }
      }
      passTimes.push(meshTimes.reduce((s, v) => s + v, 0) / Math.max(1, meshTimes.length));
      if (pass === 2) { verts = pv; quads = pq; counted = pc; }
    }
    const medianMesh = passTimes.slice().sort((a, b) => a - b)[1];

    const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
    const sortedMesh = meshTimes.slice().sort((a, b) => a - b);
    const p95 = sortedMesh.length ? sortedMesh[Math.floor(sortedMesh.length * 0.95)] : 0;

    // --- Live render stats at the moment of measurement. -------------------
    const rs = game.renderer.stats;
    return {
      chunksMeshed: counted,
      verticesTotal: verts,
      quadsTotal: quads,
      verticesPerChunk: counted ? +(verts / counted).toFixed(1) : 0,
      quadsPerChunk: counted ? +(quads / counted).toFixed(1) : 0,
      meshMsMean: +medianMesh.toFixed(3),
      meshMsWarmP95: +p95.toFixed(3),
      genMsMean: +mean(genTimes).toFixed(3),
      visibleTriangles: rs.triangles,
      drawCalls: rs.drawCalls,
      gpuMB: +(game.renderer.chunkRenderer.stats.gpuBytes / 1048576).toFixed(1),
      loadedChunks: world.chunkCount,
      vertexYRange: counted ? [minY, maxY] : null
    };
  });

  console.log(JSON.stringify({ label, ...result, pageErrors: pageErrors.length, consoleErrors: consoleErrors.length }));
} finally {
  await browser.close().catch(() => {});
  await server.stop();
}
