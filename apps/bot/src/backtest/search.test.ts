import { describe, it, expect, afterEach } from "vitest";
import { buildCoarseGrid, searchCell, CancelledError, DEFAULT_SEARCH_OPTIONS, type SearchOptions } from "./search.js";
import { BacktestWorkerPool } from "./workerPool.js";
import { getStrategy } from "./strategies/index.js";
import type { EngineConfig } from "./engine.js";
import type { StrategyDefinition } from "./strategies/types.js";
import type { Candle } from "./types.js";

const ENGINE: EngineConfig = {
  initialCapital: 1_000, maxPositionUsd: 100, leverage: 1, feeBps: 0, slippageBps: 0,
  fillModel: "signalClose", lotSize: 0.001, tickSize: 0.01,
};

// A gated-param strategy — "mode" is an enum gate for numeric "b", mirroring bbMeanReversion's
// tpslMode/useRsiConfirm shape (StrategyParamDef options + showIf).
const gatedStrategy: StrategyDefinition = {
  id: "gated",
  label: "Gated",
  description: "",
  params: [
    { name: "a", label: "A", default: 5, min: 0, max: 10, step: 1 },
    { name: "mode", label: "Mode", default: 0, min: 0, max: 1, step: 1, options: ["Off", "On"] },
    { name: "b", label: "B", default: 2, min: 0, max: 20, step: 1, showIf: { param: "mode", equals: 1 } },
  ],
  run: () => [],
};

// Three numeric params, each with 5 candidate values (step 2 across [0,8]), and a budget that
// only affords 20 combos. The old Cartesian-expand-then-slice(0, cap) implementation hit the cap
// while still expanding the *second* param, so the third param's values 1-4 were carried in every
// surviving combo but the first param never got past its first value — whole dimensions were
// starved. LHS must give every dimension real coverage regardless of processing order.
const threeNumericParamsStrategy: StrategyDefinition = {
  id: "threeNumeric",
  label: "Three Numeric",
  description: "",
  params: [
    { name: "p0", label: "P0", default: 0, min: 0, max: 8, step: 2 },
    { name: "p1", label: "P1", default: 0, min: 0, max: 8, step: 2 },
    { name: "p2", label: "P2", default: 0, min: 0, max: 8, step: 2 },
  ],
  run: () => [],
};

// Two independent enum gates (2 x 4 = 8 branches) mirroring customMaCross gaining regimeMode(4)
// on top of its existing tpslMode-shaped gates — the case minCombosPerBranch exists to protect.
// "always" has no showIf, so every branch has exactly one visible numeric param regardless of
// which gates are set — keeps the per-branch resolution cap identical across all 8 branches, so
// the floor's effect isn't confounded by some branches simply having nothing to sample.
const manyBranchesStrategy: StrategyDefinition = {
  id: "manyBranches",
  label: "Many Branches",
  description: "",
  params: [
    { name: "gateA", label: "Gate A", default: 0, min: 0, max: 1, step: 1, options: ["Off", "On"] },
    { name: "gateB", label: "Gate B", default: 0, min: 0, max: 3, step: 1, options: ["W", "X", "Y", "Z"] },
    { name: "always", label: "Always visible", default: 5, min: 0, max: 20, step: 1 },
  ],
  run: () => [],
};

