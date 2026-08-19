import { Worker } from "node:worker_threads";
import os from "node:os";
import path from "node:path";

import { packCandles } from "./candleBuffer.js";
import type { SharedCandleBuffer } from "./candleBuffer.js";
import type { Candle } from "./types.js";
import type { EngineConfig } from "./engine.js";
import type { ScoreWeights } from "./scoring.js";
import type { TimeframeId } from "../exchange/bybit.js";
import type { TaskMessage, ResultMessage, FullBacktestResult, StatsResult, ScoredResult } from "./workerProtocol.js";

/** Every ResultMessage variant except the error one — what a submitted task's promise actually resolves with. */
type SuccessResult = Exclude<ResultMessage, { kind: "error" }>;

interface PendingEntry {
  resolve: (msg: SuccessResult) => void;
  reject: (err: Error) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
  currentTaskId: number | null;
}

function resolveWorkerEntry(): { path: string; execArgv: string[] } {
  // __filename reflects this module's own real file extension in every environment this pool
  // runs under: tsc-compiled prod (dist/**/*.js), tsx dev (`tsx watch src/index.ts` runs .ts
  // directly), and Vitest (preserves real source paths). Point the worker at the same kind of
  // file so it loads the same way a compiled prod worker never needs tsx at all — tsx is a
  // devDependency only and won't be installed in a `--omit=dev` production install.
  if (__filename.endsWith(".ts")) {
    return { path: path.join(__dirname, "backtestWorker.ts"), execArgv: ["--require", "tsx/cjs"] };
  }
  return { path: path.join(__dirname, "backtestWorker.js"), execArgv: [] };
}

/**
 * Fixed-size worker_thread pool for running backtests off this process's single event loop —
 * the loop this process also uses for live trading (SignalProcessor polls every 500ms,
 * Reconciler ticks every 500ms-60s). Before this pool existed, `POST /api/backtest/run` and
 * `POST /api/backtest/optimize` ran every backtest synchronously inline, which could stall
 * webhook ingestion and reconciliation for as long as the sweep took, and risk a Railway
 * healthcheck-triggered restart mid-position.
 *
 * Meant to be created per operation (one /run request, one /optimize sweep, one Strategy Finder
 * run) and destroyed via `destroy()` when it completes — that keeps lifecycle simple (no
 * cross-request cache eviction needed) at the cost of re-paying worker startup per operation,
 * which is a few ms per worker and negligible next to the backtests themselves.
 *
 * Candle data is handed to workers via SharedArrayBuffer (candleBuffer.ts) so dispatching a task
 * never structurally clones the candle array; each worker reconstructs and caches its own
 * Candle[] view per distinct candle array the first time it sees it (see workerProtocol.ts's
 * cellId and backtestWorker.ts's candleCache).
 */
export class BacktestWorkerPool {
  private workers: PoolWorker[] = [];
  private queue: { message: TaskMessage; entry: PendingEntry }[] = [];
  private pending = new Map<number, PendingEntry>();
  private bufferCache = new WeakMap<readonly Candle[], { cellId: string; shared: SharedCandleBuffer }>();
  private nextTaskId = 1;
  private nextCellId = 1;
  private closed = false;

  constructor(size: number = Math.max(1, os.availableParallelism() - 1)) {
    for (let i = 0; i < size; i++) this.workers.push(this.spawn());
  }

  private spawn(): PoolWorker {
    const { path: entryPath, execArgv } = resolveWorkerEntry();
    const worker = new Worker(entryPath, { execArgv });
    const poolWorker: PoolWorker = { worker, busy: false, currentTaskId: null };
    worker.on("message", (msg: ResultMessage) => this.onMessage(poolWorker, msg));
    worker.on("error", (err: Error) => this.onWorkerError(poolWorker, err));
    // Deliberately NOT unref()'d: an unref'd worker lets the process exit while a task is still
    // in flight (no error, no output — the response just never arrives), since a pending Promise
    // alone isn't a ref'd handle. Every real call site here awaits destroy() in a finally block
    // (backtestRoutes.ts's withPool, optimizationRunner.ts's runAutoOptimization), so a forgotten
    // destroy() should surface as a visibly hung process, not a silently dropped result.
    return poolWorker;
  }

