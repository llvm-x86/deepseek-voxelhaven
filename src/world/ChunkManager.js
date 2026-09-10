/**
 * ChunkManager.js — streams the world in and out around the player.
 *
 * Responsibilities
 *  - decide which chunks should exist (a circular region around the player)
 *  - queue missing chunks for generation, in nearest-first order
 *  - hand generation work to a pool of Web Workers (with a synchronous
 *    fallback when workers are unavailable)
 *  - schedule lighting and meshing within a per-frame time budget so the frame
 *    rate never collapses while the world loads
 *  - upload finished meshes to the renderer, a few per frame
 *  - unload chunks that fall outside the render distance, keeping their edit
 *    deltas so the player's changes are never lost
 *
 * Nothing here runs per block per frame: every stage is queued, budgeted and
 * driven by dirty flags.
 */

import {
  CHUNK_SIZE, RENDER_DISTANCE, UNLOAD_MARGIN, FRAME_BUDGET_MS,
  LIGHT_BUDGET_MS, MAX_MESH_UPLOADS_PER_FRAME, TERRAIN_WORKERS
} from '../core/Config.js';
import { ChunkState } from './Chunk.js';
import { chunkKey } from './World.js';
import { LightEngine } from './LightEngine.js';
import { MeshBuilder } from './MeshBuilder.js';

/** How long to wait for a worker to answer before assuming it is dead. */
const WORKER_JOB_TIMEOUT_MS = 12000;

/** Maximum chunks rebuilt per frame while resolving a player edit. */
const MAX_PRIORITY_CHUNKS_PER_FRAME = 3;

/** Time budget for the player-edit rebuild, in milliseconds. */
const PRIORITY_BUDGET_MS = 7;