describe("buildCoarseGrid", () => {
  it("gives every numeric param real coverage even under a tight combo budget (no starved dimensions)", () => {
    const combos = buildCoarseGrid(threeNumericParamsStrategy, { maxCombosPerCell: 20, maxValuesPerParam: 5 });
    for (const name of ["p0", "p1", "p2"] as const) {
      const values = new Set(combos.map((c) => c[name]));
      expect(values.size).toBeGreaterThan(1);
    }
  });


  it("expands an enum param across every discrete option", () => {
    const combos = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 500, maxValuesPerParam: 5 });
    const modes = new Set(combos.map((c) => c.mode));
    expect(modes).toEqual(new Set([0, 1]));
  });

  it("holds a showIf-gated param at its default in branches where the gate doesn't hold", () => {
    const combos = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 500, maxValuesPerParam: 5 });
    const modeOff = combos.filter((c) => c.mode === 0);
    expect(modeOff.length).toBeGreaterThan(0);
    for (const c of modeOff) expect(c.b).toBe(2); // default, never varied
  });

  it("varies the gated param only in branches where the gate holds", () => {
    const combos = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 500, maxValuesPerParam: 5 });
    const modeOn = combos.filter((c) => c.mode === 1);
    const bValues = new Set(modeOn.map((c) => c.b));
    expect(bValues.size).toBeGreaterThan(1);
  });

  it("respects the maxCombosPerCell cap even when the full cross-product would exceed it", () => {
    const combos = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 10, maxValuesPerParam: 5 });
    expect(combos.length).toBeLessThanOrEqual(10);
  });

  it("every combo's numeric values stay within the param's declared [min, max]", () => {
    const combos = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 500, maxValuesPerParam: 5 });
    for (const c of combos) {
      expect(c.a).toBeGreaterThanOrEqual(0);
      expect(c.a).toBeLessThanOrEqual(10);
      expect(c.b).toBeGreaterThanOrEqual(0);
      expect(c.b).toBeLessThanOrEqual(20);
    }
  });

  it("is deterministic — same strategy + budget produces the same grid", () => {
    const a = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 50, maxValuesPerParam: 4 });
    const b = buildCoarseGrid(gatedStrategy, { maxCombosPerCell: 50, maxValuesPerParam: 4 });
    expect(a).toEqual(b);
  });

  describe("minCombosPerBranch", () => {
    it("without a floor, many branches under a small budget starve most branches to a single combo", () => {
      // 8 branches, budget 20 -> floor(20/8) = 2 per branch. Tightening further makes the point
      // sharper: at maxCombosPerCell 8, plain even split floors to 1 per branch everywhere.
      const combos = buildCoarseGrid(manyBranchesStrategy, { maxCombosPerCell: 8, maxValuesPerParam: 5 });
      const perBranch = new Map<string, number>();
      for (const c of combos) {
        const key = `${c.gateA}:${c.gateB}`;
        perBranch.set(key, (perBranch.get(key) ?? 0) + 1);
      }
      expect(perBranch.size).toBe(8); // every branch still appears at least once
      expect([...perBranch.values()].every((n) => n <= 1)).toBe(true); // but none gets more than 1
    });

    it("with a floor, every branch gets at least minCombosPerBranch even though that exceeds maxCombosPerCell", () => {
      const combos = buildCoarseGrid(manyBranchesStrategy, { maxCombosPerCell: 8, maxValuesPerParam: 10, minCombosPerBranch: 6 });
      const perBranch = new Map<string, number>();
      for (const c of combos) {
        const key = `${c.gateA}:${c.gateB}`;
        perBranch.set(key, (perBranch.get(key) ?? 0) + 1);
      }
      expect(perBranch.size).toBe(8);
      for (const n of perBranch.values()) expect(n).toBeGreaterThanOrEqual(6);
      // Total necessarily exceeds the nominal cap — that's the whole point of the floor.
      expect(combos.length).toBeGreaterThan(8);
    });

    it("never samples a branch past its own resolution cap just to satisfy the floor", () => {
      // maxValuesPerParam 1 x one numeric param -> resolutionCap 1 for every branch, so even a
      // huge floor can't push any branch past a single meaningfully distinct combo.
      const combos = buildCoarseGrid(manyBranchesStrategy, { maxCombosPerCell: 8, maxValuesPerParam: 1, minCombosPerBranch: 50 });
      const perBranch = new Map<string, number>();
      for (const c of combos) {
        const key = `${c.gateA}:${c.gateB}`;
        perBranch.set(key, (perBranch.get(key) ?? 0) + 1);
      }
      for (const n of perBranch.values()) expect(n).toBe(1);
    });
  });
});

// Opens exactly one position at bar 0 (long or short by the "side" param) and holds to the
// window end — lets a test control win/loss purely via the candle price path, without any
// indicator warm-up noise. Mirrors the "noop" strategy pattern in optimizer.test.ts.
function makeSideStrategy(): StrategyDefinition {
  return {
    id: "side",
    label: "Side",
    description: "",
    params: [{ name: "side", label: "Side", default: 0, min: 0, max: 1, step: 1, options: ["Long", "Short"] }],
    run: (candles, params) => (candles.length === 0 ? [] : [{ barIndex: 0, time: candles[0]!.openTime, action: params.side === 1 ? "short" : "long" }]),
  };
}

