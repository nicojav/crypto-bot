import { describe, it, expect } from "vitest";
import { countCombinations, generateParamCombinations, runOneBacktest } from "./optimizer.js";
import type { EngineConfig } from "./engine.js";
import type { StrategyDefinition } from "./strategies/types.js";
import type { Candle } from "./types.js";

describe("countCombinations", () => {
  it("counts a single-param sweep inclusively", () => {
    expect(countCombinations([{ param: "fastLen", min: 10, max: 50, step: 5 }])).toBe(9); // 10,15,...,50
  });

  it("multiplies across multiple swept params", () => {
    expect(countCombinations([
      { param: "fastLen", min: 10, max: 50, step: 5 }, // 9 values
      { param: "slowLen", min: 30, max: 100, step: 10 }, // 8 values
    ])).toBe(72);
  });

  it("handles fractional steps without floating-point drift undercounting", () => {
    // (5 - 0.5) / 0.1 = 44.99999999999999 in raw floating point — must still count 45 values.
    expect(countCombinations([{ param: "bbMult", min: 0.5, max: 5, step: 0.1 }])).toBe(46);
  });

  it("returns 1 for an empty sweep", () => {
    expect(countCombinations([])).toBe(1);
  });
});

describe("generateParamCombinations", () => {
  it("returns just the base params when nothing is swept", () => {
    expect(generateParamCombinations({ fastLen: 20, slowLen: 50 }, [])).toEqual([{ fastLen: 20, slowLen: 50 }]);
  });

  it("produces the Cartesian product for two swept params, preserving fixed base params", () => {
    const combos = generateParamCombinations(
      { fastLen: 20, slowLen: 50, tpPct: 1.5 },
      [
        { param: "fastLen", min: 10, max: 20, step: 10 }, // [10, 20]
        { param: "slowLen", min: 30, max: 50, step: 20 }, // [30, 50]
      ],
    );
    expect(combos).toHaveLength(4);
    expect(combos).toEqual(expect.arrayContaining([
      { fastLen: 10, slowLen: 30, tpPct: 1.5 },
      { fastLen: 10, slowLen: 50, tpPct: 1.5 },
      { fastLen: 20, slowLen: 30, tpPct: 1.5 },
      { fastLen: 20, slowLen: 50, tpPct: 1.5 },
    ]));
  });

  it("produces clean (non-floating-point-drifted) values for fractional steps", () => {
    const combos = generateParamCombinations({}, [{ param: "bbMult", min: 0.1, max: 0.4, step: 0.1 }]);
    expect(combos.map((c) => c.bbMult)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("degenerate step (<=0) falls back to a single value at min", () => {
    const combos = generateParamCombinations({}, [{ param: "x", min: 5, max: 10, step: 0 }]);
    expect(combos).toEqual([{ x: 5 }]);
  });
});

describe("runOneBacktest", () => {
  it("wires strategy.run -> engine -> stats together for a single param combination", () => {
    const candles: Candle[] = [100, 101, 102, 101, 100].map((close, i) => ({
      openTime: i, open: close, high: close + 1, low: close - 1, close, volume: 1,
    }));
    const strategy: StrategyDefinition = {
      id: "noop",
      label: "No-op",
      description: "",
      params: [],
      run: () => [{ barIndex: 0, time: 0, action: "long" }],
    };
    const config: EngineConfig = {
      initialCapital: 1_000, maxPositionUsd: 100, leverage: 1, feeBps: 0, slippageBps: 0,
      fillModel: "signalClose", lotSize: 0.001, tickSize: 0.01,
    };

    const result = runOneBacktest(strategy, candles, {}, config);

    expect(result.trades).toHaveLength(1);
    expect(result.stats.totalTrades).toBe(1);
    expect(result.equityCurve).toHaveLength(candles.length);
  });
});
