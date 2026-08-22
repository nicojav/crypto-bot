import type { EquityPoint } from "./engine.js";
import type { BacktestStats } from "./stats.js";
import { computeSharpe } from "./stats.js";
import type { TimeframeId } from "../exchange/bybit.js";

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
  // 30 is the usual rule-of-thumb floor for treating a sample as roughly normal — 10 let win
  // rate, profit factor, and drawdown all swing on a handful of trades, which is exactly the
  // kind of noise the search is supposed to be filtering out, not ranking on.
  minTrades: 30,
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
  // A null profitFactor means zero losing trades — an undefined ratio, not "infinite edge". On a
  // small sample that's just as likely to be a lucky streak as real skill, so it shouldn't hand
  // out the same max score as a real, computed 5.0 ratio (which needed actual losses to divide
  // against). Scale it up with trade count instead: it only reaches the cap once "no losers" has
  // survived enough trades to actually mean something.
  const profitFactor = stats.profitFactor === null ? Math.min(5, stats.totalTrades / 6) : Math.min(stats.profitFactor, 5);
  const pnlComponent = stats.totalPnlPct / 100;

  const raw =
    sharpe * weights.sharpeWeight +
    profitFactor * weights.profitFactorWeight +
    pnlComponent * weights.pnlWeight;

  const ddPenalty = 1 + (stats.maxDrawdownPct / 100) * weights.drawdownPenalty;
  return raw / ddPenalty;
}