// Same as makeSideStrategy, but with an extra numeric param that run() never reads. Every
// value of "junk" produces byte-identical trades for a given "side" — a deliberate stand-in
// for the real-world case (e.g. bbMult=2.0 vs 2.05) where nearby param values just don't
// cross any indicator threshold differently on a finite candle set.
function makeSideStrategyWithIgnoredParam(): StrategyDefinition {
  return {
    id: "sideIgnored",
    label: "Side + ignored param",
    description: "",
    params: [
      { name: "side", label: "Side", default: 0, min: 0, max: 1, step: 1, options: ["Long", "Short"] },
      { name: "junk", label: "Junk", default: 5, min: 0, max: 10, step: 1 },
    ],
    run: (candles, params) => (candles.length === 0 ? [] : [{ barIndex: 0, time: candles[0]!.openTime, action: params.side === 1 ? "short" : "long" }]),
  };
}

function trendCandles(count: number, startPrice: number, endPrice: number, startTime = 0): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < count; i++) {
    const close = startPrice + ((endPrice - startPrice) * i) / Math.max(1, count - 1);
    candles.push({ openTime: startTime + i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  }
  return candles;
}

// Mirrors emaRsiPctTpSl's shape — several numeric params all visible simultaneously with no
// showIf gating. This is what exposed the refine step's uncapped Cartesian-product blowup:
// 5 sample values per param ^ 7 params ≈ 78,000 combos for a single coarse winner's
// neighborhood, times every winner being refined.
const manyNumericParamsStrategy: StrategyDefinition = {
  id: "manyNumeric",
  label: "Many numeric",
  description: "",
  params: Array.from({ length: 7 }, (_, i) => ({ name: `p${i}`, label: `P${i}`, default: 5, min: 0, max: 10, step: 1 })),
  run: (candles) => (candles.length === 0 ? [] : [{ barIndex: 0, time: candles[0]!.openTime, action: "long" as const }]),
};

describe("searchCell", () => {
  it("keeps total backtests bounded even with many simultaneously-visible numeric params (regression: refine used to be an uncapped Cartesian product)", async () => {
    const candles = trendCandles(60, 100, 120);
    let backtestCount = 0;
    const opts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      validateFraction: 0.15,
      holdoutFraction: 0.15,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      onBacktest: () => { backtestCount++; },
    };

    await searchCell(manyNumericParamsStrategy, candles, "1d", ENGINE, opts);

    // Coarse (<=200) + refine (5 neighborhoods, each capped at 200) + validate (<=shortlistSize
    // 20) + holdout (<=keepTop 5) stays in the low thousands — nowhere near the
    // ~78,000-per-neighborhood the old uncapped Cartesian product would have produced for this
    // param shape.
    expect(backtestCount).toBeLessThan(2_000);
  });

  it("collapses outcome-identical param combos into a single finalist instead of filling keepTop with twins (regression: dedup used to be by literal param equality, not outcome)", async () => {
    // Uptrend throughout train/validate/holdout — every "junk" value ties for the same "side=0"
    // (long) outcome, so without outcome-dedup, several of the 5 finalist slots would be
    // consumed by side=0 entries that only differ by an unused param.
    const candles = trendCandles(45, 100, 140);
    const opts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      validateFraction: 0.15,
      holdoutFraction: 0.15,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      keepTop: 5,
    };

    const results = await searchCell(makeSideStrategyWithIgnoredParam(), candles, "1d", ENGINE, opts);

    const signatures = results.map((r) => `${r.trainStats.totalPnlPct}|${r.trainStats.totalTrades}|${r.validateStats.totalPnlPct}|${r.validateStats.totalTrades}`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe("searchCell overfit detection", () => {
  it("returns an empty array when there aren't enough candles for a train/validate/holdout split", () => {
    const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, validateFraction: 0.15, holdoutFraction: 0.15 };
    return searchCell(makeSideStrategy(), [], "1d", ENGINE, opts).then((results) => {
      expect(results).toEqual([]);
    });
  });

  it("picks the config that's profitable in training, and shows a collapsed validateRatio when it fails out-of-sample", async () => {
    // Train: strong uptrend (long wins). Validate + holdout: strong downtrend (that same long loses badly).
    const trainCandles = trendCandles(30, 100, 140);
    const oosCandles = trendCandles(20, 140, 80, 30 * 60_000);
    const candles = [...trainCandles, ...oosCandles];

    const opts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      validateFraction: 0.5 * (oosCandles.length / candles.length),
      holdoutFraction: 0.5 * (oosCandles.length / candles.length),
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
    };

    const results = await searchCell(makeSideStrategy(), candles, "1d", ENGINE, opts);

    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    expect(top.params.side).toBe(0); // long — the only config profitable on the training uptrend
    expect(top.trainScore).toBeGreaterThan(0);
    expect(top.validateScore).toBeLessThan(0); // the same long position loses on the validate downtrend
    expect(top.validateRatio).toBeLessThan(0); // collapsed relative to train — the ratio replaces the old boolean overfitFlag
    expect(top.combosEvaluated).toBeGreaterThan(0);
  });

  it("counts every backtest run via onBacktest and honors isCancelled by throwing CancelledError", async () => {
    const trainCandles = trendCandles(20, 100, 110);
    const oosCandles = trendCandles(14, 110, 105, 20 * 60_000);
    const candles = [...trainCandles, ...oosCandles];

    let backtestCount = 0;
    const countingOpts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      validateFraction: 0.5 * (oosCandles.length / candles.length),
      holdoutFraction: 0.5 * (oosCandles.length / candles.length),
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      onBacktest: () => { backtestCount++; },
    };
    await searchCell(makeSideStrategy(), candles, "1d", ENGINE, countingOpts);
    expect(backtestCount).toBeGreaterThan(0);

    const cancelledOpts: SearchOptions = { ...countingOpts, isCancelled: () => true, onBacktest: undefined };
    await expect(searchCell(makeSideStrategy(), candles, "1d", ENGINE, cancelledOpts)).rejects.toThrow(CancelledError);
  });
});

describe("searchCell walk-forward", () => {
  function walkForwardBaseOpts(): SearchOptions {
    return {
      ...DEFAULT_SEARCH_OPTIONS,
      validateFraction: 0.3,
      holdoutFraction: 0.2,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
    };
  }

  it("leaves walkForwardScores undefined when walk-forward isn't requested", async () => {
    const candles = trendCandles(80, 100, 160);
    const results = await searchCell(makeSideStrategy(), candles, "1d", ENGINE, walkForwardBaseOpts());

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.walkForwardScores).toBeUndefined();
  });

  it("scores validate via walk-forward folds when requested, with validateScore as the mean of the per-fold scores", async () => {
    const candles = trendCandles(80, 100, 160);
    const opts: SearchOptions = { ...walkForwardBaseOpts(), walkForward: { folds: 4 } };

    const results = await searchCell(makeSideStrategy(), candles, "1d", ENGINE, opts);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.walkForwardScores).toHaveLength(4);
      const mean = r.walkForwardScores!.reduce((a, b) => a + b, 0) / 4;
      expect(r.validateScore).toBeCloseTo(mean, 8);
    }
  });

  it("runs extra backtests for each walk-forward fold beyond the single-slice validate pass", async () => {
    const candles = trendCandles(80, 100, 160);

    let withoutCount = 0;
    await searchCell(makeSideStrategy(), candles, "1d", ENGINE, {
      ...walkForwardBaseOpts(),
      onBacktest: () => { withoutCount++; },
    });

    let withCount = 0;
    await searchCell(makeSideStrategy(), candles, "1d", ENGINE, {
      ...walkForwardBaseOpts(),
      walkForward: { folds: 4 },
      onBacktest: () => { withCount++; },
    });

    expect(withCount).toBeGreaterThan(withoutCount);
  });

  it("clamps walk-forward folds to the available validate candles instead of producing empty folds", async () => {
    const candles = trendCandles(30, 100, 120);
    const opts: SearchOptions = { ...walkForwardBaseOpts(), validateFraction: 0.2, walkForward: { folds: 50 } };

    const results = await searchCell(makeSideStrategy(), candles, "1d", ENGINE, opts);

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(r.walkForwardScores!.length).toBeGreaterThan(0);
  });
});

