import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { backtestPlugin } from "./backtestRoutes.js";
import type { CandleSource } from "./candleStore.js";
import type { InstrumentSource } from "./optimizationRunner.js";
import type { FundingSource } from "./fundingStore.js";
import type { Kline } from "../exchange/bybit.js";

const { TEST_TOKEN, TEST_DB_PATH } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: getTmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID: uuid } = require("node:crypto") as typeof import("node:crypto");
  return {
    TEST_TOKEN: "test_api_token_1234567890abcdef",
    TEST_DB_PATH: joinPath(getTmpdir(), `test-backtestroutes-${uuid()}.db`),
  };
});

vi.mock("../env.js", () => ({
  env: {
    WEBHOOK_SECRET: "test_webhook_secret_xyz",
    API_TOKEN: TEST_TOKEN,
    DASHBOARD_ORIGIN: "http://localhost:5173",
    DATABASE_URL: `file:${TEST_DB_PATH}`,
    PORT: 3000,
    LOG_LEVEL: "error",
    BYBIT_API_KEY: "test",
    BYBIT_API_SECRET: "test",
    BYBIT_TESTNET: true,
    DB_VOLUME_SIZE_BYTES: 1_073_741_824,
    DB_CRITICAL_THRESHOLD_PCT: 85,
  },
}));

const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((d) => d !== "migration_lock.toml")
  .sort()
  .map((d) => readFileSync(resolve(MIGRATIONS_DIR, d, "migration.sql"), "utf8"))
  .join("\n");

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const BetterSqlite3 = require("better-sqlite3") as any;

const DAY_MS = 24 * 60 * 60 * 1000;
const CANDLE_COUNT = 200;
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

function makeCandles(n: number): Kline[] {
  const out: Kline[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + i * 0.2 + 8 * Math.sin(i / 6); // gentle uptrend + oscillation, drives EMA crossovers
    out.push({ openTime: i * DAY_MS, open: close, high: close + 1, low: close - 1, close, volume: 1 });
  }
  return out;
}

function makeFakeExchange(klines: Kline[] = makeCandles(CANDLE_COUNT)): CandleSource & InstrumentSource & FundingSource {
  return {
    getKline: async () => klines,
    getInstrumentInfo: async () => ({ lotSize: 0.001, tickSize: 0.01 }),
    getFundingHistory: async () => [],
  };
}

const FROM = new Date(0).toISOString();
const TO = new Date((CANDLE_COUNT - 1) * DAY_MS).toISOString();