  private onMessage(poolWorker: PoolWorker, msg: ResultMessage): void {
    const entry = this.pending.get(msg.taskId);
    this.pending.delete(msg.taskId);
    poolWorker.busy = false;
    poolWorker.currentTaskId = null;
    if (entry) {
      if (msg.kind === "error") entry.reject(new Error(msg.message));
      else entry.resolve(msg);
    }
    this.drain();
  }

  private onWorkerError(poolWorker: PoolWorker, err: Error): void {
    // The worker process itself crashed (not a caught error inside backtestWorker.ts, which
    // reports {kind:"error"} over postMessage instead) — fail whatever task it was running and
    // replace the worker so pool capacity doesn't silently shrink for the rest of this operation.
    if (poolWorker.currentTaskId != null) {
      const entry = this.pending.get(poolWorker.currentTaskId);
      this.pending.delete(poolWorker.currentTaskId);
      entry?.reject(err);
    }
    const idx = this.workers.indexOf(poolWorker);
    if (idx !== -1 && !this.closed) {
      void poolWorker.worker.terminate().catch(() => {
        /* already gone */
      });
      this.workers[idx] = this.spawn();
    }
    this.drain();
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const idle = this.workers.find((w) => !w.busy);
      if (!idle) return;
      const { message, entry } = this.queue.shift()!;
      idle.busy = true;
      idle.currentTaskId = message.taskId;
      this.pending.set(message.taskId, entry);
      idle.worker.postMessage(message);
    }
  }

  private getShared(candles: readonly Candle[]): { cellId: string; shared: SharedCandleBuffer } {
    let entry = this.bufferCache.get(candles);
    if (!entry) {
      entry = { cellId: `c${this.nextCellId++}`, shared: packCandles(candles) };
      this.bufferCache.set(candles, entry);
    }
    return entry;
  }

  private submit(candles: readonly Candle[], build: (taskId: number, cellId: string, shared: SharedCandleBuffer) => TaskMessage): Promise<SuccessResult> {
    if (this.closed) return Promise.reject(new Error("Worker pool is closed"));
    const { cellId, shared } = this.getShared(candles);
    const taskId = this.nextTaskId++;
    const message = build(taskId, cellId, shared);
    return new Promise((resolve, reject) => {
      this.queue.push({ message, entry: { resolve, reject } });
      this.drain();
    });
  }

  /** Full result (trades + curves + stats) — for a single interactive /run request. */
  async runFull(candles: readonly Candle[], strategyId: string, params: Record<string, number>, engineConfig: EngineConfig): Promise<FullBacktestResult> {
    const msg = await this.submit(candles, (taskId, cellId, shared) => ({ kind: "full", taskId, cellId, shared, strategyId, params, engineConfig }));
    if (msg.kind !== "full") throw new Error(`Unexpected worker result kind: ${msg.kind}`);
    return msg;
  }

  /** Stats only, no curves — for the manual param sweep (/optimize), which only ranks by stats. */
  async runStats(candles: readonly Candle[], strategyId: string, params: Record<string, number>, engineConfig: EngineConfig): Promise<StatsResult> {
    const msg = await this.submit(candles, (taskId, cellId, shared) => ({ kind: "stats", taskId, cellId, shared, strategyId, params, engineConfig }));
    if (msg.kind !== "stats") throw new Error(`Unexpected worker result kind: ${msg.kind}`);
    return msg;
  }

  /** Stats + composite score, no curves — for Strategy Finder's coarse/refine/validate passes. */
  async runScored(
    candles: readonly Candle[],
    strategyId: string,
    params: Record<string, number>,
    engineConfig: EngineConfig,
    timeframe: TimeframeId,
    weights: ScoreWeights,
  ): Promise<ScoredResult> {
    const msg = await this.submit(candles, (taskId, cellId, shared) => ({
      kind: "score",
      taskId,
      cellId,
      shared,
      strategyId,
      params,
      engineConfig,
      timeframe,
      weights,
    }));
    if (msg.kind !== "score") throw new Error(`Unexpected worker result kind: ${msg.kind}`);
    return msg;
  }

  /** Terminates every worker. Any tasks still queued or in flight reject. */
  async destroy(): Promise<void> {
    this.closed = true;
    const err = new Error("Worker pool destroyed");
    for (const { entry } of this.queue) entry.reject(err);
    this.queue = [];
    for (const [, entry] of this.pending) entry.reject(err);
    this.pending.clear();
    await Promise.all(this.workers.map((w) => w.worker.terminate()));
  }
}