export class ChunkManager {
  /**
   * @param {import('./World.js').World} world
   * @param {import('../core/EventBus.js').EventBus} bus
   * @param {object} meshSink { upload(key, cx, cz, data), remove(key) }
   * @param {object} atlas texture atlas, used to resolve face tiles
   */
  constructor(world, bus, meshSink, atlas) {
    this.world = world;
    this.bus = bus;
    this.meshSink = meshSink;
    this.lightEngine = new LightEngine();
    this.meshBuilder = new MeshBuilder(atlas);
    this.meshBuilder.buildFaceTable((name) => atlas.indexOf(name), 16);

    /** Chunks queued for generation: key -> {cx, cz, distance, requested}. */
    this.generationQueue = new Map();
    /** Chunks needing lighting and/or meshing. */
    this.workQueue = new Set();
    /**
     * Chunks that must be rebuilt before anything else because the player just
     * changed them. Without this a placed lantern could sit unlit for seconds
     * behind a backlog of streaming work.
     */
    this.priorityWork = new Set();
    /**
     * In-flight rebuild of the chunks a player edit affected.
     *
     * Lighting happens in two passes over the same set. Pass 1 clears and
     * re-seeds every affected chunk, wiping all light that flowed out of the
     * edit. Pass 2 re-imports light across the borders, now that no chunk in
     * the set still holds stale values. A single pass would let a removed
     * lantern's light flow back in from a neighbour that had not been cleared
     * yet.
     *
     * @type {{keys: string[], index: number, phase: number}|null}
     */
    this.lightBatch = null;
    /** Keys whose mesh should be dropped from the GPU but whose data stays. */
    this.pendingMeshCount = 0;

    /** Runtime-configurable render distance, in chunks (see Config.RENDER_DISTANCE). */
    this.renderDistance = RENDER_DISTANCE;

    this.lastCentreCx = NaN;
    this.lastCentreCz = NaN;
    this.forceRescan = true;

    /** Diagnostics. */
    this.stats = {
      generated: 0,
      meshed: 0,
      uploaded: 0,
      unloaded: 0,
      generationQueueLength: 0,
      workQueueLength: 0,
      inFlight: 0,
      lastMeshMs: 0,
      lastLightMs: 0,
      workers: 0,
      usingWorkers: false,
      generationErrors: 0
    };

    this._initWorkers();

    // Player edits jump the queue. World has already flagged exactly the
    // chunks whose light or mesh the change can affect.
    this.bus.on('blockChanged', ({ cx, cz }) => {
      const own = this.world.getChunk(cx, cz);
      if (own && own.hasData) this.priorityWork.add(own.key);
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const neighbour = this.world.getChunk(cx + dx, cz + dz);
          if (neighbour && neighbour.hasData && (neighbour.lightDirty || neighbour.meshDirty)) {
            this.priorityWork.add(neighbour.key);
          }
        }
      }
    });
  }

  /** Create the worker pool, falling back to synchronous generation on failure. */
  _initWorkers() {
    /** @type {Array<{worker:Worker, busy:boolean, jobId:number, cx:number, cz:number, startedAt:number}>} */
    this.workers = [];
    this.jobIdCounter = 0;
    /** @type {Map<number, {workerEntry:object, cx:number, cz:number}>} */
    this.inFlight = new Map();

    if (TERRAIN_WORKERS <= 0 || typeof Worker === 'undefined') return;

    for (let i = 0; i < TERRAIN_WORKERS; i++) {
      try {
        const worker = new Worker(new URL('../workers/terrain.worker.js', import.meta.url), { type: 'module' });
        const entry = { worker, busy: false, jobId: -1, cx: 0, cz: 0, startedAt: 0 };
        worker.onmessage = (event) => this._onWorkerMessage(entry, event);
        worker.onerror = (event) => {
          console.warn('[ChunkManager] terrain worker error, falling back to main thread:', event.message || event);
          entry.dead = true;
          entry.busy = false;
          this.stats.usingWorkers = this.workers.some((w) => !w.dead);
        };
        worker.postMessage({ type: 'init', seed: this.world.seed });
        this.workers.push(entry);
      } catch (err) {
        console.warn('[ChunkManager] could not start terrain worker:', err);
        break;
      }
    }
    this.stats.workers = this.workers.length;
    this.stats.usingWorkers = this.workers.length > 0;
  }

  /** Handle a finished (or failed) generation job. */
  _onWorkerMessage(entry, event) {
    const message = event.data;
    if (!message) return;
    if (message.type === 'ready') return;

    entry.busy = false;
    this.inFlight.delete(message.jobId);

    if (message.type === 'error') {
      this.stats.generationErrors++;
      console.warn(`[ChunkManager] generation failed for chunk ${message.cx},${message.cz}: ${message.message}`);
      this._applyFallbackChunk(message.cx, message.cz);
      this.bus.emit('chunkGenerationFailed', { cx: message.cx, cz: message.cz, message: message.message });
      return;
    }

    if (message.type === 'generated') {
      this._acceptGeneratedChunk(message.cx, message.cz, message);
    }
  }

  /**
   * Install a generated chunk coming back from a worker.
   * The typed arrays arrive as transferred ArrayBuffers.
   */
  _acceptGeneratedChunk(cx, cz, message) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk) return; // the chunk was unloaded before generation finished

    chunk.blocks = new Uint8Array(message.blocks);
    chunk.heightMap = new Int16Array(message.heightMap);
    chunk.opaqueHeightMap = new Int16Array(message.opaqueHeightMap);
    chunk.error = message.error || null;

    this.world.applyEdits(chunk);
    chunk.state = ChunkState.GENERATED;
    chunk.lightDirty = true;
    chunk.meshDirty = true;
    this.world.stats.generated++;
    this.stats.generated++;

    // A newly generated neighbour changes which faces are visible on the chunks
    // around it, so their meshes must be rebuilt.
    this._markNeighboursDirty(cx, cz, false);
    this.workQueue.add(chunk.key);
    this.bus.emit('chunkGenerated', { cx, cz });
  }

  /** Build a minimal stand-in chunk when generation fails unrecoverably. */
  _applyFallbackChunk(cx, cz) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk || chunk.hasData) return;
    chunk.blocks.fill(0);
    const groundY = 64;
    for (let z = 0; z < CHUNK_SIZE; z++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        for (let y = 0; y <= groundY; y++) {
          chunk.blocks[(y * CHUNK_SIZE + z) * CHUNK_SIZE + x] = y === groundY ? 1 : 3;
        }
      }
    }
    chunk.recomputeHeightMaps();
    chunk.state = ChunkState.GENERATED;
    chunk.lightDirty = true;
    chunk.meshDirty = true;
    this.workQueue.add(chunk.key);
  }

  /** Generate a chunk on the main thread (fallback / no-worker path). */
  _generateSync(cx, cz) {
    const chunk = this.world.getChunk(cx, cz);
    if (!chunk || chunk.hasData) return;
    const generated = this.world.generator.generateChunk(cx, cz);
    chunk.blocks = generated.blocks;
    chunk.heightMap = generated.heightMap;
    chunk.opaqueHeightMap = generated.opaqueHeightMap;
    chunk.error = generated.error;
    this.world.applyEdits(chunk);
    chunk.state = ChunkState.GENERATED;
    chunk.lightDirty = true;
    chunk.meshDirty = true;
    this.world.stats.generated++;
    this.stats.generated++;
    this._markNeighboursDirty(cx, cz, false);
    this.workQueue.add(chunk.key);
  }

  /** Mark the four direct neighbours for a mesh rebuild. */
  _markNeighboursDirty(cx, cz, includeLight) {
    const offsets = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (const [dx, dz] of offsets) {
      const neighbour = this.world.getChunk(cx + dx, cz + dz);
      if (!neighbour || !neighbour.hasData) continue;
      neighbour.meshDirty = true;
      if (includeLight) neighbour.lightDirty = true;
      this.workQueue.add(neighbour.key);
    }
  }

  /**
   * Advance streaming. Call once per frame.
   * @param {number} playerX
   * @param {number} playerZ
   */
  update(playerX, playerZ) {
    const centreCx = Math.floor(playerX / CHUNK_SIZE);
    const centreCz = Math.floor(playerZ / CHUNK_SIZE);

    // Only rescan the world when the player crosses into a new chunk (or when
    // explicitly forced), so the per-frame cost is normally a few map lookups.
    if (this.forceRescan || centreCx !== this.lastCentreCx || centreCz !== this.lastCentreCz) {
      this.lastCentreCx = centreCx;
      this.lastCentreCz = centreCz;
      this.forceRescan = false;
      this._rescan(centreCx, centreCz);
    }

    this._dispatchGeneration();
    this._checkWorkerTimeouts();
    this._processWorkQueue(playerX, playerZ);
    this._unloadDistant(centreCx, centreCz);

    this.stats.generationQueueLength = this.generationQueue.size;
    this.stats.workQueueLength = this.workQueue.size + this.priorityWork.size;
    this.stats.inFlight = this.inFlight.size;
  }

  /** Ensure every chunk inside the render distance exists and is queued. */
  _rescan(centreCx, centreCz) {
    const radius = this.renderDistance;
    const radiusSq = (radius + 0.5) * (radius + 0.5);

    // Drop queued work for chunks that are no longer wanted.
    for (const [key, job] of this.generationQueue) {
      const dx = job.cx - centreCx;
      const dz = job.cz - centreCz;
      if (dx * dx + dz * dz > radiusSq) this.generationQueue.delete(key);
    }

    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq > radiusSq) continue;
        const cx = centreCx + dx;
        const cz = centreCz + dz;
        const chunk = this.world.ensureChunk(cx, cz);
        chunk.distanceToPlayer = Math.sqrt(distanceSq);
        if (chunk.state === ChunkState.EMPTY && !this.generationQueue.has(chunk.key)) {
          this.generationQueue.set(chunk.key, { cx, cz, distanceSq, requested: false });
        }
        if (chunk.meshDirty) this.workQueue.add(chunk.key);
      }
    }
  }

  /** Send queued chunks to idle workers, nearest first. */
  _dispatchGeneration() {
    if (this.generationQueue.size === 0) return;

    const liveWorkers = this.workers.filter((w) => !w.dead);
    this.stats.usingWorkers = liveWorkers.length > 0;
    const idle = liveWorkers.filter((w) => !w.busy);

    if (idle.length === 0) {
      // Without workers, generate at most one chunk per frame on the main
      // thread to keep the frame time bounded.
      if (liveWorkers.length === 0 && this.generationQueue.size > 0) {
        const next = this._takeNearestJob();
        if (next) {
          try {
            this._generateSync(next.cx, next.cz);
          } catch (err) {
            console.error('[ChunkManager] synchronous generation failed:', err);
            this._applyFallbackChunk(next.cx, next.cz);
          }
        }
      }
      return;
    }

    for (const entry of idle) {
      const job = this._takeNearestJob();
      if (!job) break;
      const jobId = ++this.jobIdCounter;
      entry.busy = true;
      entry.jobId = jobId;
      entry.cx = job.cx;
      entry.cz = job.cz;
      entry.startedAt = performance.now();
      this.inFlight.set(jobId, { workerEntry: entry, cx: job.cx, cz: job.cz });
      entry.worker.postMessage({ type: 'generate', jobId, cx: job.cx, cz: job.cz });
    }
  }

  /** Pop the closest queued generation job. */
  _takeNearestJob() {
    let bestKey = null;
    let best = null;
    for (const [key, job] of this.generationQueue) {
      if (job.requested) continue;
      if (!best || job.distanceSq < best.distanceSq) {
        best = job;
        bestKey = key;
      }
    }
    if (!best) return null;
    this.generationQueue.delete(bestKey);
    return best;
  }

  /** Recover from a worker that never answers (crashed tab, OOM, ...). */
  _checkWorkerTimeouts() {
    const now = performance.now();
    for (const entry of this.workers) {
      if (!entry.busy || entry.dead) continue;
      if (now - entry.startedAt < WORKER_JOB_TIMEOUT_MS) continue;
      console.warn(`[ChunkManager] worker timed out on chunk ${entry.cx},${entry.cz}; generating on main thread`);
      entry.busy = false;
      entry.dead = true;
      this.inFlight.delete(entry.jobId);
      try { entry.worker.terminate(); } catch { /* already gone */ }
      this._generateSync(entry.cx, entry.cz);
      this.stats.workers = this.workers.filter((w) => !w.dead).length;
      this.stats.usingWorkers = this.stats.workers > 0;
    }
  }

  /**
   * Light and mesh dirty chunks, nearest first, inside the frame budget.
   * @param {number} playerX @param {number} playerZ
   */
  /**
   * Rebuild the chunks touched by recent player edits, ahead of everything else.
   *
   * Pass 1 recomputes lighting only; pass 2 recomputes lighting again and then
   * rebuilds the meshes. Splitting it this way keeps each frame's cost small
   * while still producing exactly correct light across chunk borders.
   */
  _processPriority() {
    if (!this.lightBatch && this.priorityWork.size === 0) return;

    if (!this.lightBatch) {
      // Start a new batch from everything currently queued.
      const keys = [];
      for (const key of this.priorityWork) {
        const [cx, cz] = parseKeyTuple(key);
        const chunk = this.world.chunks.get(chunkKey(cx, cz));
        if (!chunk || !chunk.hasData) continue;
        if (!chunk.lightDirty && !chunk.meshDirty) continue;
        keys.push(key);
        // Hold these chunks out of the normal queue for the duration so they
        // are never meshed with half-updated light.
        this.workQueue.delete(key);
      }
      this.priorityWork.clear();
      if (keys.length === 0) return;
      this.lightBatch = { keys, set: new Set(keys), index: 0, phase: 1 };
    }

    const batch = this.lightBatch;
    let processed = 0;
    const started = performance.now();

    while (batch.index < batch.keys.length) {
      const key = batch.keys[batch.index++];
      const [cx, cz] = parseKeyTuple(key);
      const chunk = this.world.chunks.get(chunkKey(cx, cz));
      if (!chunk || !chunk.hasData) continue;

      if (batch.phase === 1) {
        // Pass 1: clear and re-seed. Deliberately no cross-border import yet,
        // so every chunk in the batch forgets the light that flowed out of the
        // edit before any chunk reads from a neighbour.
        this.lightEngine.seed(chunk);
        chunk.lightDirty = false;
      } else {
        // Pass 2: full recompute (import + flood) on now-clean neighbours,
        // then rebuild the mesh.
        this.lightEngine.compute(chunk, this.world);
        chunk.lightDirty = false;
        chunk.state = ChunkState.LIT;
        this.meshSink.upload(chunk.key, chunk.cx, chunk.cz, this.meshBuilder.build(chunk, this.world));
        chunk.meshDirty = false;
        chunk.state = ChunkState.READY;
        this.stats.meshed++;
        this.stats.uploaded++;
      }

      processed++;
      if (processed >= MAX_PRIORITY_CHUNKS_PER_FRAME) break;
      if (performance.now() - started > PRIORITY_BUDGET_MS) break;
    }

    if (batch.index >= batch.keys.length) {
      if (batch.phase === 1) {
        batch.phase = 2;
        batch.index = 0;
        // Force pass 2 to recompute light for every chunk in the batch.
        for (const key of batch.keys) {
          const [cx, cz] = parseKeyTuple(key);
          const chunk = this.world.chunks.get(chunkKey(cx, cz));
          if (chunk) chunk.lightDirty = true;
        }
      } else {
        this.lightBatch = null;
      }
    }
  }

  _processWorkQueue(playerX, playerZ) {
    this._processPriority();
    if (this.workQueue.size === 0) return;

    // Collect and sort the dirty chunks by distance so the world fills in from
    // the player outwards. Chunks the player just edited always come first.
    const candidates = [];
    for (const key of this.workQueue) {
      const [cx, cz] = parseKeyTuple(key);
      const chunk = this.world.chunks.get(chunkKey(cx, cz));
      if (!chunk || !chunk.hasData) {
        this.workQueue.delete(key);
        continue;
      }
      if (!chunk.lightDirty && !chunk.meshDirty) {
        this.workQueue.delete(key);
        continue;
      }
      // Chunks inside the active edit batch are handled by _processPriority.
      if (this.lightBatch && this.lightBatch.set.has(key)) continue;
      const dx = chunk.originX + CHUNK_SIZE * 0.5 - playerX;
      const dz = chunk.originZ + CHUNK_SIZE * 0.5 - playerZ;
      candidates.push({ key, chunk, set: this.workQueue, distanceSq: dx * dx + dz * dz });
    }
    candidates.sort((a, b) => a.distanceSq - b.distanceSq);

    const meshStart = performance.now();
    let uploads = 0;

    for (const item of candidates) {
      const chunk = item.chunk;

      // ---- Lighting -------------------------------------------------------
      if (chunk.lightDirty && chunk.state >= ChunkState.GENERATED) {
        const lightStart = performance.now();
        this.lightEngine.compute(chunk, this.world);
        this.stats.lastLightMs = performance.now() - lightStart;
        chunk.lightDirty = false;
        chunk.state = ChunkState.LIT;
        this.world.stats.lit++;
        // Neighbours may now be able to import light across the border, so
        // they get one re-import pass each. The `lightPropagated` latch makes
        // this happen at most once per (re)light cycle, which is what keeps the
        // queue draining instead of oscillating.
        if (!chunk.lightPropagated) {
          chunk.lightPropagated = true;
          this._markNeighboursDirty(chunk.cx, chunk.cz, true);
        }
      }

      // ---- Meshing --------------------------------------------------------
      if (chunk.meshDirty && chunk.state >= ChunkState.LIT) {
        if (uploads >= MAX_MESH_UPLOADS_PER_FRAME) break;
        // Stop before starting another build once the budget is spent. At least
        // one chunk is always built per frame, so streaming still makes
        // progress, but a frame can no longer run several builds back to back
        // and blow through its budget.
        if (uploads > 0 && performance.now() - meshStart > FRAME_BUDGET_MS) break;
        const buildStart = performance.now();
        const data = this.meshBuilder.build(chunk, this.world);
        this.stats.lastMeshMs = performance.now() - buildStart;
        this.meshSink.upload(chunk.key, chunk.cx, chunk.cz, data);
        chunk.mesh = data;
        chunk.meshDirty = false;
        chunk.state = ChunkState.READY;
        item.set.delete(item.key);
        uploads++;
        this.stats.meshed++;
        this.stats.uploaded++;
      } else if (!chunk.meshDirty && !chunk.lightDirty) {
        item.set.delete(item.key);
      }

      if (performance.now() - meshStart > FRAME_BUDGET_MS) break;
    }
  }

  /** Release chunks that have moved beyond the unload margin. */
  _unloadDistant(centreCx, centreCz) {
    const limit = this.renderDistance + UNLOAD_MARGIN;
    const limitSq = limit * limit;
    /** @type {string[]|null} */
    let toRemove = null;

    for (const chunk of this.world.chunks.values()) {
      const dx = chunk.cx - centreCx;
      const dz = chunk.cz - centreCz;
      if (dx * dx + dz * dz <= limitSq) continue;
      (toRemove || (toRemove = [])).push(chunk.key);
    }
    if (!toRemove) return;

    for (const key of toRemove) {
      const chunk = this.world.getChunk(...parseKeyTuple(key));
      if (!chunk) continue;
      this.meshSink.remove(key);
      this.workQueue.delete(key);
      this.priorityWork.delete(key);
      this.generationQueue.delete(key);
      // releaseChunk keeps the edit delta so returning to the area restores it.
      this.world.releaseChunk(chunk.cx, chunk.cz);
      this.stats.unloaded++;
    }
  }

  /**
   * Force every loaded chunk to be rebuilt (used after loading a save, so that
   * restored edits appear immediately).
   */
  invalidateAll() {
    for (const chunk of this.world.chunks.values()) {
      chunk.meshDirty = true;
      chunk.lightDirty = true;
      this.workQueue.add(chunk.key);
    }
    this.forceRescan = true;
  }

  /** Number of chunks still waiting to be generated. */
  get pendingChunks() {
    return this.generationQueue.size + this.inFlight.size;
  }

  /** True once the area immediately around the player is fully built. */
  isAreaReady(playerX, playerZ, radius = 2) {
    const cx = Math.floor(playerX / CHUNK_SIZE);
    const cz = Math.floor(playerZ / CHUNK_SIZE);
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const chunk = this.world.getChunk(cx + dx, cz + dz);
        if (!chunk || chunk.state < ChunkState.LIT) return false;
      }
    }
    return true;
  }

  /**
   * Change the render distance at runtime. Takes effect on the next rescan.
   * @param {number} chunks
   */
  setRenderDistance(chunks) {
    const clamped = Math.max(2, Math.min(16, Math.round(chunks)));
    if (clamped === this.renderDistance) return;
    this.renderDistance = clamped;
    this.forceRescan = true;
  }

  /** Stop the worker pool. */
  dispose() {
    for (const entry of this.workers) {
      try { entry.worker.terminate(); } catch { /* ignore */ }
    }
    this.workers.length = 0;
    this.inFlight.clear();
    this.generationQueue.clear();
    this.workQueue.clear();
    this.priorityWork.clear();
  }
}

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/**
 * World.chunks is keyed by a packed integer (see World.chunkKey) while the
 * renderer and save files use the readable "cx,cz" name. These queues store the
 * readable name because it is also the GPU mesh key, so this conversion happens
 * once per dirty chunk rather than per lookup.
 */

/** "cx,cz" -> [cx, cz]. */
function parseKeyTuple(name) {
  const comma = name.indexOf(',');
  return [Number(name.slice(0, comma)), Number(name.slice(comma + 1))];
}
