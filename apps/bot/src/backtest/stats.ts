import type { BacktestTrade, EquityPoint, ExitReason } from "./engine.js";
import type { TimeframeId } from "../exchange/bybit.js";
import { TIMEFRAME_MS } from "../exchange/bybit.js";

const MS_PER_YEAR = 365 * 24 * 60 * 60_000;

export interface HistogramBin {
  rangeStart: number;
  rangeEnd: number;
  count: number;
}

export interface ExitReasonBreakdown {
  exitReason: ExitReason;
  count: number;
  avgPnlUsd: number;
}

export interface MonthlyReturn {
  /** UTC calendar month, "YYYY-MM". */
  month: string;
  returnPct: number;
}

export interface BacktestStats {
  totalPnlUsd: number;
  totalPnlPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winners: number;
  losers: number;
  breakevens: number;
  winRatePct: number;
  /** null when there are no losing trades (undefined ratio — surfaced as "∞" by the UI). */
  profitFactor: number | null;
  avgPnlUsd: number;
  avgPnlPct: number;
  avgBarsHeld: number;
  largestProfitUsd: number;
  largestLossUsd: number;
  avgProfitPct: number;
  avgLossPct: number;
  returnsHistogram: HistogramBin[];
  /** Annualized, risk-free rate assumed 0 — see computeSharpe. */
  sharpeRatio: number;
  /** Like Sharpe but only penalizes downside volatility — see computeSortino. */
  sortinoRatio: number;
  /** CAGR / max drawdown % — see computeCalmar. 0 when undefined (flat curve / no drawdown). */
  calmarRatio: number;
  /** Average trade PnL expressed in units of the average loss — "how many R-multiples per trade,
   * on average". null when there are no losing trades (nothing to normalize against). */
  expectancy: number | null;
  /** % of bars in the backtest window that held an open position (sum of barsHeld / bar count). */
  exposurePct: number;
  /** Total trading fees paid across all trades (entry + exit). */
  totalFeesUsd: number;
  /** Total funding paid (positive) or received (negative) across all trades. */
  totalFundingUsd: number;
  /** Fees + funding as % of initial capital — the headline "what did it cost to run this". */
  costDragPct: number;
  /**
   * Mean per-trade price edge BEFORE costs, in %. Compare directly against `avgCostPct`: these
   * two numbers are the diagnostic for why a high-frequency config loses. A strategy can have a
   * real, positive `avgGrossPnlPct` and still bleed to death because it pays `avgCostPct` to
   * capture it — which on intraday timeframes is the usual story, and is otherwise invisible
   * behind a single red PnL number.
   */
  avgGrossPnlPct: number;
  /** Mean per-trade cost (fees + funding) as % of the position's entry notional. */
  avgCostPct: number;
  /** Longest run of consecutive losing trades, in chronological order. */
  maxConsecutiveLosses: number;
  exitReasonBreakdown: ExitReasonBreakdown[];
  monthlyReturns: MonthlyReturn[];
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function maxDrawdown(equityCurve: readonly EquityPoint[]): { abs: number; pct: number } {
  let peak = equityCurve[0]?.equity ?? 0;
  let maxDdAbs = 0;
  let maxDdPct = 0;
  for (const p of equityCurve) {
    if (p.equity > peak) peak = p.equity;
    const dd = peak - p.equity;
    if (dd > maxDdAbs) maxDdAbs = dd;
    const ddPct = peak > 0 ? (dd / peak) * 100 : 0;
    if (ddPct > maxDdPct) maxDdPct = ddPct;
  }
  return { abs: maxDdAbs, pct: maxDdPct };
}

function barReturns(equityCurve: readonly EquityPoint[]): number[] {
  const returns: number[] = [];
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!.equity;
    const curr = equityCurve[i]!.equity;
    if (prev === 0) continue;
    returns.push((curr - prev) / prev);
  }
  return returns;
}

/**
 * Annualized Sharpe ratio (risk-free rate assumed 0) computed from bar-to-bar equity-curve
 * returns, using *sample* variance (n-1) — the equity curve is a sample of the strategy's return
 * distribution, not the whole population of it, so n-1 is the correct (and slightly more
 * conservative) divisor. Annualization uses the strategy's own timeframe, so a 5m and a 1d
 * equity curve with the same "shape" produce comparable Sharpe values.
 */
