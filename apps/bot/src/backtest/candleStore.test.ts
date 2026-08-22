import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { ensureCandles, type CandleSource } from "./candleStore.js";
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

function kline(openTime: number): Kline {
  return { openTime, open: 1, high: 1, low: 1, close: 1, volume: 1 };
}

function makeMockSource(): CandleSource & { getKline: ReturnType<typeof vi.fn> } {
  return { getKline: vi.fn() };
}

let testDb: PrismaClient;
let testDbPath: string;

beforeAll(() => {
  testDbPath = join(tmpdir(), `test-candlestore-${randomUUID()}.db`);
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
});

describe("ensureCandles", () => {
  it("fetches the full range on a cold cache", async () => {
    const source = makeMockSource();
    source.getKline.mockResolvedValue([kline(0), kline(DAY_MS), kline(2 * DAY_MS)]);

    const result = await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 2 * DAY_MS);

    expect(source.getKline).toHaveBeenCalledTimes(1);
    expect(source.getKline).toHaveBeenCalledWith("BTCUSDT", "1d", 0, 2 * DAY_MS);
    expect(result).toHaveLength(3);
  });

  it("only fetches the missing edge when the window extends a cached range forward", async () => {
    const source = makeMockSource();
    source.getKline.mockResolvedValueOnce([kline(0), kline(DAY_MS)]);
    await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, DAY_MS);

    source.getKline.mockResolvedValueOnce([kline(2 * DAY_MS), kline(3 * DAY_MS)]);
    const result = await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 3 * DAY_MS);

    expect(source.getKline).toHaveBeenCalledTimes(2);
    expect(source.getKline).toHaveBeenLastCalledWith("BTCUSDT", "1d", 2 * DAY_MS, 3 * DAY_MS);
    expect(result).toHaveLength(4);
  });

  it("does not re-fetch when the requested range is already fully cached", async () => {
    const source = makeMockSource();
    source.getKline.mockResolvedValueOnce([kline(0), kline(DAY_MS), kline(2 * DAY_MS)]);
    await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 2 * DAY_MS);

    source.getKline.mockClear();
    const result = await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, DAY_MS);

    expect(source.getKline).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it("keeps separate caches per symbol and per timeframe", async () => {
    const source = makeMockSource();
    source.getKline.mockResolvedValue([kline(0)]);
    await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 0);
    await ensureCandles(testDb, source, "ETHUSDT", "1d", 0, 0);
    await ensureCandles(testDb, source, "BTCUSDT", "1w", 0, 0);

    expect(source.getKline).toHaveBeenCalledTimes(3);
  });

  it("detects and repairs a hole punched in the middle of an already-cached range (regression: edge-only gap detection couldn't see this at all)", async () => {
    const source = makeMockSource();
    source.getKline.mockResolvedValueOnce([kline(0), kline(DAY_MS), kline(2 * DAY_MS)]);
    await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 2 * DAY_MS);

    // Simulate an exchange outage having left a hole: delete the middle candle directly,
    // bypassing ensureCandles (which would never create this state on its own).
    await testDb.candle.deleteMany({ where: { symbol: "BTCUSDT", timeframe: "1d", openTime: DAY_MS } });

    source.getKline.mockClear();
    source.getKline.mockResolvedValueOnce([kline(DAY_MS)]);
    const result = await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 2 * DAY_MS);

    // min/max are still 0 and 2*DAY_MS, so this can only have come from the mid-range scan.
    expect(source.getKline).toHaveBeenCalledTimes(1);
    expect(source.getKline).toHaveBeenCalledWith("BTCUSDT", "1d", DAY_MS, DAY_MS);
    expect(result.map((c) => c.openTime)).toEqual([0, DAY_MS, 2 * DAY_MS]);
  });

  it("skips a duplicate instead of failing the whole insert when the exchange re-returns an already-cached candle", async () => {
    const source = makeMockSource();
    source.getKline.mockResolvedValueOnce([kline(0), kline(DAY_MS)]);
    await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, DAY_MS);

    // The new edge fetch legitimately returns 2*DAY_MS, but also re-includes the already-cached
    // DAY_MS boundary candle — without duplicate-safe inserts this throws on the unique
    // constraint and silently drops 2*DAY_MS along with it (SQLite fails the whole batch).
    source.getKline.mockResolvedValueOnce([kline(DAY_MS), kline(2 * DAY_MS)]);
    const result = await ensureCandles(testDb, source, "BTCUSDT", "1d", 0, 2 * DAY_MS);

    expect(result.map((c) => c.openTime)).toEqual([0, DAY_MS, 2 * DAY_MS]);
  });
});
