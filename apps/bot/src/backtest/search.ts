import { runOneBacktest } from "./optimizer.js";
import { scoreResult, DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from "./scoring.js";
import type { EngineConfig } from "./engine.js";
import type { StrategyDefinition, StrategyParamDef } from "./strategies/types.js";
import type { Candle } from "./types.js";
import type { BacktestStats } from "./stats.js";
import type { TimeframeId } from "../exchange/bybit.js";
import type { BacktestWorkerPool } from "./workerPool.js";

function roundTo(value: number, precision = 8): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

export interface GridBudget {
  /** Hard cap on how many param combinations the coarse grid can produce for one strategy. */
  maxCombosPerCell: number;
  /** How many candidate values to sample across a numeric param's [min, max] range. */
  maxValuesPerParam: number;
}

export const DEFAULT_COARSE_BUDGET: GridBudget = { maxCombosPerCell: 200, maxValuesPerParam: 5 };

export interface RefineOptions {
  /** Refine window = ± (originalStep * window) around a coarse winner's value. */
  window: number;
  valuesPerParam: number;
  /** Hard cap on how many combos one coarse winner's refine neighborhood can produce. */
  maxCombosPerNeighborhood: number;
}

export const DEFAULT_REFINE_OPTIONS: RefineOptions = { window: 3, valuesPerParam: 5, maxCombosPerNeighborhood: 200 };

function isEnumParam(p: StrategyParamDef): boolean {
  return p.options != null;
}

function isVisible(p: StrategyParamDef, combo: Record<string, number>): boolean {
  return !p.showIf || combo[p.showIf.param] === p.showIf.equals;
}

/** Coarse candidate values for one param — every discrete index for an enum, an evenly-spaced sample for a numeric range. */
function coarseValuesFor(p: StrategyParamDef, maxValues: number): number[] {
  if (isEnumParam(p)) {
    const values: number[] = [];
    const step = Math.max(p.step, 1);
    for (let v = p.min; v <= p.max; v += step) values.push(roundTo(v));
    return values;
  }
  const span = p.max - p.min;
  if (span <= 0 || p.step <= 0) return [p.default];

  const count = Math.max(2, Math.min(maxValues, Math.floor(span / p.step) + 1));
  const rawStep = span / (count - 1);
  const stepMultiple = Math.max(p.step, Math.round(rawStep / p.step) * p.step);

  const values: number[] = [];
  for (let v = p.min; v < p.max - 1e-9; v += stepMultiple) values.push(roundTo(v));
  values.push(roundTo(p.max));
  return [...new Set(values)];
}

/**
 * Builds a bounded coarse grid over a strategy's full param schema — brute-forcing every
 * combination is infeasible (a strategy like bbMeanReversion has enough numeric params at
 * fine steps to produce billions of combos). Enum params (`options`) are expanded across
 * their few discrete indices (structural choices, e.g. TP/SL mode); a param gated by
 * `showIf` only varies in branches where its gate holds, and stays at its default
 * everywhere else — this avoids wasting budget tuning a param the strategy isn't even using
 * in that branch. Truncation (once the mid-build size exceeds the cap) is deterministic —
 * same strategy + budget always yields the same grid — not random sampling.
 */
export function buildCoarseGrid(strategy: StrategyDefinition, budget: GridBudget = DEFAULT_COARSE_BUDGET): Record<string, number>[] {
  const defaults = Object.fromEntries(strategy.params.map((p) => [p.name, p.default]));

  let combos: Record<string, number>[] = [{ ...defaults }];
  for (const p of strategy.params) {
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      if (!isVisible(p, combo)) {
        next.push(combo); // hidden in this branch — leave at default, don't multiply
        continue;
      }
      for (const v of coarseValuesFor(p, budget.maxValuesPerParam)) next.push({ ...combo, [p.name]: v });
    }
    // Cap after every param so the intermediate size never runs away before the final slice.
    combos = next.length > budget.maxCombosPerCell ? next.slice(0, budget.maxCombosPerCell) : next;
  }

  return combos.slice(0, budget.maxCombosPerCell);
}

/** Evenly-spaced sample within a windowed [min, max] sub-range, honoring the param's own step so values stay clean. */
function refineValuesFor(min: number, max: number, count: number, paramStep: number): number[] {
  if (max <= min) return [roundTo(min)];
  const step = Math.max(paramStep, (max - min) / (Math.max(2, count) - 1));
  const values: number[] = [];
  for (let v = min; v < max - 1e-9; v += step) values.push(roundTo(v));
  values.push(roundTo(max));
  return [...new Set(values)];
}

/**
 * Builds a finer grid around one coarse winner, refining only the numeric params currently
 * visible in that combo. Uses the same incremental per-param capping as buildCoarseGrid
 * (not a one-shot Cartesian product) — a strategy can have several numeric params
 * simultaneously visible (e.g. RSI confirm + ATR TP/SL both "on" at once), and an uncapped
 * product there blows up combinatorially (5 values^7 params ≈ 78,000, times every coarse
 * winner being refined) even though each individual param only samples a few points.
 */