export function computeSharpe(equityCurve: readonly EquityPoint[], timeframe: TimeframeId): number {
  const returns = barReturns(equityCurve);
  if (returns.length < 2) return 0;

  const avg = mean(returns);
  const variance = returns.reduce((a, r) => a + (r - avg) ** 2, 0) / (returns.length - 1);
  const stddev = Math.sqrt(variance);
  if (stddev === 0) return 0;

  const periodsPerYear = MS_PER_YEAR / TIMEFRAME_MS[timeframe];
  return (avg / stddev) * Math.sqrt(periodsPerYear);
}

/**
 * Annualized Sortino ratio — like Sharpe, but only penalizes downside volatility (returns below
 * 0, the minimum acceptable return) instead of volatility in both directions. A strategy with
 * big, infrequent upside swings and small, steady downside looks better here than under Sharpe,
 * which penalizes that upside volatility too.
 */
export function computeSortino(equityCurve: readonly EquityPoint[], timeframe: TimeframeId): number {
  const returns = barReturns(equityCurve);
  if (returns.length < 2) return 0;

  const avg = mean(returns);
  const downside = returns.filter((r) => r < 0);
  if (downside.length === 0) return 0; // no downside at all — undefined ratio, treat as 0 rather than Infinity

  const downsideVariance = downside.reduce((a, r) => a + r * r, 0) / downside.length; // deviation from 0 (the MAR), not from the mean — standard Sortino convention
  const downsideDeviation = Math.sqrt(downsideVariance);
  if (downsideDeviation === 0) return 0;

  const periodsPerYear = MS_PER_YEAR / TIMEFRAME_MS[timeframe];
  return (avg / downsideDeviation) * Math.sqrt(periodsPerYear);
}

/** Calmar ratio: annualized return (CAGR) divided by max drawdown %. 0 when undefined (flat/no drawdown). */
export function computeCalmar(equityCurve: readonly EquityPoint[], maxDrawdownPct: number): number {
  if (equityCurve.length < 2 || maxDrawdownPct === 0) return 0;
  const first = equityCurve[0]!;
  const last = equityCurve[equityCurve.length - 1]!;
  if (first.equity <= 0) return 0;

  const years = (last.time - first.time) / MS_PER_YEAR;
  if (years <= 0) return 0;

  const cagr = (last.equity / first.equity) ** (1 / years) - 1;
  return (cagr * 100) / maxDrawdownPct;
}

function returnsHistogram(trades: readonly BacktestTrade[], binWidthPct = 2.5): HistogramBin[] {
  if (trades.length === 0) return [];
  const pcts = trades.map((t) => t.pnlPct);
  const min = Math.min(...pcts);
  const max = Math.max(...pcts);
  const firstBinStart = Math.floor(min / binWidthPct) * binWidthPct;
  const lastBinEnd = Math.ceil(max / binWidthPct) * binWidthPct;
  const binCount = Math.max(1, Math.round((lastBinEnd - firstBinStart) / binWidthPct));

  const bins: HistogramBin[] = Array.from({ length: binCount }, (_, i) => ({
    rangeStart: firstBinStart + i * binWidthPct,
    rangeEnd: firstBinStart + (i + 1) * binWidthPct,
    count: 0,
  }));

  for (const pct of pcts) {
    const idx = Math.min(binCount - 1, Math.floor((pct - firstBinStart) / binWidthPct));
    bins[Math.max(0, idx)]!.count++;
  }
  return bins;
}

function maxConsecutiveLosses(trades: readonly BacktestTrade[]): number {
  let longest = 0;
  let current = 0;
  for (const t of trades) {
    if (t.pnlUsd < 0) {
      current++;
      if (current > longest) longest = current;
    } else {
      current = 0;
    }
  }
  return longest;
}