// Opens a new position every `period` bars, alternating long/short, regardless of price path —
// gives a predictable, price-path-independent trade *frequency* (unlike a real indicator
// crossover strategy) so a test can reason about exactly how many trades land in each split.
function makeFlippingStrategy(period: number): StrategyDefinition {
  return {
    id: "flipping",
    label: "Flipping",
    description: "",
    params: [],
    run: (candles) => {
      const signals: { barIndex: number; time: number; action: "long" | "short" }[] = [];
      for (let i = 0, flip = 0; i < candles.length; i += period, flip++) {
        signals.push({ barIndex: i, time: candles[i]!.openTime, action: flip % 2 === 0 ? "long" : "short" });
      }
      return signals;
    },
  };
}

describe("searchCell minTrades scaling across windows", () => {
  it("doesn't force validate/holdout/fold scores to 0 just because their window is smaller than train's (regression: a flat minTrades — sized for the ~70% train window — used to zero out every smaller window's score even when it had plenty of trades for its own size)", async () => {
    // period=5 over 2000 bars: ~280 trades in train (70%), ~60 in each of validate/holdout
    // (15%) — comfortably above the *scaled* bar (~6 for a 15% window against minTrades=30) but
    // nowhere near the unscaled 30 the old flat threshold would have demanded of a 15% window.
    const candles = oscillatingCandles(2000);
    const strategy = makeFlippingStrategy(5);

    // DEFAULT_SEARCH_OPTIONS.scoreWeights.minTrades is 30 — deliberately left un-relaxed here,
    // since the whole point is to prove holdout/validate/folds don't need train's own trade
    // count to pass their own (proportionally scaled) bar.
    const opts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      validateFraction: 0.15,
      holdoutFraction: 0.15,
      walkForward: { folds: 3 },
    };

    const results = await searchCell(strategy, candles, "1d", ENGINE, opts);

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.holdoutStats.totalTrades > 0 && r.holdoutScore !== 0)).toBe(true);
    expect(results.some((r) => r.validateStats.totalTrades > 0 && r.validateScore !== 0)).toBe(true);
    expect(results.some((r) => r.walkForwardScores!.some((s) => s !== 0))).toBe(true);
  });
});

