import { describe, it, expect } from "vitest";
import { computeStats, computeSharpe, computeSortino, computeCalmar } from "./stats.js";
import type { BacktestTrade, EquityPoint, ExitReason } from "./engine.js";

const DAY_MS = 24 * 60 * 60_000;

function trade(overrides: Partial<BacktestTrade>): BacktestTrade {
  return {
    entryTime: 0,
    exitTime: 1,
    side: "BUY",
    entryPrice: 100,
    exitPrice: 100,
    qty: 1,
    sizeUsd: 100,
    pnlUsd: 0,
    pnlPct: 0,
    feeUsd: 0,
    fundingUsd: 0,
    barsHeld: 1,
    exitReason: "tp",
    maePct: 0,
    mfePct: 0,
    ...overrides,
  };
}

function curveFromReturns(startEquity: number, returns: number[], startTime = 0): EquityPoint[] {
  const points: EquityPoint[] = [{ time: startTime, equity: startEquity }];
  let equity = startEquity;
  for (let i = 0; i < returns.length; i++) {
    equity *= 1 + returns[i]!;
    points.push({ time: startTime + (i + 1) * DAY_MS, equity });
  }
  return points;
}

describe("computeStats", () => {
  it("computes win rate, profit factor, and pnl from a mix of winners and losers", () => {
    const trades = [
      trade({ pnlUsd: 100, pnlPct: 10 }),
      trade({ pnlUsd: 50, pnlPct: 5 }),
      trade({ pnlUsd: -60, pnlPct: -6 }),
    ];
    const equityCurve: EquityPoint[] = [
      { time: 0, equity: 10_000 },
      { time: 1, equity: 10_090 },
    ];

    const stats = computeStats(trades, equityCurve, 10_000, "1d");

    expect(stats.totalTrades).toBe(3);
    expect(stats.winners).toBe(2);
    expect(stats.losers).toBe(1);
    expect(stats.winRatePct).toBeCloseTo((2 / 3) * 100, 6);
    expect(stats.profitFactor).toBeCloseTo(150 / 60, 6);
    expect(stats.totalPnlUsd).toBe(90); // 10090 - 10000
    expect(stats.largestProfitUsd).toBe(100);
    expect(stats.largestLossUsd).toBe(-60);
  });

  it("returns a null profit factor when there are no losing trades", () => {
    const trades = [trade({ pnlUsd: 100 })];
    const equityCurve: EquityPoint[] = [{ time: 0, equity: 10_100 }];
    const stats = computeStats(trades, equityCurve, 10_000, "1d");
    expect(stats.profitFactor).toBeNull();
  });

  it("finds the largest peak-to-trough drawdown, not just the final drop", () => {
    const equityCurve: EquityPoint[] = [
      { time: 0, equity: 10_000 },
      { time: 1, equity: 12_000 }, // peak
      { time: 2, equity: 9_000 },  // trough: dd = 3000 (25% of peak)
      { time: 3, equity: 11_000 }, // partial recovery
    ];
    const stats = computeStats([], equityCurve, 10_000, "1d");
    expect(stats.maxDrawdownUsd).toBe(3_000);
    expect(stats.maxDrawdownPct).toBeCloseTo(25, 6);
  });

  it("handles zero trades without throwing", () => {
    const stats = computeStats([], [{ time: 0, equity: 10_000 }], 10_000, "1d");
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRatePct).toBe(0);
    expect(stats.profitFactor).toBeNull();
    expect(stats.avgPnlUsd).toBe(0);
  });

  it("computes expectancy as average PnL normalized by average loss size, null with no losers", () => {
    const withLosers = [trade({ pnlUsd: 20 }), trade({ pnlUsd: 20 }), trade({ pnlUsd: -10 })];
    // avgPnlUsd = (20+20-10)/3 = 10; avgLossUsd = -10 -> expectancy = 10 / 10 = 1
    const stats = computeStats(withLosers, [{ time: 0, equity: 10_030 }], 10_000, "1d");
    expect(stats.expectancy).toBeCloseTo(1, 6);

    const noLosers = computeStats([trade({ pnlUsd: 20 })], [{ time: 0, equity: 10_020 }], 10_000, "1d");
    expect(noLosers.expectancy).toBeNull();
  });

  it("computes exposure as the fraction of bars spent holding a position", () => {
    const trades = [trade({ barsHeld: 3 }), trade({ barsHeld: 2 })];
    const equityCurve: EquityPoint[] = Array.from({ length: 10 }, (_, i) => ({ time: i, equity: 10_000 }));
    const stats = computeStats(trades, equityCurve, 10_000, "1d");
    expect(stats.exposurePct).toBeCloseTo(50, 6); // (3+2)/10 * 100
  });

  it("finds the longest run of consecutive losing trades, not just the total loss count", () => {
    const trades = [
      trade({ pnlUsd: 10 }),
      trade({ pnlUsd: -10 }),
      trade({ pnlUsd: -10 }),
      trade({ pnlUsd: -10 }),
      trade({ pnlUsd: 10 }),
      trade({ pnlUsd: -10 }),
    ];
    const stats = computeStats(trades, [{ time: 0, equity: 10_000 }], 10_000, "1d");
    expect(stats.maxConsecutiveLosses).toBe(3);
  });

  it("breaks trades down by exit reason with per-reason average PnL", () => {
    const trades = [
      trade({ exitReason: "tp" as ExitReason, pnlUsd: 100 }),
      trade({ exitReason: "tp" as ExitReason, pnlUsd: 50 }),
      trade({ exitReason: "sl" as ExitReason, pnlUsd: -20 }),
    ];
    const stats = computeStats(trades, [{ time: 0, equity: 10_130 }], 10_000, "1d");
    const tp = stats.exitReasonBreakdown.find((r) => r.exitReason === "tp");
    const sl = stats.exitReasonBreakdown.find((r) => r.exitReason === "sl");
    expect(tp).toEqual({ exitReason: "tp", count: 2, avgPnlUsd: 75 });
    expect(sl).toEqual({ exitReason: "sl", count: 1, avgPnlUsd: -20 });
  });

  it("compounds bar-to-bar returns into per-calendar-month totals", () => {
    // Jan 15 -> Jan 16 (+10%), Jan 16 -> Feb 1 (+10%) -> January should show ~10%, February ~10%.
    const jan15 = Date.UTC(2026, 0, 15);
    const jan16 = Date.UTC(2026, 0, 16);
    const feb1 = Date.UTC(2026, 1, 1);
    const equityCurve: EquityPoint[] = [
      { time: jan15, equity: 1_000 },
      { time: jan16, equity: 1_100 },
      { time: feb1, equity: 1_210 },
    ];
    const stats = computeStats([], equityCurve, 1_000, "1d");
    expect(stats.monthlyReturns).toHaveLength(2);
    expect(stats.monthlyReturns[0]!.month).toBe("2026-01");
    expect(stats.monthlyReturns[0]!.returnPct).toBeCloseTo(10, 6);
    expect(stats.monthlyReturns[1]!.month).toBe("2026-02");
    expect(stats.monthlyReturns[1]!.returnPct).toBeCloseTo(10, 6);
  });
});