let testDb: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
  const setup = new BetterSqlite3(TEST_DB_PATH);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${TEST_DB_PATH}` });
  testDb = new PrismaClient({ adapter });

  // A bare Fastify instance with only backtestPlugin registered — see vitest.config.ts's
  // pool: "forks" comment for why this used to matter; kept minimal regardless since this file
  // only needs backtestPlugin's own routes.
  app = Fastify({ logger: false });
  await app.register(backtestPlugin, { db: testDb, bybit: makeFakeExchange() as never });
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.$disconnect();
  try { unlinkSync(TEST_DB_PATH); } catch { /* ignore */ }
});

beforeEach(async () => {
  await testDb.candle.deleteMany({});
  await testDb.fundingRate.deleteMany({});
  await testDb.optimizationRun.deleteMany({});
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe("bearer token auth", () => {
  it("missing token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backtest/strategies" });
    expect(res.statusCode).toBe(401);
  });

  it("wrong token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backtest/strategies", headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });

  it("correct token → not 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backtest/strategies", headers: AUTH });
    expect(res.statusCode).not.toBe(401);
  });
});

// ── GET /api/backtest/strategies ────────────────────────────────────────────

describe("GET /api/backtest/strategies", () => {
  it("returns the registered strategy list with param schemas", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backtest/strategies", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBeGreaterThan(0);
    const emaCross = body.find((s: { id: string }) => s.id === "emaCross");
    expect(emaCross).toBeDefined();
    expect(Array.isArray(emaCross.params)).toBe(true);
  });
});

// ── POST /api/backtest/strategies/:id/pine ──────────────────────────────────

describe("POST /api/backtest/strategies/:id/pine", () => {
  it("unknown strategy → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/strategies/not-a-real-strategy/pine", headers: AUTH, payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("strategy without toPine support → 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backtest/strategies", headers: AUTH });
    const noPine = res.json().find((s: { supportsPine: boolean }) => !s.supportsPine);
    if (!noPine) return; // every registered strategy supports Pine export — nothing to assert
    const pineRes = await app.inject({ method: "POST", url: `/api/backtest/strategies/${noPine.id}/pine`, headers: AUTH, payload: {} });
    expect(pineRes.statusCode).toBe(400);
  });

  it("known strategy with default params → 200 with a pine string", async () => {
    const res = await app.inject({ method: "POST", url: "/api/backtest/strategies/customMaCross/pine", headers: AUTH, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().pine).toBe("string");
  });
});

// ── POST /api/backtest/run ──────────────────────────────────────────────────

describe("POST /api/backtest/run", () => {
  it("503 when no bybit client is configured", async () => {
    const bareApp = Fastify({ logger: false });
    await bareApp.register(backtestPlugin, { db: testDb });
    await bareApp.ready();
    const res = await bareApp.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO },
    });
    expect(res.statusCode).toBe(503);
    await bareApp.close();
  });

  it("unknown strategy → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: { strategyId: "nope", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO },
    });
    expect(res.statusCode).toBe(400);
  });

  it("invalid date range (from >= to) → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: TO, to: FROM },
    });
    expect(res.statusCode).toBe(400);
  });

  it("missing required field → 400 (schema validation)", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: { strategyId: "emaCross", timeframe: "1d", from: FROM, to: TO }, // symbol omitted
    });
    expect(res.statusCode).toBe(400);
  });

  it("runs successfully and returns stats/trades/curves/markers", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toBeDefined();
    expect(Array.isArray(body.trades)).toBe(true);
    expect(Array.isArray(body.equityCurve)).toBe(true);
    expect(Array.isArray(body.buyHoldCurve)).toBe(true);
    expect(Array.isArray(body.markers)).toBe(true);
    expect(body.fillModelComparison).toBeUndefined();
    expect(body.sensitivityComparison).toBeUndefined();
  }, 15_000);

  it("downsamples the equity/buy-hold curves to at most 1500 points on a large candle window", async () => {
    // MAX_CANDLES_PER_REQUEST doesn't apply to /run (only GET /candles) — a big enough window
    // produces a curve longer than MAX_CURVE_POINTS (1500), which downsample() must shrink.
    const bigCount = 2_000;
    const bigApp = Fastify({ logger: false });
    await bigApp.register(backtestPlugin, { db: testDb, bybit: makeFakeExchange(makeCandles(bigCount)) as never });
    await bigApp.ready();

    const res = await bigApp.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: {
        strategyId: "emaCross", symbol: "ETHUSDT", timeframe: "1d",
        from: new Date(0).toISOString(), to: new Date((bigCount - 1) * DAY_MS).toISOString(),
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.equityCurve.length).toBeLessThanOrEqual(1_500);
    expect(body.buyHoldCurve.length).toBeLessThanOrEqual(1_500);
    await bigApp.close();
  }, 15_000);

  it("compareFillModel and sensitivityCheck add their comparison fields", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: {
        strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO,
        compareFillModel: true, sensitivityCheck: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.fillModelComparison.fillModel).toBe("nextOpen");
    expect(body.fillModelComparison.stats).toBeDefined();
    expect(body.sensitivityComparison.slippageBps).toBe(4); // default 2 * 2
    expect(body.sensitivityComparison.feeBps).toBe(11); // default 5.5 * 2
  }, 15_000);

  it("no candle data available → 400", async () => {
    const emptyApp = Fastify({ logger: false });
    await emptyApp.register(backtestPlugin, { db: testDb, bybit: makeFakeExchange([]) as never });
    await emptyApp.ready();
    const res = await emptyApp.inject({
      method: "POST", url: "/api/backtest/run", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "NODATA", timeframe: "1d", from: FROM, to: TO },
    });
    expect(res.statusCode).toBe(400);
    await emptyApp.close();
  });
});

// ── POST /api/backtest/optimize ─────────────────────────────────────────────

describe("POST /api/backtest/optimize", () => {
  const sweep = [{ param: "fastLen", min: 5, max: 15, step: 5 }]; // 3 combos

  it("503 when no bybit client is configured", async () => {
    const bareApp = Fastify({ logger: false });
    await bareApp.register(backtestPlugin, { db: testDb });
    await bareApp.ready();
    const res = await bareApp.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO, sweep },
    });
    expect(res.statusCode).toBe(503);
    await bareApp.close();
  });

  it("unknown strategy → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "nope", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO, sweep },
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown sweep param for the strategy → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO, sweep: [{ param: "notAParam", min: 1, max: 2, step: 1 }] },
    });
    expect(res.statusCode).toBe(400);
  });

  it("sweep exceeding MAX_OPTIMIZE_COMBINATIONS (500) → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: {
        strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO,
        sweep: [{ param: "fastLen", min: 2, max: 60, step: 1 }, { param: "slowLen", min: 5, max: 15, step: 1 }], // 59 * 11 = 649
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("invalid date range → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: TO, to: FROM, sweep },
    });
    expect(res.statusCode).toBe(400);
  });

  it("no candle data available → 400", async () => {
    const emptyApp = Fastify({ logger: false });
    await emptyApp.register(backtestPlugin, { db: testDb, bybit: makeFakeExchange([]) as never });
    await emptyApp.ready();
    const res = await emptyApp.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "NODATA", timeframe: "1d", from: FROM, to: TO, sweep },
    });
    expect(res.statusCode).toBe(400);
    await emptyApp.close();
  });

  it("runs the sweep, filters below minTrades, sorts by PnL%, and reports counts", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO, sweep, minTrades: 0 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.totalCombinations).toBe(3);
    expect(body.evaluatedCombinations).toBe(3);
    expect(body.filteredOutCount + body.results.length).toBe(3);
    for (let i = 1; i < body.results.length; i++) {
      expect(body.results[i - 1].stats.totalPnlPct).toBeGreaterThanOrEqual(body.results[i].stats.totalPnlPct);
    }
  }, 15_000);

  it("a high minTrades filters out every result", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize", headers: AUTH,
      payload: { strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", from: FROM, to: TO, sweep, minTrades: 100_000 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.results).toHaveLength(0);
    expect(body.filteredOutCount).toBe(3);
  }, 15_000);
});

// ── POST /api/backtest/optimize/auto ────────────────────────────────────────

describe("POST /api/backtest/optimize/auto", () => {
  it("503 when no bybit client is configured", async () => {
    const bareApp = Fastify({ logger: false });
    await bareApp.register(backtestPlugin, { db: testDb });
    await bareApp.ready();
    const res = await bareApp.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["BTCUSDT"], timeframes: ["1d"], from: FROM, to: TO },
    });
    expect(res.statusCode).toBe(503);
    await bareApp.close();
  });

  it("unknown strategy id → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["BTCUSDT"], timeframes: ["1d"], strategyIds: ["nope"], from: FROM, to: TO },
    });
    expect(res.statusCode).toBe(400);
  });

  it("cell count exceeding MAX_AUTO_OPTIMIZE_CELLS (100) → 400", async () => {
    const manySymbols = Array.from({ length: 11 }, (_, i) => `SYM${i}USDT`);
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: manySymbols, timeframes: ["5m", "15m", "4h", "1d", "1w"], from: FROM, to: TO }, // every strategy id (>=5) x 11 x 5 » 100
    });
    expect(res.statusCode).toBe(400);
  });

  it("invalid date range → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["BTCUSDT"], timeframes: ["1d"], strategyIds: ["emaCross"], from: TO, to: FROM },
    });
    expect(res.statusCode).toBe(400);
  });

  it("validateFraction + holdoutFraction >= 1 → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: {
        symbols: ["BTCUSDT"], timeframes: ["1d"], strategyIds: ["emaCross"], from: FROM, to: TO,
        validateFraction: 0.6, holdoutFraction: 0.5,
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it("409 when a run is already active", async () => {
    const first = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["BTCUSDT"], timeframes: ["1d"], strategyIds: ["emaCross"], from: FROM, to: TO, minTrades: 1 },
    });
    expect(first.statusCode).toBe(200);
    const { runId } = first.json();

    const second = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["ETHUSDT"], timeframes: ["1d"], strategyIds: ["emaCross"], from: FROM, to: TO, minTrades: 1 },
    });
    expect(second.statusCode).toBe(409);

    // Let the first run finish before the next test — this process-wide single-job lock
    // otherwise leaks into whichever test runs next.
    await vi.waitUntil(async () => {
      const r = await app.inject({ method: "GET", url: `/api/backtest/optimize/auto/${runId}`, headers: AUTH });
      return r.json().status !== "running";
    }, { timeout: 15_000, interval: 100 });
  }, 20_000);

  it("creates a run and returns a pollable runId that eventually completes", async () => {
    const start = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["BTCUSDT"], timeframes: ["1d"], strategyIds: ["emaCross"], from: FROM, to: TO, minTrades: 1 },
    });
    expect(start.statusCode).toBe(200);
    const { runId } = start.json();
    expect(typeof runId).toBe("number");

    await vi.waitUntil(async () => {
      const r = await app.inject({ method: "GET", url: `/api/backtest/optimize/auto/${runId}`, headers: AUTH });
      return r.json().status !== "running";
    }, { timeout: 15_000, interval: 100 });

    const final = await app.inject({ method: "GET", url: `/api/backtest/optimize/auto/${runId}`, headers: AUTH });
    expect(final.json().status).toBe("done");
    expect(final.json().cellsDone).toBe(1);
  }, 20_000);
});

// ── GET /api/backtest/optimize/auto/:runId ──────────────────────────────────

describe("GET /api/backtest/optimize/auto/:runId", () => {
  it("unknown run id → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/backtest/optimize/auto/999999", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("returns the persisted run with parsed results", async () => {
    // Fastify serializes the response against cellResultSchema, so a seeded row's results must
    // actually satisfy it (every required stats/score field) — an arbitrary shape would 500 on
    // serialization rather than round-trip.
    const stats = {
      totalPnlUsd: 0, totalPnlPct: 0, maxDrawdownUsd: 0, maxDrawdownPct: 0, totalTrades: 1,
      winners: 1, losers: 0, breakevens: 0, winRatePct: 100, profitFactor: null, avgPnlUsd: 0,
      avgPnlPct: 0, avgBarsHeld: 1, largestProfitUsd: 0, largestLossUsd: 0, avgProfitPct: 0,
      avgLossPct: 0, returnsHistogram: [], sharpeRatio: 0, sortinoRatio: 0, calmarRatio: 0,
      expectancy: null, exposurePct: 0, maxConsecutiveLosses: 0, exitReasonBreakdown: [], monthlyReturns: [],
    };
    const cellResult = {
      strategyId: "emaCross", symbol: "BTCUSDT", timeframe: "1d", params: { fastLen: 20, slowLen: 50 },
      trainStats: stats, validateStats: stats, holdoutStats: stats,
      trainScore: 1, validateScore: 1, holdoutScore: 1, validateRatio: 1, holdoutRatio: 1, combosEvaluated: 1,
    };
    const run = await testDb.optimizationRun.create({
      data: { status: "done", configJson: "{}", cellsTotal: 1, cellsDone: 1, resultsJson: JSON.stringify([cellResult]) },
    });
    const res = await app.inject({ method: "GET", url: `/api/backtest/optimize/auto/${run.id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(run.id);
    expect(body.status).toBe("done");
    expect(body.results).toHaveLength(1);
    expect(body.results[0].strategyId).toBe("emaCross");
  });
});

