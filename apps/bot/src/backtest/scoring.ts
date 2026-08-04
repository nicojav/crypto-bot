import type { EquityPoint } from "./engine.js";
import type { BacktestStats } from "./stats.js";
import type { TimeframeId } from "../exchange/bybit.js";
import { TIMEFRAME_MS } from "../exchange/bybit.js";

const MS_PER_YEAR = 365 * 24 * 60 * 60_000;

/**
 * Annualized Sharpe ratio (risk-free rate assumed 0) computed from bar-to-bar equity-curve
 * returns. Annualization uses the strategy's own timeframe, so a 5m and a 1d equity curve
 * with the same "shape" produce comparable Sharpe values.
 */
export function computeSharpe(equityCurve: readonly EquityPoint[], timeframe: TimeframeId): number {
  if (equityCurve.length < 2) return 0;

  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!.equity;
    const curr = equityCurve[i]!.equity;
    if (prev === 0) continue;
    returns.push((curr - prev) / prev);
  }
  if (returns.length === 0) return 0;

  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / returns.length;
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;

  const periodsPerYear = MS_PER_YEAR / TIMEFRAME_MS[timeframe];
  return (mean / stddev) * Math.sqrt(periodsPerYear);
}

/** Calmar ratio: annualized return (CAGR) divided by max drawdown %. 0 when undefined (flat/no drawdown). */
export function computeCalmar(stats: BacktestStats, equityCurve: readonly EquityPoint[]): number {
  if (equityCurve.length < 2 || stats.maxDrawdownPct === 0) return 0;
  const first = equityCurve[0]!;
  const last = equityCurve[equityCurve.length - 1]!;
  if (first.equity <= 0) return 0;

  const years = (last.time - first.time) / MS_PER_YEAR;
  if (years <= 0) return 0;

  const cagr = (last.equity / first.equity) ** (1 / years) - 1;
  return (cagr * 100) / stats.maxDrawdownPct;
}

export interface ScoreWeights {
  sharpeWeight: number;
  profitFactorWeight: number;
  pnlWeight: number;
  /** Multiplies maxDrawdownPct/100 before it divides the raw score — higher = harsher drawdown penalty. */
  drawdownPenalty: number;
  /** Configs with fewer trades than this score 0 — too few trades to trust the stats. */
  minTrades: number;
}

export const DEFAULT_SCORE_WEIGHTS: ScoreWeights = {
  sharpeWeight: 1,
  profitFactorWeight: 0.5,
  pnlWeight: 0.5,
  drawdownPenalty: 1,
  minTrades: 10,
};

export interface ScorableResult {
  stats: BacktestStats;
  equityCurve: readonly EquityPoint[];
}

/**
 * Composite risk-adjusted "robustness" score for ranking backtest results — deliberately
 * NOT raw Total PnL%, which rewards curve-fit/lucky configs (see backtestRoutes.ts's older
 * `/optimize` route, which does rank by raw PnL% for the manual sweep). Combines Sharpe,
 * profit factor (capped so a single-trade "no losers yet" fluke can't dominate), and PnL,
 * then divides by a drawdown penalty. Gated to 0 below `minTrades`.
 */
export function scoreResult(
  result: ScorableResult,
  timeframe: TimeframeId,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
): number {
  const { stats, equityCurve } = result;
  if (stats.totalTrades < weights.minTrades) return 0;

  const sharpe = computeSharpe(equityCurve, timeframe);
  const profitFactor = stats.profitFactor === null ? 5 : Math.min(stats.profitFactor, 5);
  const pnlComponent = stats.totalPnlPct / 100;

  const raw =
    sharpe * weights.sharpeWeight +
    profitFactor * weights.profitFactorWeight +
    pnlComponent * weights.pnlWeight;

  const ddPenalty = 1 + (stats.maxDrawdownPct / 100) * weights.drawdownPenalty;
  return raw / ddPenalty;
}
