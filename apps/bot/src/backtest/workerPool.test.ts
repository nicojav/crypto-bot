import { describe, it, expect, afterEach } from "vitest";
import { BacktestWorkerPool } from "./workerPool.js";
import { runOneBacktest } from "./optimizer.js";
import { getStrategy } from "./strategies/index.js";
import type { EngineConfig } from "./engine.js";
import type { Candle } from "./types.js";
import { DEFAULT_SCORE_WEIGHTS } from "./scoring.js";

// These spawn real OS worker threads (loaded through tsx/cjs in this test environment — see
// resolveWorkerEntry in workerPool.ts) — slower than a unit test, so give them room.
const WORKER_TEST_TIMEOUT = 30_000;

const engineConfig: EngineConfig = {
  initialCapital: 10_000,
  maxPositionUsd: 1_000,
  leverage: 1,
  feeBps: 5.5,
  slippageBps: 2,
  fillModel: "signalClose",
  lotSize: 0.001,
  tickSize: 0.01,
};

function makeTrendingCandles(n: number): Candle[] {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    // A slow upward drift with oscillation, enough to produce real EMA crossovers.
    price += Math.sin(i / 7) * 2 + 0.05;
    const open = price;
    const close = price + Math.sin(i / 3) * 0.5;
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    candles.push({ openTime: i * 60_000, open, high, low, close, volume: 100 });
    price = close;
  }
  return candles;
}

const strategy = getStrategy("emaCross")!;
const candles = makeTrendingCandles(400);
const params = { fastLen: 10, slowLen: 30 };

let pool: BacktestWorkerPool | undefined;
afterEach(async () => {
  await pool?.destroy();
  pool = undefined;
});

describe("BacktestWorkerPool", () => {
  it(
    "runFull matches the single-threaded runOneBacktest result",
    async () => {
      pool = new BacktestWorkerPool(2);
      const expected = runOneBacktest(strategy, candles, params, engineConfig, "1d");
      const actual = await pool.runFull(candles, strategy.id, params, engineConfig, "1d");
      expect(actual.stats).toEqual(expected.stats);
      expect(actual.trades).toEqual(expected.trades);
      expect(actual.equityCurve).toEqual(expected.equityCurve);
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    "runStats returns the same stats without curves",
    async () => {
      pool = new BacktestWorkerPool(2);
      const expected = runOneBacktest(strategy, candles, params, engineConfig, "1d");
      const actual = await pool.runStats(candles, strategy.id, params, engineConfig, "1d");
      expect(actual.stats).toEqual(expected.stats);
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    "runScored's score matches scoreResult computed locally",
    async () => {
      pool = new BacktestWorkerPool(2);
      const actual = await pool.runScored(candles, strategy.id, params, engineConfig, "1d", DEFAULT_SCORE_WEIGHTS);
      expect(typeof actual.score).toBe("number");
      expect(actual.stats.totalTrades).toBeGreaterThan(0);
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    "reuses one packed buffer across many tasks against the same candle array and runs them concurrently",
    async () => {
      pool = new BacktestWorkerPool(4);
      const paramSets = Array.from({ length: 12 }, (_, i) => ({ fastLen: 5 + i, slowLen: 30 }));
      const results = await Promise.all(paramSets.map((p) => pool!.runStats(candles, strategy.id, p, engineConfig, "1d")));
      expect(results).toHaveLength(12);
      for (const r of results) expect(r.stats).toBeDefined();
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    "propagates a worker-side error (unknown strategy) as a rejection, not a hang",
    async () => {
      pool = new BacktestWorkerPool(1);
      await expect(pool.runStats(candles, "not-a-real-strategy", params, engineConfig, "1d")).rejects.toThrow(/Unknown strategy/);
    },
    WORKER_TEST_TIMEOUT,
  );

  it(
    "rejects new work after destroy() and does not hang the process",
    async () => {
      const p = new BacktestWorkerPool(1);
      await p.destroy();
      await expect(p.runStats(candles, strategy.id, params, engineConfig, "1d")).rejects.toThrow(/closed/);
    },
    WORKER_TEST_TIMEOUT,
  );
});
