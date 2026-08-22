import type { EngineConfig, BacktestTrade, EquityPoint } from "./engine.js";
import type { BacktestStats } from "./stats.js";
import type { ScoreWeights } from "./scoring.js";
import type { TimeframeId } from "../exchange/bybit.js";
import type { SharedCandleBuffer } from "./candleBuffer.js";

// Message contract between workerPool.ts (main thread) and backtestWorker.ts (worker thread).
// Kept in its own module, imported by both sides, so the two never drift out of sync.

export interface FullBacktestResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  buyHoldCurve: EquityPoint[];
  stats: BacktestStats;
}

export interface StatsResult {
  stats: BacktestStats;
}

export interface ScoredResult {
  score: number;
  stats: BacktestStats;
}

interface BaseTask {
  taskId: number;
  /** Identifies which candle set `shared` holds — the worker caches its unpacked Candle[] by
   * this key so a candle set reused across many tasks (e.g. a search cell's IS candles) is only
   * unpacked once per worker, not once per task. */
  cellId: string;
  shared: SharedCandleBuffer;
  strategyId: string;
  params: Record<string, number>;
  engineConfig: EngineConfig;
  /** Needed by computeStats to annualize Sharpe/Sortino — every task kind computes stats now. */
  timeframe: TimeframeId;
}

export type TaskMessage =
  | (BaseTask & { kind: "full" })
  | (BaseTask & { kind: "stats" })
  | (BaseTask & { kind: "score"; weights: ScoreWeights });

export type ResultMessage =
  | ({ kind: "full"; taskId: number } & FullBacktestResult)
  | ({ kind: "stats"; taskId: number } & StatsResult)
  | ({ kind: "score"; taskId: number } & ScoredResult)
  | { kind: "error"; taskId: number; message: string };
