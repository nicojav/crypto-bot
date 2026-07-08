import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import type { ClosedPnLEntry } from "../exchange/bybit.js";
import { backfillClosedPnl } from "./pnlBackfill.js";

// ── DB bootstrap (same pattern as reconciler.test.ts) ──────────────────────────

const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((d) => d !== "migration_lock.toml")
  .sort()
  .map((d) => readFileSync(resolve(MIGRATIONS_DIR, d, "migration.sql"), "utf8"))
  .join("\n");

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const BetterSqlite3 = require("better-sqlite3") as any;

let testDb: PrismaClient;
let testDbPath: string;
let botId: number;

const mockGetClosedPnL = vi.fn<() => Promise<ClosedPnLEntry[]>>();
const mockBybit = {
  getClosedPnL: mockGetClosedPnL,
} as unknown as import("../exchange/bybit.js").BybitClient;

beforeAll(async () => {
  testDbPath = join(tmpdir(), `test-pnlbackfill-${randomUUID()}.db`);
  const setup = new BetterSqlite3(testDbPath);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${testDbPath}` });
  testDb = new PrismaClient({ adapter });

  const bot = await testDb.bot.create({
    data: { name: "Test Bot", symbol: "SOLUSDT", enabled: true, dryRun: true },
  });
  botId = bot.id;
});

afterAll(async () => {
  await testDb.$disconnect();
  try { unlinkSync(testDbPath); } catch { /* ignore */ }
});

beforeEach(async () => {
  await testDb.trade.deleteMany();
  await testDb.signal.deleteMany();
  vi.clearAllMocks();
});

async function createClosedTrade(overrides: Partial<{
  side: string;
  symbol: string;
  qty: number;
  entryPrice: number;
  pnlSource: string | null;
  closedAt: Date;
}> = {}) {
  const sig = await testDb.signal.create({
    data: { botId, webhookId: randomUUID(), action: overrides.side ?? "BUY", payload: "{}", status: "EXECUTED" },
  });
  return testDb.trade.create({
    data: {
      botId,
      signalId: sig.id,
      exchangeOrderId: randomUUID(),
      symbol: overrides.symbol ?? "SOLUSDT",
      side: overrides.side ?? "BUY",
      qty: overrides.qty ?? 30,
      entryPrice: overrides.entryPrice ?? 80,
      status: "CLOSED",
      pnlSource: overrides.pnlSource === undefined ? "EXEC_FALLBACK" : overrides.pnlSource,
      closedAt: overrides.closedAt ?? new Date(),
    },
  });
}

function closedPnlEntry(overrides: Partial<ClosedPnLEntry> = {}): ClosedPnLEntry {
  return {
    orderId: randomUUID(),
    symbol: "SOLUSDT",
    side: "Sell", // closes a BUY trade by default
    qty: 30,
    avgEntryPrice: 80,
    avgExitPrice: 81,
    closedPnl: 30,
    openFee: 1,
    closeFee: 1,
    createdTime: Date.now() - 1000,
    updatedTime: Date.now(),
    ...overrides,
  };
}

describe("backfillClosedPnl", () => {
  it("resolves a single-row exact match and writes BYBIT_REST_GROUPED", async () => {
    const trade = await createClosedTrade({ side: "BUY", qty: 30 });
    const entry = closedPnlEntry({ orderId: "ord-match", qty: 30, closedPnl: 24.5, openFee: 1.1, closeFee: 1.2 });
    mockGetClosedPnL.mockResolvedValueOnce([entry]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000) });

    expect(result.matchedGroups).toBe(1);
    expect(result.matchedRows).toBe(1);

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.pnlSource).toBe("BYBIT_REST_GROUPED");
    expect(updated.pnlUsd).toBeCloseTo(24.5);
    expect(updated.realizedPnlUsd).toBeCloseTo(24.5);
    expect(updated.feeOpenUsd).toBeCloseTo(1.1);
    expect(updated.feeCloseUsd).toBeCloseTo(1.2);
    expect(updated.closingOrderId).toBe("ord-match");
  });

  it("distributes PnL by qty-share across stacked same-side rows", async () => {
    const closedAt = new Date();
    const t1 = await createClosedTrade({ side: "BUY", qty: 20, closedAt });
    const t2 = await createClosedTrade({ side: "BUY", qty: 10, closedAt });
    const entry = closedPnlEntry({ orderId: "ord-stack", qty: 30, closedPnl: 30, openFee: 3, closeFee: 3 });
    mockGetClosedPnL.mockResolvedValueOnce([entry]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000) });

    expect(result.matchedRows).toBe(2);
    const u1 = await testDb.trade.findUniqueOrThrow({ where: { id: t1.id } });
    const u2 = await testDb.trade.findUniqueOrThrow({ where: { id: t2.id } });
    expect(u1.pnlUsd).toBeCloseTo(20); // 2/3 share of 30
    expect(u2.pnlUsd).toBeCloseTo(10); // 1/3 share of 30
  });

  it("does not write anything in dryRun mode but still reports counts", async () => {
    const trade = await createClosedTrade({ side: "BUY", qty: 30 });
    mockGetClosedPnL.mockResolvedValueOnce([closedPnlEntry({ qty: 30 })]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000), dryRun: true });

    expect(result.matchedRows).toBe(1);
    const unchanged = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(unchanged.pnlSource).toBe("EXEC_FALLBACK");
    expect(unchanged.pnlUsd).toBeNull();
  });

  it("reports a qty-fix candidate without applying it when allowQtyFix is false", async () => {
    const trade = await createClosedTrade({ side: "BUY", qty: 26.5 });
    const entry = closedPnlEntry({ orderId: "ord-drift", qty: 30.8, closedPnl: -37.25 });
    mockGetClosedPnL.mockResolvedValueOnce([entry]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000), allowQtyFix: false });

    expect(result.qtyFixAvailable).toBe(1);
    expect(result.qtyFixed).toBe(0);
    const unchanged = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(unchanged.qty).toBe(26.5);
    expect(unchanged.pnlSource).toBe("EXEC_FALLBACK");
  });

  it("applies the qty correction when allowQtyFix is true", async () => {
    const trade = await createClosedTrade({ side: "BUY", qty: 26.5 });
    const entry = closedPnlEntry({ orderId: "ord-drift", qty: 30.8, closedPnl: -37.25 });
    mockGetClosedPnL.mockResolvedValueOnce([entry]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000), allowQtyFix: true });

    expect(result.qtyFixed).toBe(1);
    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.qty).toBeCloseTo(30.8);
    expect(updated.pnlSource).toBe("BYBIT_REST_GROUPED_QTY_FIX");
    expect(updated.pnlUsd).toBeCloseTo(-37.25);
  });

  it("leaves a trade untouched and counts it unmatched when no Bybit entry is found", async () => {
    const trade = await createClosedTrade({ side: "BUY", qty: 30 });
    mockGetClosedPnL.mockResolvedValueOnce([]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000) });

    expect(result.unmatchedGroups).toBe(1);
    const unchanged = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(unchanged.pnlSource).toBe("EXEC_FALLBACK");
  });

  it("excludes trades closed before the since cutoff", async () => {
    const oldTrade = await createClosedTrade({ side: "BUY", qty: 30, closedAt: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000) });
    mockGetClosedPnL.mockResolvedValue([]);

    const result = await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000) });

    expect(result.candidatesScanned).toBe(0);
    expect(mockGetClosedPnL).not.toHaveBeenCalled();
    const unchanged = await testDb.trade.findUniqueOrThrow({ where: { id: oldTrade.id } });
    expect(unchanged.pnlSource).toBe("EXEC_FALLBACK");
  });

  it("publishes trade.closed on the bus when a bus is supplied and a match is applied", async () => {
    const trade = await createClosedTrade({ side: "BUY", qty: 30 });
    mockGetClosedPnL.mockResolvedValueOnce([closedPnlEntry({ qty: 30, closedPnl: 12.5 })]);
    const published: unknown[] = [];
    const bus = { publish: (e: unknown) => published.push(e) } as unknown as import("../eventBus.js").EventBus;

    await backfillClosedPnl(testDb, mockBybit, { since: new Date(Date.now() - 60_000), bus });

    expect(published).toEqual([
      { type: "trade.closed", data: { tradeId: trade.id, botId, symbol: "SOLUSDT", pnlUsd: 12.5 } },
    ]);
  });
});
