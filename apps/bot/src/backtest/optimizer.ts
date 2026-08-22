import { runBacktestEngine, type EngineConfig, type BacktestTrade, type EquityPoint } from "./engine.js";
import { computeStats, type BacktestStats } from "./stats.js";
import type { StrategyDefinition } from "./strategies/types.js";
import type { Candle } from "./types.js";
import type { TimeframeId } from "../exchange/bybit.js";

export interface SweepParam {
  param: string;
  min: number;
  max: number;
  step: number;
}

// Clean up floating-point drift from repeated addition (e.g. 0.1 + 0.1 + 0.1 !== 0.3).
function roundTo(value: number, precision = 8): number {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
}

/** Number of values a single swept param's range/step produces (inclusive of both ends). */
function stepsFor(sweep: SweepParam): number {
  if (sweep.step <= 0 || sweep.max < sweep.min) return 1;
  return Math.round((sweep.max - sweep.min) / sweep.step) + 1;
}

/** Total combinations a sweep spec would produce — check this against a cap before running anything. */
export function countCombinations(sweep: readonly SweepParam[]): number {
  return sweep.reduce((total, s) => total * stepsFor(s), 1);
}

/**
 * Cartesian product of 1+ swept params' value ranges, each combination merged over
 * `baseParams` (the fixed values for every other param). Pure — no candle/engine access.
 */
export function generateParamCombinations(baseParams: Record<string, number>, sweep: readonly SweepParam[]): Record<string, number>[] {
  if (sweep.length === 0) return [{ ...baseParams }];

  const valueLists = sweep.map((s) => {
    const count = stepsFor(s);
    const values: number[] = [];
    for (let i = 0; i < count; i++) values.push(roundTo(s.min + i * s.step));
    return values;
  });

  let combos: Record<string, number>[] = [{ ...baseParams }];
  for (let i = 0; i < sweep.length; i++) {
    const paramName = sweep[i]!.param;
    const values = valueLists[i]!;
    const next: Record<string, number>[] = [];
    for (const combo of combos) {
      for (const v of values) next.push({ ...combo, [paramName]: v });
    }
    combos = next;
  }
  return combos;
}

export interface OneBacktestResult {
  trades: BacktestTrade[];
  equityCurve: EquityPoint[];
  buyHoldCurve: EquityPoint[];
  stats: BacktestStats;
}

/** Runs a single strategy+params backtest against an already-fetched candle array. */
export function runOneBacktest(
  strategy: StrategyDefinition,
  candles: readonly Candle[],
  params: Record<string, number>,
  engineConfig: EngineConfig,
  timeframe: TimeframeId,
): OneBacktestResult {
  const signals = strategy.run(candles, params);
  const { trades, equityCurve, buyHoldCurve, maxDrawdownUsd, maxDrawdownPct } = runBacktestEngine(candles, signals, engineConfig);
  const stats = computeStats(trades, equityCurve, engineConfig.initialCapital, timeframe, { abs: maxDrawdownUsd, pct: maxDrawdownPct });
  return { trades, equityCurve, buyHoldCurve, stats };
}
