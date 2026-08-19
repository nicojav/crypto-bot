import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { runAutoOptimization, cancelRun, isOptimizationRunning, healOrphanedRuns, type AutoOptimizeConfig, type InstrumentSource } from "./optimizationRunner.js";
import { DEFAULT_SCORE_WEIGHTS } from "./scoring.js";
import type { CandleSource } from "./candleStore.js";
import type { FundingSource } from "./fundingStore.js";
import type { Kline } from "../exchange/bybit.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const BetterSqlite3 = require("better-sqlite3") as any;

const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((d) => d !== "migration_lock.toml")
  .sort()
  .map((d) => readFileSync(resolve(MIGRATIONS_DIR, d, "migration.sql"), "utf8"))
  .join("\n");

const DAY_MS = 24 * 60 * 60 * 1000;
const CANDLE_COUNT = 200;

function makeCandles(n: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.2 + 8 * Math.sin(i / 6); // gentle uptrend + oscillation, drives EMA crossovers
    out.push({ openTime: i * DAY_MS, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  }
  return out;
}

function makeFakeExchange(klines: Kline[]): CandleSource & InstrumentSource & FundingSource {
  return {
    getKline: async () => klines,
    getInstrumentInfo: async () => ({ lotSize: 0.001, tickSize: 0.01 }),
    getFundingHistory: async () => [],
  };
}

function baseConfig(overrides: Partial<AutoOptimizeConfig> = {}): AutoOptimizeConfig {
  return {
    symbols: ["BTCUSDT"],
    timeframes: ["1d"],
    strategyIds: ["emaCross"],
    from: new Date(0).toISOString(),
    to: new Date((CANDLE_COUNT - 1) * DAY_MS).toISOString(),
    oosFraction: 0.3,
    minTrades: 1,
    scoreWeights: { ...DEFAULT_SCORE_WEIGHTS, minTrades: 1 },
    engine: { initialCapital: 1_000, maxPositionUsd: 100, leverage: 1, feeBps: 0, slippageBps: 0, fillModel: "signalClose" },
    ...overrides,
  };
}

let testDb: PrismaClient;
let testDbPath: string;

beforeAll(() => {
  testDbPath = join(tmpdir(), `test-optimizationrunner-${randomUUID()}.db`);
  const setup = new BetterSqlite3(testDbPath);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${testDbPath}` });
  testDb = new PrismaClient({ adapter });
});

afterAll(async () => {
  await testDb.$disconnect();
  unlinkSync(testDbPath);
});

beforeEach(async () => {
  await testDb.candle.deleteMany({});
  await testDb.fundingRate.deleteMany({});
  await testDb.optimizationRun.deleteMany({});
});

describe("runAutoOptimization", () => {
  it("runs a single-cell matrix end to end and marks the run done", async () => {
    const exchange = makeFakeExchange(makeCandles(CANDLE_COUNT));
    const run = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });

    await runAutoOptimization(testDb, exchange, run.id, baseConfig());

    const updated = await testDb.optimizationRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("done");
    expect(updated?.cellsDone).toBe(1);
    expect(updated?.backtestsRun).toBeGreaterThan(0);
    expect(isOptimizationRunning()).toBe(false);
  });

  it("fetches funding rates for each cell's symbol and forwards them into the engine", async () => {
    const fundingCalls: Array<[string, number, number]> = [];
    const exchange: CandleSource & InstrumentSource & FundingSource = {
      getKline: async () => makeCandles(CANDLE_COUNT),
      getInstrumentInfo: async () => ({ lotSize: 0.001, tickSize: 0.01 }),
      getFundingHistory: async (symbol, startMs, endMs) => {
        fundingCalls.push([symbol, startMs, endMs]);
        return [{ fundingTime: startMs, fundingRate: 0.0001 }];
      },
    };
    const run = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });

    await runAutoOptimization(testDb, exchange, run.id, baseConfig());

    expect(fundingCalls).toHaveLength(1);
    expect(fundingCalls[0]![0]).toBe("BTCUSDT");

    const cached = await testDb.fundingRate.findMany({ where: { symbol: "BTCUSDT" } });
    expect(cached).toHaveLength(1);
    expect(cached[0]!.fundingRate).toBe(0.0001);
  });

  it("rejects a second run while one is active — the single-job lock protecting the live-trading process", async () => {
    const exchange = makeFakeExchange(makeCandles(CANDLE_COUNT));
    const run1 = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });
    const run2 = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });

    const p1 = runAutoOptimization(testDb, exchange, run1.id, baseConfig());
    await expect(runAutoOptimization(testDb, exchange, run2.id, baseConfig())).rejects.toThrow(/already active/);
    await p1;

    expect(isOptimizationRunning()).toBe(false);
  });

  it("stops early and marks the run cancelled when cancelRun is called mid-run", async () => {
    const exchange = makeFakeExchange(makeCandles(CANDLE_COUNT));
    const run = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });

    const p = runAutoOptimization(testDb, exchange, run.id, baseConfig());
    expect(cancelRun(run.id)).toBe(true);
    await p; // cancellation resolves the run (not a rejection) — the row's status is the signal

    const updated = await testDb.optimizationRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("cancelled");
    expect(isOptimizationRunning()).toBe(false);
  });

  it("cancelRun is a no-op (returns false) when no run is active or the id doesn't match", () => {
    expect(cancelRun(999_999)).toBe(false);
  });

  it("skips an unknown strategy id in the matrix instead of erroring the whole run", async () => {
    const exchange = makeFakeExchange(makeCandles(CANDLE_COUNT));
    const run = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });

    await runAutoOptimization(testDb, exchange, run.id, baseConfig({ strategyIds: ["doesNotExist"] }));

    const updated = await testDb.optimizationRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("done");
    expect(updated?.cellsDone).toBe(1);
    expect(updated?.backtestsRun).toBe(0);
    expect(JSON.parse(updated!.resultsJson)).toEqual([]);
  });

  it("iterates the full symbol x timeframe x strategy matrix", async () => {
    const exchange = makeFakeExchange(makeCandles(CANDLE_COUNT));
    const run = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });

    await runAutoOptimization(testDb, exchange, run.id, baseConfig({
      symbols: ["BTCUSDT", "ETHUSDT"],
      timeframes: ["1d", "1w"],
      strategyIds: ["emaCross"],
    }));

    const updated = await testDb.optimizationRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("done");
    expect(updated?.cellsTotal).toBe(4); // 2 symbols x 2 timeframes x 1 strategy
    expect(updated?.cellsDone).toBe(4);
  });
});

describe("healOrphanedRuns", () => {
  // Regression: a run's process can die mid-flight (crash, deploy, a dev-mode file-watcher
  // restart) without ever reaching runAutoOptimization's cleanup code. The row is left at
  // status "running" forever — no live process's activeRunId matches it, so cancelRun can
  // never reach it either. healOrphanedRuns is the startup sweep that un-sticks those rows.
  it("marks every stuck 'running' row as an error, and leaves finished runs untouched", async () => {
    const stuck1 = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 5, cellsDone: 2 } });
    const stuck2 = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1, cellsDone: 0 } });
    const finished = await testDb.optimizationRun.create({ data: { status: "done", configJson: "{}", cellsTotal: 1, cellsDone: 1 } });
    const cancelled = await testDb.optimizationRun.create({ data: { status: "cancelled", configJson: "{}", cellsTotal: 1, cellsDone: 0 } });

    const healedCount = await healOrphanedRuns(testDb);
    expect(healedCount).toBe(2);

    const [r1, r2, r3, r4] = await Promise.all(
      [stuck1, stuck2, finished, cancelled].map((r) => testDb.optimizationRun.findUnique({ where: { id: r.id } })),
    );
    expect(r1?.status).toBe("error");
    expect(r1?.error).toBeTruthy();
    expect(r2?.status).toBe("error");
    expect(r3?.status).toBe("done"); // untouched
    expect(r4?.status).toBe("cancelled"); // untouched
  });

  it("is a no-op when nothing is stuck", async () => {
    await testDb.optimizationRun.create({ data: { status: "done", configJson: "{}", cellsTotal: 1, cellsDone: 1 } });
    expect(await healOrphanedRuns(testDb)).toBe(0);
  });
});