function refineAround(strategy: StrategyDefinition, base: Record<string, number>, opts: RefineOptions): Record<string, number>[] {
  const numericParams = strategy.params.filter((p) => !isEnumParam(p) && isVisible(p, base));

  let combos: Record<string, number>[] = [{ ...base }];
  for (const p of numericParams) {
    const value = base[p.name] ?? p.default;
    const span = p.step * opts.window;
    const min = Math.max(p.min, value - span);
    const max = Math.min(p.max, value + span);
    const values = refineValuesFor(min, max, opts.valuesPerParam, p.step);

    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const v of values) next.push({ ...combo, [p.name]: v });
    }
    combos = next.length > opts.maxCombosPerNeighborhood ? next.slice(0, opts.maxCombosPerNeighborhood) : next;
  }

  return combos;
}

export interface SearchOptions {
  /** Fraction of candles (taken from the end) held out as out-of-sample validation data. */
  oosFraction: number;
  coarseBudget: GridBudget;
  refineOptions: RefineOptions;
  /** How many top coarse-scoring configs to build refine neighborhoods around. */
  topKToRefine: number;
  /** How many final (IS-refined) configs to validate on OOS and return. */
  keepTop: number;
  minTrades: number;
  scoreWeights: ScoreWeights;
  /** Yield to the event loop (setImmediate) every N backtests — keeps the live trading loop ticking. */
  yieldEvery: number;
  /** Fired once per backtest run — keep cheap (counter increments only), no I/O. */
  onBacktest?: () => void;
  /** Checked between backtests; returning true aborts the cell via CancelledError. */
  isCancelled?: () => boolean;
  /**
   * When supplied, every backtest in this cell runs on the worker-thread pool instead of
   * in-process — the pool is what actually keeps the live trading loop (SignalProcessor,
   * Reconciler) responsive during a search. Requires `strategy` to be resolvable by
   * `getStrategy(strategy.id)` in strategies/index.ts, since a worker thread can only look
   * strategies up by id, not receive an arbitrary closure — so leave this unset for ad-hoc
   * StrategyDefinition objects (e.g. in tests), which fall back to the in-process sequential
   * path below.
   */
  pool?: BacktestWorkerPool;
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  oosFraction: 0.3,
  coarseBudget: DEFAULT_COARSE_BUDGET,
  refineOptions: DEFAULT_REFINE_OPTIONS,
  topKToRefine: 5,
  keepTop: 5,
  minTrades: 10,
  scoreWeights: DEFAULT_SCORE_WEIGHTS,
  yieldEvery: 25,
};

export class CancelledError extends Error {}

export interface SearchResult {
  params: Record<string, number>;
  isStats: BacktestStats;
  oosStats: BacktestStats;
  isScore: number;
  oosScore: number;
  /** True when the OOS score collapses relative to IS — the config likely won't transfer to live trading. */
  overfitFlag: boolean;
}

async function evaluate(
  strategy: StrategyDefinition,
  candles: readonly Candle[],
  params: Record<string, number>,
  engineConfig: EngineConfig,
  timeframe: TimeframeId,
  weights: ScoreWeights,
  opts: SearchOptions,
): Promise<{ params: Record<string, number>; score: number; result: ReturnType<typeof runOneBacktest> }> {
  const result = runOneBacktest(strategy, candles, params, engineConfig, timeframe);
  const score = scoreResult(result, timeframe, weights);

  opts.onBacktest?.();
  if (opts.isCancelled?.()) throw new CancelledError("Search cancelled");

  return { params, score, result };
}

/**
 * Evaluates a batch of param combos against one candle set. Routes through `opts.pool` when
 * present (dispatched concurrently across the worker pool — see SearchOptions.pool), otherwise
 * falls back to the original in-process sequential loop with cooperative `setImmediate`
 * yielding. Both paths call `onBacktest` once per completed backtest and honor `isCancelled`
 * by throwing CancelledError, matching `evaluate`'s existing per-item contract.
 */
async function evaluateBatch(
  strategy: StrategyDefinition,
  candles: readonly Candle[],
  paramsList: Record<string, number>[],
  engineConfig: EngineConfig,
  timeframe: TimeframeId,
  weights: ScoreWeights,
  opts: SearchOptions,
  maybeYield: () => Promise<void>,
): Promise<{ params: Record<string, number>; score: number; stats: BacktestStats }[]> {
  if (opts.pool) {
    const pool = opts.pool;
    const scored = await Promise.all(
      paramsList.map(async (params) => {
        const { score, stats } = await pool.runScored(candles, strategy.id, params, engineConfig, timeframe, weights);
        opts.onBacktest?.();
        return { params, score, stats };
      }),
    );
    if (opts.isCancelled?.()) throw new CancelledError("Search cancelled");
    return scored;
  }

  const scored: { params: Record<string, number>; score: number; stats: BacktestStats }[] = [];
  for (const params of paramsList) {
    const { score, result } = await evaluate(strategy, candles, params, engineConfig, timeframe, weights, opts);
    scored.push({ params, score, stats: result.stats });
    await maybeYield();
  }
  return scored;
}

