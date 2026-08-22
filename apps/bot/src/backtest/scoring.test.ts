import { describe, it, expect } from "vitest";
import { scoreResult, DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from "./scoring.js";
import type { EquityPoint } from "./engine.js";
import type { BacktestStats } from "./stats.js";

// Isolates tests below from the minTrades gate so they can exercise the rest of the scoring
// formula on small fixtures without tripping over DEFAULT_SCORE_WEIGHTS.minTrades (30) — the gate
// itself has its own dedicated test.
const LOOSE_WEIGHTS: ScoreWeights = { ...DEFAULT_SCORE_WEIGHTS, minTrades: 1 };

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
    totalPnlUsd: 0, totalPnlPct: 0, maxDrawdownUsd: 0, maxDrawdownPct: 0, totalTrades: 40,
    winners: 0, losers: 0, breakevens: 0, winRatePct: 0, profitFactor: 1, avgPnlUsd: 0,
    avgPnlPct: 0, avgBarsHeld: 0, largestProfitUsd: 0, largestLossUsd: 0, avgProfitPct: 0,
    avgLossPct: 0, returnsHistogram: [], sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
    expectancy: null, exposurePct: 0, maxConsecutiveLosses: 0, exitReasonBreakdown: [],
    monthlyReturns: [], ...overrides,
  };
}

describe("scoreResult", () => {
  it("gates to 0 below minTrades regardless of how good the curve looks", () => {
    const curve = curveFromReturns(1000, [0.05, 0.05, 0.05]);
    const stats = statsWith({ totalTrades: 3, totalPnlPct: 15, profitFactor: 3 });
    expect(scoreResult({ stats, equityCurve: curve }, "1d", DEFAULT_SCORE_WEIGHTS)).toBe(0);
  });

  it("scores a profitable, low-drawdown result above a profitable, high-drawdown one", () => {
    const goodCurve = curveFromReturns(1000, [0.02, 0.01, 0.02, 0.01, 0.02]);
    const badCurve = curveFromReturns(1000, [0.10, -0.08, 0.10, -0.08, 0.06]);
    const goodStats = statsWith({ totalTrades: 40, totalPnlPct: 8, maxDrawdownPct: 2, profitFactor: 2 });
    const badStats = statsWith({ totalTrades: 40, totalPnlPct: 8, maxDrawdownPct: 30, profitFactor: 1.1 });

    const goodScore = scoreResult({ stats: goodStats, equityCurve: goodCurve }, "1d", DEFAULT_SCORE_WEIGHTS);
    const badScore = scoreResult({ stats: badStats, equityCurve: badCurve }, "1d", DEFAULT_SCORE_WEIGHTS);
    expect(goodScore).toBeGreaterThan(badScore);
  });

  it("scores a small-sample no-losers (null) profitFactor below a real high one, but the same once the sample is large enough to trust it", () => {
    const curve = curveFromReturns(1000, [0.01, 0.01, 0.01, 0.01, 0.01]);

    // Few trades: "no losers yet" is as likely to be luck as skill, so it shouldn't earn the
    // same score as an actually-computed 500x ratio (itself clamped to the same cap).
    const smallNullPf = statsWith({ totalTrades: 10, totalPnlPct: 5, profitFactor: null });
    const smallHugePf = statsWith({ totalTrades: 10, totalPnlPct: 5, profitFactor: 500 });
    expect(scoreResult({ stats: smallNullPf, equityCurve: curve }, "1d", LOOSE_WEIGHTS)).toBeLessThan(
      scoreResult({ stats: smallHugePf, equityCurve: curve }, "1d", LOOSE_WEIGHTS),
    );

    // 30+ trades with zero losers is a real signal — both clamp to the same capped value.
    const largeNullPf = statsWith({ totalTrades: 30, totalPnlPct: 5, profitFactor: null });
    const largeHugePf = statsWith({ totalTrades: 30, totalPnlPct: 5, profitFactor: 500 });
    expect(scoreResult({ stats: largeNullPf, equityCurve: curve }, "1d", LOOSE_WEIGHTS)).toBeCloseTo(
      scoreResult({ stats: largeHugePf, equityCurve: curve }, "1d", LOOSE_WEIGHTS),
      10,
    );
  });

  it("is deterministic for identical inputs", () => {
    const curve = curveFromReturns(1000, [0.01, -0.005, 0.02]);
    const stats = statsWith({ totalTrades: 40, totalPnlPct: 4, maxDrawdownPct: 3, profitFactor: 1.5 });
    const a = scoreResult({ stats, equityCurve: curve }, "1d");
    const b = scoreResult({ stats, equityCurve: curve }, "1d");
    expect(a).toBe(b);
  });
});