// oscillating uptrend, not a straight line — a monotonic ramp never produces an EMA crossover.
function oscillatingCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.2 + 8 * Math.sin(i / 6);
    candles.push({ openTime: i * 60_000, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  }
  return candles;
}

describe("searchCell with a worker pool", () => {
  let pool: BacktestWorkerPool | undefined;
  afterEach(async () => {
    await pool?.destroy();
    pool = undefined;
  });

  it(
    "produces the same finalists (by outcome) whether run in-process or dispatched to the worker pool",
    async () => {
      const strategy = getStrategy("emaCross")!;
      const candles = oscillatingCandles(200);
      const baseOpts: SearchOptions = {
        ...DEFAULT_SEARCH_OPTIONS,
        validateFraction: 0.15,
        holdoutFraction: 0.15,
        scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      };

      const inProcess = await searchCell(strategy, candles, "1d", ENGINE, baseOpts);

      pool = new BacktestWorkerPool(2);
      const viaPool = await searchCell(strategy, candles, "1d", ENGINE, { ...baseOpts, pool });

      expect(viaPool.length).toBe(inProcess.length);
      expect(viaPool.map((r) => r.params)).toEqual(inProcess.map((r) => r.params));
      expect(viaPool.map((r) => r.trainStats.totalPnlPct)).toEqual(inProcess.map((r) => r.trainStats.totalPnlPct));
      expect(viaPool.map((r) => r.validateRatio)).toEqual(inProcess.map((r) => r.validateRatio));
    },
    30_000,
  );

  it(
    "surfaces a worker-side error (e.g. an unregistered strategy id) as a rejection",
    async () => {
      pool = new BacktestWorkerPool(1);
      const unregistered: StrategyDefinition = { ...makeSideStrategy(), id: "not-in-the-registry" };
      const opts: SearchOptions = {
        ...DEFAULT_SEARCH_OPTIONS,
        validateFraction: 0.15,
        holdoutFraction: 0.15,
        scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
        pool,
      };

      await expect(searchCell(unregistered, trendCandles(20, 100, 110), "1d", ENGINE, opts)).rejects.toThrow();
    },
    30_000,
  );
});
