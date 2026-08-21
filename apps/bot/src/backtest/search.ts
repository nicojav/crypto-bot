import { runOneBacktest } from "./optimizer.js";
import { scoreResult, DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from "./scoring.js";
import { mulberry32, hashSeed, latinHypercube } from "./sampling.js";
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

/**
 * `scoreWeights.minTrades` is meant to express "how many trades before a score is stable
 * enough to trust" — but train, validate, holdout, and (per-fold) walk-forward windows are
 * very different sizes (train is ~70% of the data by default, holdout and validate ~15% each,
 * and one walk-forward fold is a further slice of validate). Applying the same absolute
 * threshold to all of them implicitly demands proportionally higher trade *frequency* out of
 * the smaller windows just to clear the same bar — in practice this meant holdout (and every
 * walk-forward fold) almost always failed it and scored a flat 0 regardless of actual
 * performance, making the reported holdout/fit numbers meaningless rather than conservative.
 * Scale the threshold down by how much smaller this window is than train's. */
function scaledMinTrades(baseMinTrades: number, windowFraction: number, trainFraction: number): number {
  if (trainFraction <= 0) return baseMinTrades;
  return Math.max(1, Math.round(baseMinTrades * (windowFraction / trainFraction)));
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

export interface WalkForwardOptions {
  /** Number of sequential, non-overlapping folds to split the validate window into. Each
   * shortlisted config is scored against every fold independently, and the *mean* fold score —
   * not one blended score over the whole validate period — becomes what selection ranks on. A
   * config that only works in one regime within the validate window (e.g. the first half trends,
   * the second chops) can no longer hide behind a good combined average; it has to hold up
   * across folds individually. Opt-in because it costs `shortlistSize * folds` extra backtests
   * on top of the normal validate pass — the worker pool (see workerPool.ts) is what makes that
   * affordable during a live search. */
  folds: number;
}

function isEnumParam(p: StrategyParamDef): boolean {
  return p.options != null;
}

function isVisible(p: StrategyParamDef, combo: Record<string, number>): boolean {
  return !p.showIf || combo[p.showIf.param] === p.showIf.equals;
}

/** Maps an LHS [0,1) sample to a value within [min, max], snapped to the param's own step grid
 * (aligned to the param's own min, not the window's min, so refined values still look "clean"
 * relative to the param's natural step, e.g. 12/14/16 rather than 11.3/13.3/15.3). */
function sampleParamValue(u: number, min: number, max: number, param: StrategyParamDef): number {
  if (max <= min) return roundTo(min);
  const raw = min + u * (max - min);
  const step = Math.max(param.step, 1e-9);
  const snapped = param.min + Math.round((raw - param.min) / step) * step;
  return roundTo(Math.min(max, Math.max(min, snapped)));
}

/** Cartesian product of every enum param's discrete option indices, each entry a "branch" of
 * the param space that showIf-gated numeric params get evaluated against. Small by
 * construction — the strategies here have at most a couple of 2-3-option enum params — so this
 * never needs its own budget cap. */
function enumBranches(strategy: StrategyDefinition): Record<string, number>[] {
  const defaults = Object.fromEntries(strategy.params.map((p) => [p.name, p.default]));
  let branches: Record<string, number>[] = [{ ...defaults }];
  for (const p of strategy.params) {
    if (!isEnumParam(p)) continue;
    const step = Math.max(p.step, 1);
    const values: number[] = [];
    for (let v = p.min; v <= p.max; v += step) values.push(roundTo(v));
    const next: Record<string, number>[] = [];
    for (const b of branches) for (const v of values) next.push({ ...b, [p.name]: v });
    branches = next;
  }
  return branches;
}

/**
 * Builds a bounded coarse grid over a strategy's full param schema — brute-forcing every
 * combination is infeasible (a strategy like bbMeanReversion has enough numeric params at
 * fine steps to produce billions of combos). Enum params (`options`) are fully expanded across
 * their few discrete indices (structural choices, e.g. TP/SL mode) into "branches"; within each
 * branch, the numeric params currently visible under that branch's showIf gates are sampled
 * *jointly* via Latin Hypercube sampling (see sampling.ts) rather than each param being sampled
 * independently and the results Cartesian-expanded then truncated to the budget. That older
 * approach kept whichever combinations happened to come first in iteration order once the cap
 * was hit mid-expansion — which systematically favored low values of later-processed params and
 * left whole regions of the space completely unvisited, an artifact of `strategy.params`'
 * declaration order rather than anything about the strategy itself. LHS has no such bias: the
 * budget directly is the sample count, spread evenly across the joint space.
 *
 * Deterministic — same strategy + budget always yields the same grid (seeded from the
 * strategy's own id), not truly random.
 */
export function buildCoarseGrid(strategy: StrategyDefinition, budget: GridBudget = DEFAULT_COARSE_BUDGET): Record<string, number>[] {
  const branches = enumBranches(strategy);
  const rng = mulberry32(hashSeed(strategy.id));

  const combos: Record<string, number>[] = [];
  for (const branch of branches) {
    const numericParams = strategy.params.filter((p) => !isEnumParam(p) && isVisible(p, branch));
    if (numericParams.length === 0) {
      combos.push({ ...branch });
      continue;
    }
    const budgetShare = Math.floor(budget.maxCombosPerCell / branches.length);
    const resolutionCap = budget.maxValuesPerParam * numericParams.length;
    const count = Math.max(1, Math.min(budgetShare, resolutionCap));

    const points = latinHypercube(count, numericParams.length, rng);
    for (const point of points) {
      const combo = { ...branch };
      numericParams.forEach((p, i) => {
        combo[p.name] = sampleParamValue(point[i]!, p.min, p.max, p);
      });
      combos.push(combo);
    }
  }

  return combos.slice(0, budget.maxCombosPerCell);
}

/**
 * Builds a finer LHS sample around one coarse winner, over only the numeric params currently
 * visible in that combo, within a ± (step × window) neighborhood of each. Same joint-sampling
 * rationale as buildCoarseGrid — a strategy can have several numeric params simultaneously
 * visible (e.g. RSI confirm + ATR TP/SL both "on" at once), and independently sampling each
 * then Cartesian-expanding blows up combinatorially (5 values^7 params ≈ 78,000 per coarse
 * winner) even though each individual param only samples a few points.
 */
function refineAround(strategy: StrategyDefinition, base: Record<string, number>, opts: RefineOptions, rng: () => number): Record<string, number>[] {
  const numericParams = strategy.params.filter((p) => !isEnumParam(p) && isVisible(p, base));
  if (numericParams.length === 0) return [{ ...base }];

  const ranges = numericParams.map((p) => {
    const value = base[p.name] ?? p.default;
    const span = p.step * opts.window;
    return { min: Math.max(p.min, value - span), max: Math.min(p.max, value + span) };
  });

  const count = Math.max(1, Math.min(opts.maxCombosPerNeighborhood, opts.valuesPerParam * numericParams.length));
  const points = latinHypercube(count, numericParams.length, rng);
  return points.map((point) => {
    const combo = { ...base };
    numericParams.forEach((p, i) => {
      const { min, max } = ranges[i]!;
      combo[p.name] = sampleParamValue(point[i]!, min, max, p);
    });
    return combo;
  });
}

export interface SearchOptions {
  /** Fraction of candles (taken from the end, after the validate slice) held out as the holdout
   * set — evaluated only for the finalists ultimately chosen, and never used to rank or select
   * anything. This is the only genuinely out-of-sample number in the result. */
  holdoutFraction: number;
  /** Fraction of candles (taken from the end, before the holdout slice) held out as the validate
   * set — used to choose which shortlisted configs become the final `keepTop` finalists. It is
   * out-of-sample relative to training, but it IS selection data, not a holdout: it drives the
   * final ranking, same as `oosFraction` used to. */
  validateFraction: number;
  coarseBudget: GridBudget;
  refineOptions: RefineOptions;
  /** How many top coarse-scoring configs to build refine neighborhoods around. */
  topKToRefine: number;
  /** How many train-ranked candidates advance to the validate pass. Deliberately wider than
   * `keepTop` — cutting to `keepTop` by train score before validate would just relocate the
   * selection pressure from holdout to train instead of removing it; validate needs a real pool
   * to choose from. */
  shortlistSize: number;
  /** How many validate-ranked finalists to return (each also evaluated on holdout for reporting). */
  keepTop: number;
  /** When set (folds > 1), selection uses walk-forward validation instead of one continuous
   * validate-period score — see WalkForwardOptions. Left unset by default: it's meaningfully
   * more expensive, and a single fixed split is still a reasonable default for a quick search. */
  walkForward?: WalkForwardOptions;
  /** Minimum sample size for a config to score above 0 lives on `scoreWeights.minTrades` (read
   * inside `scoreResult`) — there is deliberately no separate `minTrades` here. A prior version
   * of this type had both, and only `scoreWeights.minTrades` was ever actually consulted, so a
   * caller setting the top-level one alone silently had no effect. */
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
  holdoutFraction: 0.15,
  validateFraction: 0.15,
  coarseBudget: DEFAULT_COARSE_BUDGET,
  refineOptions: DEFAULT_REFINE_OPTIONS,
  topKToRefine: 5,
  shortlistSize: 20,
  keepTop: 5,
  scoreWeights: DEFAULT_SCORE_WEIGHTS,
  yieldEvery: 25,
};

export class CancelledError extends Error {}

export interface SearchResult {
  params: Record<string, number>;
  trainStats: BacktestStats;
  validateStats: BacktestStats;
  holdoutStats: BacktestStats;
  trainScore: number;
  validateScore: number;
  holdoutScore: number;
  /** validateScore / trainScore — how much of the in-sample edge survived on the set that
   * actually drove selection. Near 1 held up; near/below 0 didn't. trainScore is always > 0 for
   * a finalist, so this division is safe. */
  validateRatio: number;
  /** holdoutScore / trainScore — the true out-of-sample check. This set never influenced which
   * finalists were kept or how they were ranked, unlike validateRatio. Replaces the old boolean
   * overfitFlag (which only ever looked at a single magic 0.3 threshold on the same data used
   * for selection) with a number that carries how *much* the edge held up, on data that's
   * actually untouched. */
  holdoutRatio: number;
  /** How many distinct param combos this cell's coarse + refine passes actually evaluated —
   * context for how much selection pressure a single winner survived (a winner out of 2,000
   * combos should be trusted less than one out of 20). Same value across every finalist from one
   * cell. */
  combosEvaluated: number;
  /** One score per walk-forward fold, present only when `SearchOptions.walkForward` was set.
   * `validateScore` above is their mean — this is what it's a mean *of*, so the UI can show how
   * consistent (or not) the edge was across folds rather than just the blended number. */
  walkForwardScores?: number[];
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
  // Rounded to 6dp before joining — unrounded floats let two configs whose trades are
  // economically identical but differ by ~1e-13 of accumulated rounding error (e.g. two "junk"
  // param values that never change any decision, just float noise from evaluation order) both
  // survive dedup as if they were genuinely distinct outcomes.
  const round = (v: number) => roundTo(v, 6);
  const pf = stats.profitFactor === null ? "null" : round(stats.profitFactor);
  return [round(stats.totalPnlPct), stats.totalTrades, round(stats.winRatePct), round(stats.maxDrawdownPct), pf].join("|");
}

/** Splits `items` into `folds` sequential, non-overlapping, chronologically-ordered chunks —
 * clamped to at most one item's worth of folds so a fold is never empty. */
function splitIntoFolds<T>(items: readonly T[], folds: number): T[][] {
  const n = Math.max(1, Math.min(Math.floor(folds), items.length));
  const size = Math.floor(items.length / n);
  const out: T[][] = [];
  for (let i = 0; i < n; i++) {
    const start = i * size;
    const end = i === n - 1 ? items.length : start + size;
    out.push(items.slice(start, end));
  }
  return out;
}

/**
 * Coarse-grid search over one (strategy, symbol, timeframe) cell, refined around the best
 * regions, then selected on a validate split and reported on a holdout split the search never
 * saw and never selects on. Three-way split (train / validate / holdout), chronological in that
 * order — holdout is always the most recent slice, closest to "if this went live today". Ranking
 * by train score alone reliably surfaces curve-fit configs; ranking the *final* result by
 * validate (rather than by train, or worse, by the holdout meant to be untouched) is what makes
 * a result defensible enough to trade. Operates on already-fetched candles; the caller
 * (optimizationRunner.ts) owns candle fetching and DB/progress persistence.
 */
export async function searchCell(
  strategy: StrategyDefinition,
  candles: readonly Candle[],
  timeframe: TimeframeId,
  engineConfig: EngineConfig,
  opts: SearchOptions = DEFAULT_SEARCH_OPTIONS,
): Promise<SearchResult[]> {
  const trainEnd = Math.floor(candles.length * (1 - opts.validateFraction - opts.holdoutFraction));
  const validateEnd = Math.floor(candles.length * (1 - opts.holdoutFraction));
  const trainCandles = candles.slice(0, trainEnd);
  const validateCandles = candles.slice(trainEnd, validateEnd);
  const holdoutCandles = candles.slice(validateEnd);
  if (trainCandles.length === 0 || validateCandles.length === 0 || holdoutCandles.length === 0) return [];

  const trainFraction = 1 - opts.validateFraction - opts.holdoutFraction;
  const validateWeights: ScoreWeights = {
    ...opts.scoreWeights,
    minTrades: scaledMinTrades(opts.scoreWeights.minTrades, opts.validateFraction, trainFraction),
  };
  const holdoutWeights: ScoreWeights = {
    ...opts.scoreWeights,
    minTrades: scaledMinTrades(opts.scoreWeights.minTrades, opts.holdoutFraction, trainFraction),
  };

  let evaluatedSinceYield = 0;
  async function maybeYield() {
    evaluatedSinceYield++;
    if (evaluatedSinceYield >= opts.yieldEvery) {
      evaluatedSinceYield = 0;
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // ── Coarse pass over training data ──────────────────────────────────────────
  const coarseCombos = buildCoarseGrid(strategy, opts.coarseBudget);
  const coarseScored = await evaluateBatch(strategy, trainCandles, coarseCombos, engineConfig, timeframe, opts.scoreWeights, opts, maybeYield);
  coarseScored.sort((a, b) => b.score - a.score);

  // ── Refine pass: zoom in around the best coarse regions ────────────────────
  const topCoarse = coarseScored.filter((c) => c.score > 0).slice(0, opts.topKToRefine);
  const seen = new Set(coarseScored.map((c) => JSON.stringify(c.params)));
  const refineCombos: Record<string, number>[] = [];
  // One rng shared across every neighborhood (not reseeded per winner) — still fully
  // deterministic for a given strategy+candles+options, just advancing through one sequence.
  const refineRng = mulberry32(hashSeed(`${strategy.id}:refine`));
  for (const c of topCoarse) {
    for (const params of refineAround(strategy, c.params, opts.refineOptions, refineRng)) {
      const key = JSON.stringify(params);
      if (seen.has(key)) continue;
      seen.add(key);
      refineCombos.push(params);
    }
  }

  const refinedScored = await evaluateBatch(strategy, trainCandles, refineCombos, engineConfig, timeframe, opts.scoreWeights, opts, maybeYield);
  const combosEvaluated = coarseCombos.length + refineCombos.length;

  // ── Shortlist by train score (coarse + refined, best score per distinct outcome) ───────────
  // Deduping by outcome rather than by literal param equality is what actually stops
  // twin/near-twin configs from crowding out genuinely different ones — see outcomeKey. This is
  // a shortlist, not the final finalist set: cutting straight to `keepTop` here (by train score)
  // would leave validate nothing real to select among.
  const bestByOutcome = new Map<string, { params: Record<string, number>; score: number; stats: BacktestStats }>();
  for (const c of [...coarseScored, ...refinedScored]) {
    if (c.score <= 0) continue;
    const key = outcomeKey(c.stats);
    const existing = bestByOutcome.get(key);
    if (!existing || c.score > existing.score) bestByOutcome.set(key, { params: c.params, score: c.score, stats: c.stats });
  }
  const shortlist = [...bestByOutcome.values()].sort((a, b) => b.score - a.score).slice(0, opts.shortlistSize);

  // ── Select on validate: this is the pass that actually decides the final ranking ───────────
  // validateStats/validateResults always come from one continuous backtest over the whole
  // validate window, regardless of walk-forward — that's what's shown as the headline
  // "Validate" numbers. What *ranks* the shortlist differs: with walk-forward, it's the mean of
  // several rolling fold scores instead of this single continuous-period score (see below).
  const shortlistParams = shortlist.map((s) => s.params);
  const validateResults = await evaluateBatch(strategy, validateCandles, shortlistParams, engineConfig, timeframe, validateWeights, opts, maybeYield);

  let rankingScores: number[] = validateResults.map((v) => v.score);
  let walkForwardScoresByIndex: number[][] | undefined;
  if (opts.walkForward && opts.walkForward.folds > 1) {
    const foldFraction = opts.validateFraction / opts.walkForward.folds;
    const foldWeights: ScoreWeights = { ...opts.scoreWeights, minTrades: scaledMinTrades(opts.scoreWeights.minTrades, foldFraction, trainFraction) };
    const foldCandleSets = splitIntoFolds(validateCandles, opts.walkForward.folds);
    const perFoldResults = await Promise.all(
      foldCandleSets.map((foldCandles) => evaluateBatch(strategy, foldCandles, shortlistParams, engineConfig, timeframe, foldWeights, opts, maybeYield)),
    );
    walkForwardScoresByIndex = shortlist.map((_, i) => perFoldResults.map((foldResults) => foldResults[i]!.score));
    rankingScores = walkForwardScoresByIndex.map((scores) => scores.reduce((sum, s) => sum + s, 0) / scores.length);
  }

  const ranked = shortlist
    .map((s, i) => {
      const validate = validateResults[i]!;
      return {
        params: s.params,
        trainScore: s.score,
        trainStats: s.stats,
        validateScore: rankingScores[i]!,
        validateStats: validate.stats,
        walkForwardScores: walkForwardScoresByIndex?.[i],
      };
    })
    .sort((a, b) => b.validateScore - a.validateScore)
    .slice(0, opts.keepTop);

  // ── Report on holdout — evaluated only for the already-chosen finalists, purely for the
  // record; it never feeds back into ranking or which configs made the cut. ────────────────────
  const holdoutParams = ranked.map((r) => r.params);
  const holdoutResults = await evaluateBatch(strategy, holdoutCandles, holdoutParams, engineConfig, timeframe, holdoutWeights, opts, maybeYield);

  // Already in validateScore-descending order via `ranked` — holdout must never re-sort this.
  return ranked.map((r, i) => {
    const holdout = holdoutResults[i]!;
    return {
      params: r.params,
      trainStats: r.trainStats,
      validateStats: r.validateStats,
      holdoutStats: holdout.stats,
      trainScore: r.trainScore,
      validateScore: r.validateScore,
      holdoutScore: holdout.score,
      walkForwardScores: r.walkForwardScores,
      validateRatio: r.validateScore / r.trainScore,
      holdoutRatio: holdout.score / r.trainScore,
      combosEvaluated,
    };
  });
}
