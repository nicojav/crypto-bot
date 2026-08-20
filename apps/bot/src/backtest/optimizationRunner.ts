import type { PrismaClient } from "../generated/prisma/client.js";
import type { TimeframeId } from "../exchange/bybit.js";
import type { EngineConfig } from "./engine.js";
import type { CandleSource } from "./candleStore.js";
import { ensureCandles } from "./candleStore.js";
import type { FundingSource } from "./fundingStore.js";
import { ensureFundingRates } from "./fundingStore.js";
import { getStrategy, listStrategies } from "./strategies/index.js";
import { searchCell, CancelledError, DEFAULT_COARSE_BUDGET, DEFAULT_REFINE_OPTIONS, type SearchResult, type SearchOptions } from "./search.js";
import { BacktestWorkerPool } from "./workerPool.js";
import type { ScoreWeights } from "./scoring.js";

// Minimal interface — BybitClient satisfies this structurally (mirrors CandleSource in candleStore.ts).
export interface InstrumentSource {
  getInstrumentInfo(symbol: string): Promise<{ lotSize: number; tickSize: number }>;
}

export interface AutoOptimizeConfig {
  symbols: string[];
  timeframes: TimeframeId[];
  strategyIds: string[];
  from: string;
  to: string;
  validateFraction: number;
  holdoutFraction: number;
  minTrades: number;
  scoreWeights: ScoreWeights;
  engine: Omit<EngineConfig, "lotSize" | "tickSize">;
}

export interface CellResult extends SearchResult {
  strategyId: string;
  symbol: string;
  timeframe: TimeframeId;
}

/** Bounded so a full-matrix run (many symbols × timeframes × strategies) doesn't grow the stored JSON unboundedly. */
const MAX_STORED_RESULTS = 50;

// Module-level single-job lock — this process also runs live trading (SignalProcessor,
// Reconciler ticking every 500ms-60s), so at most one optimization sweep may run at a time
// to bound CPU contention. searchCell's cooperative yielding (setImmediate every N
// backtests) keeps the event loop responsive for the trading loop during a run.
let activeRunId: number | null = null;
const cancelledRunIds = new Set<number>();

export function isOptimizationRunning(): boolean {
  return activeRunId !== null;
}

export function getActiveRunId(): number | null {
  return activeRunId;
}

/**
 * Marks any run still `status: "running"` in the DB as interrupted. Meant to be called once
 * at process startup: if the previous process died (crash, deploy, `tsx watch` restart on a
 * file save) while a run was mid-flight, that row is permanently orphaned — the in-memory
 * `activeRunId` lock lives only in the process that died, so nothing in a fresh process ever
 * marks it done, and it would otherwise show "running" forever with no way to cancel it
 * (`cancelRun` can only act on runs the *current* process is actually executing). Returns the
 * number of rows healed, for a one-line startup log.
 */
export async function healOrphanedRuns(db: PrismaClient): Promise<number> {
  const result = await db.optimizationRun.updateMany({
    where: { status: "running" },
    data: { status: "error", error: "Interrupted by a server restart before the run could finish" },
  });
  return result.count;
}

/** Requests cancellation of the given run — a no-op (returns false) if it's not the active run. */
export function cancelRun(runId: number): boolean {
  if (activeRunId !== runId) return false;
  cancelledRunIds.add(runId);
  return true;
}

/**
 * Runs a full strategy × symbol × timeframe search matrix as a detached background job,
 * persisting progress and a bounded top-N ranked result set to the OptimizationRun row as
 * it goes (so the dashboard's Strategy Finder panel can poll `GET /optimize/auto/:runId`
 * mid-run). Owns the row's full lifecycle: caller creates the row with status "running"
 * and passes its id; this function transitions it to "done" | "error" | "cancelled".
 *
 * Rejects immediately (before any candle fetch or backtest work) if another run is already
 * active — callers should check `isOptimizationRunning()` before creating the row, but this
 * is the authoritative guard, since the lock is set synchronously at the top of this function.
 */
