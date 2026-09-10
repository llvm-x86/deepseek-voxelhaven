/**
 * terrain.worker.js — generates chunks off the main thread.
 *
 * Terrain generation costs a couple of milliseconds of pure computation per
 * chunk. Running it in a pool of workers keeps the frame time smooth while a
 * large render distance streams in.
 *
 * Protocol
 *   main -> worker  { type: 'init', seed }
 *   main -> worker  { type: 'generate', jobId, cx, cz }
 *   worker -> main  { type: 'ready' }
 *   worker -> main  { type: 'generated', jobId, cx, cz, blocks, heightMap, opaqueHeightMap }
 *   worker -> main  { type: 'error', jobId, cx, cz, message }
 *
 * All typed arrays are transferred, not copied.
 */

import { TerrainGenerator } from '../world/TerrainGenerator.js';

/** @type {TerrainGenerator|null} */
let generator = null;

self.onmessage = (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  switch (message.type) {
    case 'init': {
      try {
        generator = new TerrainGenerator(message.seed | 0);
        self.postMessage({ type: 'ready', seed: generator.seed });
      } catch (err) {
        self.postMessage({ type: 'fatal', message: String(err && err.message ? err.message : err) });
      }
      break;
    }

    case 'generate': {
      const { jobId, cx, cz } = message;
      if (!generator) {
        self.postMessage({ type: 'error', jobId, cx, cz, message: 'worker not initialised' });
        return;
      }
      try {
        const chunk = generator.generateChunk(cx, cz);
        const blocks = chunk.blocks;
        const heightMap = chunk.heightMap;
        const opaqueHeightMap = chunk.opaqueHeightMap;
        self.postMessage({
          type: 'generated',
          jobId,
          cx,
          cz,
          blocks: blocks.buffer,
          heightMap: heightMap.buffer,
          opaqueHeightMap: opaqueHeightMap.buffer,
          error: chunk.error || null
        }, [blocks.buffer, heightMap.buffer, opaqueHeightMap.buffer]);
      } catch (err) {
        self.postMessage({
          type: 'error',
          jobId,
          cx,
          cz,
          message: String(err && err.message ? err.message : err)
        });
      }
      break;
    }

    default:
      break;
  }
};