describe("computeSharpe", () => {
  it("returns 0 for a curve with fewer than 2 points", () => {
    expect(computeSharpe([{ time: 0, equity: 100 }], "1d")).toBe(0);
  });

  it("returns 0 for a perfectly flat curve (zero variance)", () => {
    const curve = curveFromReturns(1000, [0, 0, 0, 0]);
    expect(computeSharpe(curve, "1d")).toBe(0);
  });

  it("is positive for a steadily rising curve", () => {
    const curve = curveFromReturns(1000, [0.01, 0.01, 0.01, 0.01, 0.01]);
    expect(computeSharpe(curve, "1d")).toBeGreaterThan(0);
  });

  it("is negative for a steadily falling curve", () => {
    const curve = curveFromReturns(1000, [-0.01, -0.01, -0.01, -0.01]);
    expect(computeSharpe(curve, "1d")).toBeLessThan(0);
  });

  it("rewards the same average return with lower volatility (finer timeframe, same shape)", () => {
    const smooth = curveFromReturns(1000, [0.01, 0.01, 0.01, 0.01]);
    const choppy = curveFromReturns(1000, [0.04, -0.02, 0.03, -0.01]); // similar mean, way more variance
    expect(computeSharpe(smooth, "1d")).toBeGreaterThan(computeSharpe(choppy, "1d"));
  });
});

describe("computeSortino", () => {
  it("returns 0 for a curve with fewer than 2 points", () => {
    expect(computeSortino([{ time: 0, equity: 100 }], "1d")).toBe(0);
  });

  it("returns 0 when there's no downside at all (undefined ratio)", () => {
    const curve = curveFromReturns(1000, [0.01, 0.02, 0.01]);
    expect(computeSortino(curve, "1d")).toBe(0);
  });

  it("is positive for a curve with mixed but net-positive returns", () => {
    const curve = curveFromReturns(1000, [0.03, -0.01, 0.03, -0.01]);
    expect(computeSortino(curve, "1d")).toBeGreaterThan(0);
  });

  it("scores the same average return higher than Sharpe when upside volatility is large but downside is steady", () => {
    // Big upside swings, small steady downside — Sortino shouldn't penalize the upside the way Sharpe does.
    const curve = curveFromReturns(1000, [0.10, -0.01, 0.08, -0.01, 0.09, -0.01]);
    const sharpe = computeSharpe(curve, "1d");
    const sortino = computeSortino(curve, "1d");
    expect(sortino).toBeGreaterThan(sharpe);
  });
});

describe("computeCalmar", () => {
  it("returns 0 when there's no drawdown", () => {
    const curve = curveFromReturns(1000, [0.01, 0.01, 0.01]);
    expect(computeCalmar(curve, 0)).toBe(0);
  });

  it("returns 0 for a curve with fewer than 2 points", () => {
    expect(computeCalmar([{ time: 0, equity: 100 }], 10)).toBe(0);
  });

  it("is positive when equity ends above where it started, despite some drawdown", () => {
    const curve = curveFromReturns(1000, [0.05, -0.02, 0.05, -0.02, 0.05]);
    expect(computeCalmar(curve, 5)).toBeGreaterThan(0);
  });
});