export async function runAutoOptimization(
  db: PrismaClient,
  bybit: CandleSource & InstrumentSource & FundingSource,
  runId: number,
  config: AutoOptimizeConfig,
): Promise<void> {
  if (activeRunId !== null) {
    throw new Error(`Optimization run ${activeRunId} is already active`);
  }
  activeRunId = runId;

  const isCancelled = () => cancelledRunIds.has(runId);

  // One pool for the whole run (all cells) — spawning worker threads per cell would repay their
  // startup cost dozens of times over on a multi-cell matrix for no benefit. This is what keeps
  // the live trading loop (SignalProcessor/Reconciler, ticking every 500ms-60s in this same
  // process) responsive during a run: every backtest actually executes off this event loop.
  const pool = new BacktestWorkerPool();

  try {
    const strategyIds = config.strategyIds.length > 0 ? config.strategyIds : listStrategies().map((s) => s.id);
    const fromMs = Date.parse(config.from);
    const toMs = Date.parse(config.to);

    const cells = strategyIds.flatMap((strategyId) =>
      config.symbols.flatMap((symbol) => config.timeframes.map((timeframe) => ({ strategyId, symbol: symbol.toUpperCase(), timeframe }))),
    );

    let cellsDone = 0;
    let backtestsRun = 0;
    let allResults: CellResult[] = [];

    await db.optimizationRun.update({ where: { id: runId }, data: { status: "running", cellsTotal: cells.length } });

    for (const cell of cells) {
      if (isCancelled()) throw new CancelledError("Run cancelled");

      const strategy = getStrategy(cell.strategyId);
      if (!strategy) { cellsDone++; continue; }

      // ensureCandles/ensureFundingRates are I/O-bound (network) only on the first request for a
      // given symbol+timeframe (or symbol, for funding) window — subsequent cells sharing that
      // window read straight from the SQLite cache.
      const [candles, fundingRates] = await Promise.all([
        ensureCandles(db, bybit, cell.symbol, cell.timeframe, fromMs, toMs),
        ensureFundingRates(db, bybit, cell.symbol, fromMs, toMs),
      ]);
      if (candles.length === 0) { cellsDone++; continue; }

      const instrument = await bybit.getInstrumentInfo(cell.symbol);
      const engineConfig: EngineConfig = { ...config.engine, lotSize: instrument.lotSize, tickSize: instrument.tickSize, fundingRates };

      const searchOpts: SearchOptions = {
        validateFraction: config.validateFraction,
        holdoutFraction: config.holdoutFraction,
        coarseBudget: DEFAULT_COARSE_BUDGET,
        refineOptions: DEFAULT_REFINE_OPTIONS,
        topKToRefine: 5,
        shortlistSize: 20,
        keepTop: 5,
        // config.minTrades is the one knob callers set; scoreResult only ever reads
        // scoreWeights.minTrades, so it's folded in here rather than passed alongside it —
        // previously both existed independently and only the scoreWeights one actually did
        // anything, so a caller setting just config.minTrades had it silently ignored.
        scoreWeights: { ...config.scoreWeights, minTrades: config.minTrades },
        yieldEvery: 25,
        onBacktest: () => { backtestsRun++; },
        isCancelled,
        pool,
      };

      const cellResults = await searchCell(strategy, candles, cell.timeframe, engineConfig, searchOpts);
      allResults.push(...cellResults.map((r) => ({ ...r, strategyId: cell.strategyId, symbol: cell.symbol, timeframe: cell.timeframe })));
      // Ranking the cross-cell top-N by validateScore (not holdoutScore) keeps holdout free of
      // selection pressure globally too — the same reasoning as searchCell's own final sort.
      allResults.sort((a, b) => b.validateScore - a.validateScore);
      allResults = allResults.slice(0, MAX_STORED_RESULTS);

      cellsDone++;
      await db.optimizationRun.update({
        where: { id: runId },
        data: { cellsDone, backtestsRun, resultsJson: JSON.stringify(allResults) },
      });
    }

    await db.optimizationRun.update({
      where: { id: runId },
      data: { status: "done", cellsDone, backtestsRun, resultsJson: JSON.stringify(allResults) },
    });
  } catch (err) {
    const cancelled = err instanceof CancelledError;
    await db.optimizationRun.update({
      where: { id: runId },
      data: { status: cancelled ? "cancelled" : "error", error: cancelled ? null : (err instanceof Error ? err.message : String(err)) },
    });
    if (!cancelled) throw err;
  } finally {
    activeRunId = null;
    cancelledRunIds.delete(runId);
    await pool.destroy();
  }
}
