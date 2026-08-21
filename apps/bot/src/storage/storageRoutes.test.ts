import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { storagePlugin } from "./storageRoutes.js";

// The route reads env.DATABASE_URL itself (via resolveDbFilePath) to stat the DB file, so the
// mocked DATABASE_URL has to point at the *same* physical sqlite file the test's Prisma client
// writes to — computed once via vi.hoisted() so it's available both to the env mock factory and
// to beforeAll below.
const { TEST_TOKEN, TEST_DB_PATH } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: joinPath } = require("node:path") as typeof import("node:path");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir: getTmpdir } = require("node:os") as typeof import("node:os");
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomUUID: uuid } = require("node:crypto") as typeof import("node:crypto");
  return {
    TEST_TOKEN: "test_api_token_1234567890abcdef",
    TEST_DB_PATH: joinPath(getTmpdir(), `test-storageroutes-${uuid()}.db`),
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
const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

let testDb: PrismaClient;
let app: FastifyInstance;

beforeAll(async () => {
  const setup = new BetterSqlite3(TEST_DB_PATH);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${TEST_DB_PATH}` });
  testDb = new PrismaClient({ adapter });

  // A bare Fastify instance with only storagePlugin registered — not the full buildApp() stack.
  // Full-stack construction (which also pulls in backtestPlugin's worker-pool/Bybit machinery)
  // exercises an unrelated vitest/module-loading interaction that leaves the process hanging on
  // exit after a candle/fundingRate query, confirmed via a standalone (non-vitest) repro to have
  // zero lingering handles — i.e. real app code is clean, this is a test-harness artifact. This
  // route's auth hook, schema validation, and handler logic are fully self-contained in
  // storagePlugin, so mounting it alone still exercises the real request/response cycle.
  app = Fastify({ logger: false });
  await app.register(storagePlugin, { db: testDb });
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
});

describe("bearer token auth", () => {
  it("missing token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/storage/stats" });
    expect(res.statusCode).toBe(401);
  });

  it("wrong token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/storage/stats", headers: { authorization: "Bearer nope" } });
    expect(res.statusCode).toBe(401);
  });
});

describe("GET /api/storage/stats", () => {
  it("reports real db size and row counts", async () => {
    await testDb.candle.createMany({
      data: [
        { symbol: "BTCUSDT", timeframe: "1d", openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "BTCUSDT", timeframe: "1d", openTime: DAY_MS, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });

    const res = await app.inject({ method: "GET", url: "/api/storage/stats", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dbSizeBytes).toBeGreaterThan(0);
    expect(body.volumeSizeBytes).toBe(1_073_741_824);
    expect(body.criticalThresholdPct).toBe(85);
    expect(body.candles).toEqual({ rowCount: 2, oldest: 0, newest: DAY_MS });
    expect(body.fundingRates).toEqual({ rowCount: 0, oldest: null, newest: null });
  });
});

describe("DELETE /api/storage/candles", () => {
  // Relative to "now", not the epoch — the route's cutoff is `Date.now() - olderThanDays * DAY_MS`,
  // so fixtures need to straddle *today's* cutoff to actually exercise the boundary. Using
  // epoch-anchored timestamps (e.g. 0, 10*DAY_MS) would make every row "older than 5 days ago"
  // regardless of which side of the intended boundary they're meant to represent.
  const OLD_TIME = Date.now() - 10 * DAY_MS; // older than a 5-day cutoff — should be pruned
  const RECENT_TIME = Date.now() - 1 * DAY_MS; // newer than a 5-day cutoff — should survive

  async function seed() {
    await testDb.candle.createMany({
      data: [
        { symbol: "BTCUSDT", timeframe: "1d", openTime: OLD_TIME, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "BTCUSDT", timeframe: "1d", openTime: RECENT_TIME, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "ETHUSDT", timeframe: "1d", openTime: OLD_TIME, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    await testDb.fundingRate.createMany({
      data: [{ symbol: "BTCUSDT", fundingTime: OLD_TIME, fundingRate: 0.0001 }],
    });
  }

  it("missing olderThanDays → 400", async () => {
    const res = await app.inject({ method: "DELETE", url: "/api/storage/candles", headers: AUTH });
    expect(res.statusCode).toBe(400);
  });

  it("without confirm=true, previews counts and deletes nothing", async () => {
    await seed();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/storage/candles?olderThanDays=5",
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(true);
    expect(body.candles).toBe(2); // BTC@OLD_TIME, ETH@OLD_TIME — both older than the 5-day cutoff
    expect(body.fundingRates).toBe(1);
    expect(await testDb.candle.count()).toBe(3); // nothing deleted
  });

  it("with confirm=true, actually deletes the previewed rows", async () => {
    await seed();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/storage/candles?olderThanDays=5&confirm=true",
      headers: AUTH,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.dryRun).toBe(false);
    expect(body.candles).toBe(2);
    expect(body.fundingRates).toBe(1);
    expect(await testDb.candle.count()).toBe(1); // only the recent BTC row survives
  });

  it("scopes deletion to one symbol when given", async () => {
    await seed();
    const res = await app.inject({
      method: "DELETE",
      url: "/api/storage/candles?olderThanDays=5&symbol=BTCUSDT&confirm=true",
      headers: AUTH,
    });

    expect(res.json().candles).toBe(1); // only BTC@OLD_TIME, not ETH@OLD_TIME
    const remaining = await testDb.candle.findMany();
    expect(remaining.some((c) => c.symbol === "ETHUSDT")).toBe(true); // untouched
  });
});