/**
 * Fingerprint of a backtest's actual outcome (not its params) — a strategy's signals only
 * change at the candle where an indicator threshold is actually crossed, so on a finite
 * candle set, many nearby param values (especially within one refine neighborhood) produce
 * byte-identical trades. Deduping by exact param equality alone lets several of those
 * "twins" all survive into the finalist list, wasting slots that could've gone to a
 * genuinely different config. Dedupe on the outcome itself instead.
 */
function outcomeKey(stats: BacktestStats): string {
  return [stats.totalPnlPct, stats.totalTrades, stats.winRatePct, stats.maxDrawdownPct, stats.profitFactor].join("|");
}

/**
 * Coarse-grid search over one (strategy, symbol, timeframe) cell, refined around the best
 * regions, then validated on out-of-sample data the search never saw. Ranking by in-sample
 * score alone reliably surfaces curve-fit configs — the OOS pass + `overfitFlag` is what
 * makes a result defensible enough to trade. Operates on already-fetched candles; the caller
 * (optimizationRunner.ts) owns candle fetching and DB/progress persistence.
 */
export async function searchCell(
  strategy: StrategyDefinition,
  candles: readonly Candle[],
  timeframe: TimeframeId,
  engineConfig: EngineConfig,
  opts: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): Promise<SearchResult[]> {
  const splitIdx = Math.floor(candles.length * (1 - opts.oosFraction));
  const isCandles = candles.slice(0, splitIdx);
  const oosCandles = candles.slice(splitIdx);
  if (isCandles.length === 0 || oosCandles.length === 0) return [];

  let evaluatedSinceYield = 0;
  async function maybeYield() {
    evaluatedSinceYield++;
    if (evaluatedSinceYield >= opts.yieldEvery) {
      evaluatedSinceYield = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // ── Coarse pass over in-sample data ────────────────────────────────────────
  const coarseCombos = buildCoarseGrid(strategy, opts.coarseBudget);
  const coarseScored = await evaluateBatch(strategy, isCandles, coarseCombos, engineConfig, timeframe, opts.scoreWeights, opts, maybeYield);
  coarseScored.sort((a, b) => b.score - a.score);

  // ── Refine pass: zoom in around the best coarse regions ────────────────────
  const topCoarse = coarseScored.filter((c) => c.score > 0).slice(0, opts.topKToRefine);
  const seen = new Set(coarseScored.map((c) => JSON.stringify(c.params)));
  const refineCombos: Record<string, number>[] = [];
  for (const c of topCoarse) {
    for (const params of refineAround(strategy, c.params, opts.refineOptions)) {
      const key = JSON.stringify(params);
      if (seen.has(key)) continue;
      seen.add(key);
      refineCombos.push(params);
    }
  }

  const refinedScored = await evaluateBatch(strategy, isCandles, refineCombos, engineConfig, timeframe, opts.scoreWeights, opts, maybeYield);

  // ── Pick finalists (coarse + refined, best score per distinct outcome) ─────
  // Deduping by outcome rather than by literal param equality is what actually stops
  // twin/near-twin configs from crowding out genuinely different ones — see outcomeKey.
  const bestByOutcome = new Map<string, { params: Record<string, number>; score: number }>();
  for (const c of [...coarseScored, ...refinedScored]) {
    if (c.score <= 0) continue;
    const key = outcomeKey(c.stats);
    const existing = bestByOutcome.get(key);
    if (!existing || c.score > existing.score) bestByOutcome.set(key, { params: c.params, score: c.score });
  }
  const finalists = [...bestByOutcome.values()].sort((a, b) => b.score - a.score).slice(0, opts.keepTop);

  // ── Validate finalists on out-of-sample data ────────────────────────────────
  const finalistParams = finalists.map((f) => f.params);
  const [isResults, oosResults] = await Promise.all([
    evaluateBatch(strategy, isCandles, finalistParams, engineConfig, timeframe, opts.scoreWeights, opts, maybeYield),
    evaluateBatch(strategy, oosCandles, finalistParams, engineConfig, timeframe, opts.scoreWeights, opts, maybeYield),
  ]);

  const results: SearchResult[] = finalists.map((f, i) => {
    const is = isResults[i]!;
    const oos = oosResults[i]!;
    const overfitFlag = is.score > 0 && (oos.score <= 0 || oos.score < is.score * 0.3);
    return {
      params: f.params,
      isStats: is.stats,
      oosStats: oos.stats,
      isScore: is.score,
      oosScore: oos.score,
      overfitFlag,
    };
  });

  results.sort((a, b) => b.oosScore - a.oosScore);
  return results;
}