// ── GET /api/backtest/optimize/auto (history) ───────────────────────────────

describe("GET /api/backtest/optimize/auto", () => {
  it("returns recent runs ordered newest-first, capped at 20", async () => {
    for (let i = 0; i < 3; i++) {
      await testDb.optimizationRun.create({ data: { status: "done", configJson: "{}", cellsTotal: 1, cellsDone: 1 } });
    }
    const res = await app.inject({ method: "GET", url: "/api/backtest/optimize/auto", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.length).toBe(3);
    for (let i = 1; i < body.length; i++) {
      expect(new Date(body[i - 1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(body[i].createdAt).getTime());
    }
  });
});

// ── POST /api/backtest/optimize/auto/:runId/cancel ──────────────────────────

describe("POST /api/backtest/optimize/auto/:runId/cancel", () => {
  it("unknown run id → 404", async () => {
    const res = await app.inject({ method: "POST", url: "/api/backtest/optimize/auto/999999/cancel", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("self-heals an orphaned running row (no live process owns it) → cancelled", async () => {
    const run = await testDb.optimizationRun.create({ data: { status: "running", configJson: "{}", cellsTotal: 1 } });
    const res = await app.inject({ method: "POST", url: `/api/backtest/optimize/auto/${run.id}/cancel`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().cancelled).toBe(true);

    const updated = await testDb.optimizationRun.findUnique({ where: { id: run.id } });
    expect(updated?.status).toBe("cancelled");
  });

  it("a run that's already finished (not running) → 404", async () => {
    const run = await testDb.optimizationRun.create({ data: { status: "done", configJson: "{}", cellsTotal: 1 } });
    const res = await app.inject({ method: "POST", url: `/api/backtest/optimize/auto/${run.id}/cancel`, headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

// ── DELETE /api/backtest/optimize/auto/:runId ───────────────────────────────

describe("DELETE /api/backtest/optimize/auto/:runId", () => {
  it("unknown run id → 404", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/backtest/optimize/auto/999999", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a finished run", async () => {
    const run = await testDb.optimizationRun.create({ data: { status: "done", configJson: "{}", cellsTotal: 1 } });
    const res = await app.inject({ method: "DELETE", url: `/api/backtest/optimize/auto/${run.id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json().deleted).toBe(true);
    expect(await testDb.optimizationRun.findUnique({ where: { id: run.id } })).toBeNull();
  });

  it("409 when the run is still active", async () => {
    const start = await app.inject({
      method: "POST", url: "/api/backtest/optimize/auto", headers: AUTH,
      payload: { symbols: ["BTCUSDT"], timeframes: ["1d"], strategyIds: ["emaCross"], from: FROM, to: TO, minTrades: 1 },
    });
    const { runId } = start.json();

    const res = await app.inject({ method: "DELETE", url: `/api/backtest/optimize/auto/${runId}`, headers: AUTH });
    expect(res.statusCode).toBe(409);

    // Drain the run so it doesn't leak into a later test.
    await vi.waitUntil(async () => {
      const r = await app.inject({ method: "GET", url: `/api/backtest/optimize/auto/${runId}`, headers: AUTH });
      return r.json().status !== "running";
    }, { timeout: 15_000, interval: 100 });
  }, 20_000);
});

// ── GET /api/backtest/candles ────────────────────────────────────────────────

describe("GET /api/backtest/candles", () => {
  it("503 when no bybit client is configured", async () => {
    const bareApp = Fastify({ logger: false });
    await bareApp.register(backtestPlugin, { db: testDb });
    await bareApp.ready();
    const res = await bareApp.inject({
      method: "GET", url: `/api/backtest/candles?symbol=BTCUSDT&timeframe=1d&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(503);
    await bareApp.close();
  });

  it("invalid date range → 400", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/backtest/candles?symbol=BTCUSDT&timeframe=1d&from=${encodeURIComponent(TO)}&to=${encodeURIComponent(FROM)}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns candles untruncated when under the 5000 cap", async () => {
    const res = await app.inject({
      method: "GET", url: `/api/backtest/candles?symbol=BTCUSDT&timeframe=1d&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(false);
    expect(body.totalAvailable).toBe(CANDLE_COUNT);
    expect(body.candles).toHaveLength(CANDLE_COUNT);
  });

  it("truncates to the most recent 5000 candles when the window is larger, but reports the true total", async () => {
    const bigCount = 5_050;
    const bigApp = Fastify({ logger: false });
    await bigApp.register(backtestPlugin, { db: testDb, bybit: makeFakeExchange(makeCandles(bigCount)) as never });
    await bigApp.ready();

    const res = await bigApp.inject({
      method: "GET",
      url: `/api/backtest/candles?symbol=TRUNCUSDT&timeframe=1d&from=${encodeURIComponent(new Date(0).toISOString())}&to=${encodeURIComponent(new Date((bigCount - 1) * DAY_MS).toISOString())}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.truncated).toBe(true);
    expect(body.totalAvailable).toBe(bigCount);
    expect(body.candles).toHaveLength(5_000);
    // The windowed slice is the most *recent* candles — the last one must match the source's last bar.
    expect(body.candles[body.candles.length - 1].openTime).toBe((bigCount - 1) * DAY_MS);
    await bigApp.close();
  }, 15_000);
});
