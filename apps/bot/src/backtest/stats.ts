import type { BacktestTrade, EquityPoint } from "./engine.js";

export interface HistogramBin {
  rangeStart: number;
  rangeEnd: number;
  count: number;
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

export function computeStats(
  trades: readonly BacktestTrade[],
  equityCurve: readonly EquityPoint[],
  initialCapital: number,
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
    avgPnlUsd: mean(trades.map((t) => t.pnlUsd)),
    avgPnlPct: mean(trades.map((t) => t.pnlPct)),
    avgBarsHeld: mean(trades.map((t) => t.barsHeld)),
    largestProfitUsd: trades.length > 0 ? Math.max(...trades.map((t) => t.pnlUsd)) : 0,
    largestLossUsd: trades.length > 0 ? Math.min(...trades.map((t) => t.pnlUsd)) : 0,
    avgProfitPct: mean(winners.map((t) => t.pnlPct)),
    avgLossPct: mean(losers.map((t) => t.pnlPct)),
    returnsHistogram: returnsHistogram(trades),
  };
}
