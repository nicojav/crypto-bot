import { describe, it, expect } from "vitest";
import { computeSharpe, computeCalmar, scoreResult, DEFAULT_SCORE_WEIGHTS } from "./scoring.js";
import type { EquityPoint } from "./engine.js";
import type { BacktestStats } from "./stats.js";

const DAY_MS = 24 * 60 * 60_000;

function curveFromReturns(startEquity: number, returns: number[]): EquityPoint[] {
  const points: EquityPoint[] = [{ time: 0, equity: startEquity }];
  let equity = startEquity;
  for (let i = 0; i < returns.length; i++) {
    equity *= 1 + returns[i]!;
    points.push({ time: (i + 1) * DAY_MS, equity });
  }
  return points;
}

function statsWith(overrides: Partial<BacktestStats>): BacktestStats {
  return {
    totalPnlUsd: 0, totalPnlPct: 0, maxDrawdownUsd: 0, maxDrawdownPct: 0, totalTrades: 20,
    winners: 0, losers: 0, breakevens: 0, winRatePct: 0, profitFactor: 1, avgPnlUsd: 0,
    avgPnlPct: 0, avgBarsHeld: 0, largestProfitUsd: 0, largestLossUsd: 0, avgProfitPct: 0,
    avgLossPct: 0, returnsHistogram: [], ...overrides,
  };
}

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

describe("computeCalmar", () => {
  it("returns 0 when there's no drawdown", () => {
    const curve = curveFromReturns(1000, [0.01, 0.01, 0.01]);
    expect(computeCalmar(statsWith({ maxDrawdownPct: 0 }), curve)).toBe(0);
  });

  it("returns 0 for a curve with fewer than 2 points", () => {
    expect(computeCalmar(statsWith({ maxDrawdownPct: 10 }), [{ time: 0, equity: 100 }])).toBe(0);
  });

  it("is positive when equity ends above where it started, despite some drawdown", () => {
    const curve = curveFromReturns(1000, [0.05, -0.02, 0.05, -0.02, 0.05]);
    expect(computeCalmar(statsWith({ maxDrawdownPct: 5 }), curve)).toBeGreaterThan(0);
  });
});

describe("scoreResult", () => {
  it("gates to 0 below minTrades regardless of how good the curve looks", () => {
    const curve = curveFromReturns(1000, [0.05, 0.05, 0.05]);
    const stats = statsWith({ totalTrades: 3, totalPnlPct: 15, profitFactor: 3 });
    expect(scoreResult({ stats, equityCurve: curve }, "1d", DEFAULT_SCORE_WEIGHTS)).toBe(0);
  });

  it("scores a profitable, low-drawdown result above a profitable, high-drawdown one", () => {
    const goodCurve = curveFromReturns(1000, [0.02, 0.01, 0.02, 0.01, 0.02]);
    const badCurve = curveFromReturns(1000, [0.10, -0.08, 0.10, -0.08, 0.06]);
    const goodStats = statsWith({ totalTrades: 20, totalPnlPct: 8, maxDrawdownPct: 2, profitFactor: 2 });
    const badStats = statsWith({ totalTrades: 20, totalPnlPct: 8, maxDrawdownPct: 30, profitFactor: 1.1 });

    const goodScore = scoreResult({ stats: goodStats, equityCurve: goodCurve }, "1d", DEFAULT_SCORE_WEIGHTS);
    const badScore = scoreResult({ stats: badStats, equityCurve: badCurve }, "1d", DEFAULT_SCORE_WEIGHTS);
    expect(goodScore).toBeGreaterThan(badScore);
  });

  it("caps the profit-factor contribution so a no-losers (null) fluke can't dominate", () => {
    const curve = curveFromReturns(1000, [0.01, 0.01, 0.01, 0.01, 0.01]);
    const nullPf = statsWith({ totalTrades: 20, totalPnlPct: 5, profitFactor: null });
    const hugePf = statsWith({ totalTrades: 20, totalPnlPct: 5, profitFactor: 500 });
    // Both should be scored identically — both clamp to the same capped profit-factor value.
    expect(scoreResult({ stats: nullPf, equityCurve: curve }, "1d")).toBeCloseTo(
      scoreResult({ stats: hugePf, equityCurve: curve }, "1d"),
      10,
    );
  });

  it("is deterministic for identical inputs", () => {
    const curve = curveFromReturns(1000, [0.01, -0.005, 0.02]);
    const stats = statsWith({ totalTrades: 15, totalPnlPct: 4, maxDrawdownPct: 3, profitFactor: 1.5 });
    const a = scoreResult({ stats, equityCurve: curve }, "1d");
    const b = scoreResult({ stats, equityCurve: curve }, "1d");
    expect(a).toBe(b);
  });
});