function exitReasonBreakdown(trades: readonly BacktestTrade[]): ExitReasonBreakdown[] {
  const byReason = new Map<ExitReason, BacktestTrade[]>();
  for (const t of trades) {
    const bucket = byReason.get(t.exitReason);
    if (bucket) bucket.push(t);
    else byReason.set(t.exitReason, [t]);
  }
  return [...byReason.entries()]
    .map(([exitReason, group]) => ({ exitReason, count: group.length, avgPnlUsd: mean(group.map((t) => t.pnlUsd)) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Per-calendar-month compounded return — buckets bar-to-bar equity growth by the UTC month it
 * occurred in and compounds within each month, rather than diffing each month's first/last
 * equity point directly (which would double-count or drop the return that straddles a month
 * boundary between two data points).
 */
function monthlyReturns(equityCurve: readonly EquityPoint[]): MonthlyReturn[] {
  const factors = new Map<string, number>();
  for (let i = 1; i < equityCurve.length; i++) {
    const prev = equityCurve[i - 1]!.equity;
    const curr = equityCurve[i]!.equity;
    if (prev === 0) continue;
    const d = new Date(equityCurve[i]!.time);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    factors.set(month, (factors.get(month) ?? 1) * (curr / prev));
  }
  return [...factors.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, factor]) => ({ month, returnPct: (factor - 1) * 100 }));
}

export function computeStats(
  trades: readonly BacktestTrade[],
  equityCurve: readonly EquityPoint[],
  initialCapital: number,
  timeframe: TimeframeId,
  /** Precomputed intrabar-aware drawdown from the engine (see engine.ts's trackDrawdown) — more
   * accurate than deriving it from the close-only equity curve below, since a position can swing
   * further within a bar than its close reveals. Falls back to the close-based calc when omitted
   * (e.g. a caller that only has an equity curve, not the engine run that produced it). */
  drawdownOverride?: { abs: number; pct: number },
): BacktestStats {
  const finalEquity = equityCurve[equityCurve.length - 1]?.equity ?? initialCapital;
  const totalPnlUsd = finalEquity - initialCapital;
  const totalPnlPct = initialCapital > 0 ? (totalPnlUsd / initialCapital) * 100 : 0;

  const winners = trades.filter((t) => t.pnlUsd > 0);
  const losers = trades.filter((t) => t.pnlUsd < 0);
  const breakevens = trades.filter((t) => t.pnlUsd === 0);

  const grossProfit = winners.reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossLoss = Math.abs(losers.reduce((sum, t) => sum + t.pnlUsd, 0));

  const dd = drawdownOverride ? { abs: drawdownOverride.abs, pct: drawdownOverride.pct } : maxDrawdown(equityCurve);
  const avgPnlUsd = mean(trades.map((t) => t.pnlUsd));
  const avgLossUsd = losers.length > 0 ? mean(losers.map((t) => t.pnlUsd)) : 0;
  const totalBarsHeld = trades.reduce((sum, t) => sum + t.barsHeld, 0);

  // Cost accounting. `trade.pnlPct` is already the raw entry→exit price return (documented as
  // fee- and leverage-unadjusted), so it is the gross edge directly; costs are normalized against
  // each trade's own entry notional so the two are expressed in the same units and comparable.
  const totalFeesUsd = trades.reduce((sum, t) => sum + t.feeUsd, 0);
  const totalFundingUsd = trades.reduce((sum, t) => sum + t.fundingUsd, 0);
  const perTradeCostPct = trades.map((t) => (t.sizeUsd > 0 ? ((t.feeUsd + t.fundingUsd) / t.sizeUsd) * 100 : 0));

  return {
    totalPnlUsd,
    totalPnlPct,
    maxDrawdownUsd: dd.abs,
    maxDrawdownPct: dd.pct,
    totalTrades: trades.length,
    winners: winners.length,
    losers: losers.length,
    breakevens: breakevens.length,
    winRatePct: trades.length > 0 ? (winners.length / trades.length) * 100 : 0,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgPnlUsd,
    avgPnlPct: mean(trades.map((t) => t.pnlPct)),
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),
    largestProfitUsd: trades.length > 0 ? Math.max(...trades.map((t) => t.pnlUsd)) : 0,
    largestLossUsd: trades.length > 0 ? Math.min(...trades.map((t) => t.pnlUsd)) : 0,
    avgProfitPct: mean(winners.map((t) => t.pnlPct)),
    avgLossPct: mean(losers.map((t) => t.pnlPct)),
    returnsHistogram: returnsHistogram(trades),
    sharpeRatio: computeSharpe(equityCurve, timeframe),
    sortinoRatio: computeSortino(equityCurve, timeframe),
    calmarRatio: computeCalmar(equityCurve, dd.pct),
    expectancy: avgLossUsd < 0 ? avgPnlUsd / Math.abs(avgLossUsd) : null,
    exposurePct: equityCurve.length > 0 ? (totalBarsHeld / equityCurve.length) * 100 : 0,
    totalFeesUsd,
    totalFundingUsd,
    costDragPct: initialCapital > 0 ? ((totalFeesUsd + totalFundingUsd) / initialCapital) * 100 : 0,
    avgGrossPnlPct: mean(trades.map((t) => t.pnlPct)),
    avgCostPct: mean(perTradeCostPct),
    maxConsecutiveLosses: maxConsecutiveLosses(trades),
    exitReasonBreakdown: exitReasonBreakdown(trades),
    monthlyReturns: monthlyReturns(equityCurve),
  };
}
