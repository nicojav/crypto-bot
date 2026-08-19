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

describe("buildCoarseGrid", () => {
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
      oosFraction: 0.3,
      minTrades: 1,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      onBacktest: () => { backtestCount++; },
    };

    await searchCell(manyNumericParamsStrategy, candles, "1d", ENGINE, opts);

    // Coarse (<=200) + refine (5 neighborhoods, each capped at 200) + validation (<=5 finalists
    // x2) stays in the low thousands — nowhere near the ~78,000-per-neighborhood the old
    // uncapped Cartesian product would have produced for this param shape.
    expect(backtestCount).toBeLessThan(2_000);
  });

  it("collapses outcome-identical param combos into a single finalist instead of filling keepTop with twins (regression: dedup used to be by literal param equality, not outcome)", async () => {
    // Uptrend throughout, IS and OOS both — every "junk" value ties for the same "side=0"
    // (long) outcome, so without outcome-dedup, several of the 5 finalist slots would be
    // consumed by side=0 entries that only differ by an unused param.
    const candles = trendCandles(45, 100, 140);
    const opts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      oosFraction: 0.3,
      minTrades: 1,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      keepTop: 5,
    };

    const results = await searchCell(makeSideStrategyWithIgnoredParam(), candles, "1d", ENGINE, opts);

    const signatures = results.map((r) => `${r.isStats.totalPnlPct}|${r.isStats.totalTrades}|${r.oosStats.totalPnlPct}|${r.oosStats.totalTrades}`);
    expect(new Set(signatures).size).toBe(signatures.length);
  });
});

describe("searchCell overfit detection", () => {
  it("returns an empty array when there aren't enough candles for both an IS and OOS split", () => {
    const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, oosFraction: 0.3 };
    return searchCell(makeSideStrategy(), [], "1d", ENGINE, opts).then((results) => {
      expect(results).toEqual([]);
    });
  });

  it("picks the config that's profitable in-sample, and flags it as overfit when it fails out-of-sample", async () => {
    // IS: strong uptrend (long wins). OOS: strong downtrend (that same long loses badly).
    const isCandles = trendCandles(30, 100, 140);
    const oosCandles = trendCandles(15, 140, 90, 30 * 60_000);
    const candles = [...isCandles, ...oosCandles];

    const opts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      oosFraction: oosCandles.length / candles.length,
      minTrades: 1,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
    };

    const results = await searchCell(makeSideStrategy(), candles, "1d", ENGINE, opts);

    expect(results.length).toBeGreaterThan(0);
    const top = results[0]!;
    expect(top.params.side).toBe(0); // long — the only config profitable on the IS uptrend
    expect(top.isScore).toBeGreaterThan(0);
    expect(top.oosScore).toBeLessThan(0); // the same long position loses on the OOS downtrend
    expect(top.overfitFlag).toBe(true);
  });

  it("counts every backtest run via onBacktest and honors isCancelled by throwing CancelledError", async () => {
    const isCandles = trendCandles(20, 100, 110);
    const oosCandles = trendCandles(10, 110, 105, 20 * 60_000);
    const candles = [...isCandles, ...oosCandles];

    let backtestCount = 0;
    const countingOpts: SearchOptions = {
      ...DEFAULT_SEARCH_OPTIONS,
      oosFraction: oosCandles.length / candles.length,
      minTrades: 1,
      scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      onBacktest: () => { backtestCount++; },
    };
    await searchCell(makeSideStrategy(), candles, "1d", ENGINE, countingOpts);
    expect(backtestCount).toBeGreaterThan(0);

    const cancelledOpts: SearchOptions = { ...countingOpts, isCancelled: () => true, onBacktest: undefined };
    await expect(searchCell(makeSideStrategy(), candles, "1d", ENGINE, cancelledOpts)).rejects.toThrow(CancelledError);
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
        oosFraction: 0.3,
        minTrades: 1,
        scoreWeights: { ...DEFAULT_SEARCH_OPTIONS.scoreWeights, minTrades: 1 },
      };

      const inProcess = await searchCell(strategy, candles, "1d", ENGINE, baseOpts);

      pool = new BacktestWorkerPool(2);
      const viaPool = await searchCell(strategy, candles, "1d", ENGINE, { ...baseOpts, pool });

      expect(viaPool.length).toBe(inProcess.length);
      expect(viaPool.map((r) => r.params)).toEqual(inProcess.map((r) => r.params));
      expect(viaPool.map((r) => r.isStats.totalPnlPct)).toEqual(inProcess.map((r) => r.isStats.totalPnlPct));
      expect(viaPool.map((r) => r.overfitFlag)).toEqual(inProcess.map((r) => r.overfitFlag));
    },
    30_000,
  );

  it(
    "surfaces a worker-side error (e.g. an unregistered strategy id) as a rejection",
    async () => {
      pool = new BacktestWorkerPool(1);
      const unregistered: StrategyDefinition = { ...makeSideStrategy(), id: "not-in-the-registry" };
      const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, oosFraction: 0.3, minTrades: 1, pool };

      await expect(searchCell(unregistered, trendCandles(20, 100, 110), "1d", ENGINE, opts)).rejects.toThrow();
    },
    30_000,
  );
});
