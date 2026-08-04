import { describe, it, expect } from "vitest";
import { computeStats } from "./stats.js";
import type { BacktestTrade, EquityPoint } from "./engine.js";

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
    barsHeld: 1,
    exitReason: "tp",
    ...overrides,
  };
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

    const stats = computeStats(trades, equityCurve, 10_000);

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
    const stats = computeStats(trades, equityCurve, 10_000);
    expect(stats.profitFactor).toBeNull();
  });

  it("finds the largest peak-to-trough drawdown, not just the final drop", () => {
    const equityCurve: EquityPoint[] = [
      { time: 0, equity: 10_000 },
      { time: 1, equity: 12_000 }, // peak
      { time: 2, equity: 9_000 },  // trough: dd = 3000 (25% of peak)
      { time: 3, equity: 11_000 }, // partial recovery
    ];
    const stats = computeStats([], equityCurve, 10_000);
    expect(stats.maxDrawdownUsd).toBe(3_000);
    expect(stats.maxDrawdownPct).toBeCloseTo(25, 6);
  });

  it("handles zero trades without throwing", () => {
    const stats = computeStats([], [{ time: 0, equity: 10_000 }], 10_000);
    expect(stats.totalTrades).toBe(0);
    expect(stats.winRatePct).toBe(0);
    expect(stats.profitFactor).toBeNull();
    expect(stats.avgPnlUsd).toBe(0);
  });
});
