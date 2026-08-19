import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { ensureFundingRates, type FundingSource } from "./fundingStore.js";
import type { FundingRateEntry } from "../exchange/bybit.js";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const BetterSqlite3 = require("better-sqlite3") as any;

const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((d) => d !== "migration_lock.toml")
  .sort()
  .map((d) => readFileSync(resolve(MIGRATIONS_DIR, d, "migration.sql"), "utf8"))
  .join("\n");

const HOUR_MS = 60 * 60 * 1000;

function entry(fundingTime: number, fundingRate = 0.0001): FundingRateEntry {
  return { fundingTime, fundingRate };
}

function makeMockSource(): FundingSource & { getFundingHistory: ReturnType<typeof vi.fn> } {
  return { getFundingHistory: vi.fn() };
}

let testDb: PrismaClient;
let testDbPath: string;

beforeAll(() => {
  testDbPath = join(tmpdir(), `test-fundingstore-${randomUUID()}.db`);
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
  await testDb.fundingRate.deleteMany({});
});

describe("ensureFundingRates", () => {
  it("fetches the full range on a cold cache and returns it in engine-ready shape", async () => {
    const source = makeMockSource();
    source.getFundingHistory.mockResolvedValue([entry(0), entry(8 * HOUR_MS), entry(16 * HOUR_MS)]);

    const result = await ensureFundingRates(testDb, source, "BTCUSDT", 0, 16 * HOUR_MS);

    expect(source.getFundingHistory).toHaveBeenCalledTimes(1);
    expect(source.getFundingHistory).toHaveBeenCalledWith("BTCUSDT", 0, 16 * HOUR_MS);
    expect(result).toEqual([
      { time: 0, rate: 0.0001 },
      { time: 8 * HOUR_MS, rate: 0.0001 },
      { time: 16 * HOUR_MS, rate: 0.0001 },
    ]);
  });

  it("only fetches the missing edge (1ms past the cached boundary, not a fixed interval) when extending forward", async () => {
    const source = makeMockSource();
    source.getFundingHistory.mockResolvedValueOnce([entry(0), entry(8 * HOUR_MS)]);
    await ensureFundingRates(testDb, source, "BTCUSDT", 0, 8 * HOUR_MS);

    source.getFundingHistory.mockResolvedValueOnce([entry(16 * HOUR_MS), entry(24 * HOUR_MS)]);
    const result = await ensureFundingRates(testDb, source, "BTCUSDT", 0, 24 * HOUR_MS);

    expect(source.getFundingHistory).toHaveBeenCalledTimes(2);
    expect(source.getFundingHistory).toHaveBeenLastCalledWith("BTCUSDT", 8 * HOUR_MS + 1, 24 * HOUR_MS);
    expect(result).toHaveLength(4);
  });

  it("does not re-fetch when the requested range is already fully cached", async () => {
    const source = makeMockSource();
    source.getFundingHistory.mockResolvedValueOnce([entry(0), entry(8 * HOUR_MS), entry(16 * HOUR_MS)]);
    await ensureFundingRates(testDb, source, "BTCUSDT", 0, 16 * HOUR_MS);

    source.getFundingHistory.mockClear();
    const result = await ensureFundingRates(testDb, source, "BTCUSDT", 0, 8 * HOUR_MS);

    expect(source.getFundingHistory).not.toHaveBeenCalled();
    expect(result).toHaveLength(2);
  });

  it("keeps separate caches per symbol", async () => {
    const source = makeMockSource();
    source.getFundingHistory.mockResolvedValue([entry(0)]);
    await ensureFundingRates(testDb, source, "BTCUSDT", 0, 0);
    await ensureFundingRates(testDb, source, "ETHUSDT", 0, 0);

    expect(source.getFundingHistory).toHaveBeenCalledTimes(2);
  });

  it("tolerates an overlapping refetch instead of throwing on the unique constraint", async () => {
    const source = makeMockSource();
    source.getFundingHistory.mockResolvedValue([entry(0), entry(8 * HOUR_MS)]);
    await ensureFundingRates(testDb, source, "BTCUSDT", 0, 8 * HOUR_MS);

    // A second call whose fetched range happens to overlap already-cached rows (e.g. the source
    // returning an entry right at the boundary again) must not throw on FundingRate's
    // [symbol, fundingTime] unique constraint.
    source.getFundingHistory.mockResolvedValueOnce([entry(8 * HOUR_MS), entry(16 * HOUR_MS)]);
    const result = await ensureFundingRates(testDb, source, "BTCUSDT", 0, 16 * HOUR_MS);

    expect(result).toHaveLength(3);
  });
});
