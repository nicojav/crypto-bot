import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { resolveDbFilePath, getStorageStats, countPrunableRows, pruneOldRows } from "./dbStats.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const BetterSqlite3 = require("better-sqlite3") as any;

const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((d) => d !== "migration_lock.toml")
  .sort()
  .map((d) => readFileSync(resolve(MIGRATIONS_DIR, d, "migration.sql"), "utf8"))
  .join("\n");

const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: PrismaClient;
let testDbPath: string;

beforeAll(() => {
  testDbPath = join(tmpdir(), `test-dbstats-${randomUUID()}.db`);
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
});

describe("resolveDbFilePath", () => {
  it("returns an absolute file: URL's path as-is", () => {
    expect(resolveDbFilePath("file:/data/prod.db")).toBe("/data/prod.db");
  });

  it("resolves a relative file: URL against apps/bot's own package root, not process.cwd()", () => {
    const resolved = resolveDbFilePath("file:./dev.db");
    expect(resolved.endsWith("/dev.db")).toBe(true);
    expect(resolved.startsWith("/")).toBe(true); // absolute regardless of cwd
  });
});

describe("getStorageStats", () => {
  it("reports the real DB file size and row counts/date coverage for candles and funding rates", async () => {
    await testDb.candle.createMany({
      data: [
        { symbol: "BTCUSDT", timeframe: "1d", openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "BTCUSDT", timeframe: "1d", openTime: DAY_MS, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "BTCUSDT", timeframe: "1d", openTime: 2 * DAY_MS, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    await testDb.fundingRate.createMany({
      data: [
        { symbol: "BTCUSDT", fundingTime: 0, fundingRate: 0.0001 },
        { symbol: "BTCUSDT", fundingTime: DAY_MS, fundingRate: 0.0002 },
      ],
    });

    const stats = await getStorageStats(testDb, testDbPath, 1_073_741_824, 85);

    expect(stats.dbSizeBytes).toBeGreaterThan(0); // testDbPath is a real file on disk
    expect(stats.volumeSizeBytes).toBe(1_073_741_824);
    expect(stats.percentUsed).toBeCloseTo((stats.dbSizeBytes / 1_073_741_824) * 100, 6);
    expect(stats.criticalThresholdPct).toBe(85);
    expect(stats.candles).toEqual({ rowCount: 3, oldest: 0, newest: 2 * DAY_MS });
    expect(stats.fundingRates).toEqual({ rowCount: 2, oldest: 0, newest: DAY_MS });
  });

  it("reports null oldest/newest when a table is empty", async () => {
    const stats = await getStorageStats(testDb, testDbPath, 1_073_741_824, 85);
    expect(stats.candles).toEqual({ rowCount: 0, oldest: null, newest: null });
    expect(stats.fundingRates).toEqual({ rowCount: 0, oldest: null, newest: null });
  });
});

describe("countPrunableRows / pruneOldRows", () => {
  async function seed() {
    await testDb.candle.createMany({
      data: [
        { symbol: "BTCUSDT", timeframe: "1d", openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "BTCUSDT", timeframe: "1d", openTime: 5 * DAY_MS, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "ETHUSDT", timeframe: "1d", openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    await testDb.fundingRate.createMany({
      data: [
        { symbol: "BTCUSDT", fundingTime: 0, fundingRate: 0.0001 },
        { symbol: "BTCUSDT", fundingTime: 5 * DAY_MS, fundingRate: 0.0002 },
      ],
    });
  }

  it("counts (without deleting) rows older than the cutoff, unscoped", async () => {
    await seed();
    const counts = await countPrunableRows(testDb, 1 * DAY_MS);
    expect(counts).toEqual({ candles: 2, fundingRates: 1 }); // BTC@0, ETH@0 candles; BTC@0 funding
    expect(await testDb.candle.count()).toBe(3); // nothing actually deleted
  });

  it("deletes only rows older than the cutoff", async () => {
    await seed();
    const deleted = await pruneOldRows(testDb, 1 * DAY_MS);
    expect(deleted).toEqual({ candles: 2, fundingRates: 1 });

    const remainingCandles = await testDb.candle.findMany({ orderBy: { openTime: "asc" } });
    expect(remainingCandles.map((c) => `${c.symbol}:${c.openTime}`)).toEqual([`BTCUSDT:${5 * DAY_MS}`]);
    const remainingFunding = await testDb.fundingRate.findMany();
    expect(remainingFunding.map((f) => f.fundingTime)).toEqual([5 * DAY_MS]);
  });

  it("scopes deletion to one symbol when given", async () => {
    await seed();
    const deleted = await pruneOldRows(testDb, 1 * DAY_MS, { symbol: "BTCUSDT" });
    expect(deleted).toEqual({ candles: 1, fundingRates: 1 }); // only BTC@0 candle, not ETH@0

    const remainingCandles = await testDb.candle.findMany();
    expect(remainingCandles.some((c) => c.symbol === "ETHUSDT")).toBe(true); // untouched
  });

  it("scopes candle deletion to one timeframe when given (funding has no timeframe dimension)", async () => {
    await testDb.candle.createMany({
      data: [
        { symbol: "BTCUSDT", timeframe: "1d", openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { symbol: "BTCUSDT", timeframe: "5m", openTime: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ],
    });
    const deleted = await pruneOldRows(testDb, 1 * DAY_MS, { symbol: "BTCUSDT", timeframe: "1d" });
    expect(deleted.candles).toBe(1);
    const remaining = await testDb.candle.findMany();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.timeframe).toBe("5m");
  });
});
