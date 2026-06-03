import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import type { ExecutionFill, ClosedPnLEntry } from "../exchange/bybit.js";

vi.mock("../env.js", () => ({
  env: {
    BYBIT_API_KEY: "test_key",
    BYBIT_API_SECRET: "test_secret",
    BYBIT_TESTNET: true,
    LOG_LEVEL: "error",
  },
}));

// Stub out bybit-api's WebsocketClient so no real WS connection is made
vi.mock("bybit-api", () => ({
  WebsocketClient: vi.fn(() => ({
    on: vi.fn(),
    subscribeV5: vi.fn(),
    closeAll: vi.fn(),
  })),
  RestClientV5: vi.fn(() => ({})),
}));

const { Reconciler } = await import("./reconciler.js");

// ── DB bootstrap ─────────────────────────────────────────────────────────────

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

// Mock BybitClient
const mockGetExecutionList = vi.fn<() => Promise<ExecutionFill[]>>();
const mockGetClosedPnL = vi.fn<() => Promise<ClosedPnLEntry[]>>();
const mockGetPositions = vi.fn();
const mockBybit = {
  getExecutionList: mockGetExecutionList,
  getClosedPnL: mockGetClosedPnL,
  getPositions: mockGetPositions,
  getBalance: vi.fn().mockResolvedValue({ coin: "USDT", equity: 1000, available: 900 }),
} as unknown as import("../exchange/bybit.js").BybitClient;

// Mock EventBus
const publishedEvents: unknown[] = [];
const mockBus = {
  publish: vi.fn((e: unknown) => { publishedEvents.push(e); }),
  subscribe: vi.fn(),
};

beforeAll(async () => {
  testDbPath = join(tmpdir(), `test-reconciler-${randomUUID()}.db`);
  const setup = new BetterSqlite3(testDbPath);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${testDbPath}` });
  testDb = new PrismaClient({ adapter });

  const bot = await testDb.bot.create({
    data: { name: "Test Bot", symbol: "XRPUSDT", enabled: true, dryRun: true },
  });
  botId = bot.id;
});

afterAll(async () => {
  await testDb.$disconnect();
  try { unlinkSync(testDbPath); } catch { /* ignore */ }
});

beforeEach(async () => {
  await testDb.fundingEvent.deleteMany();
  await testDb.trade.deleteMany();
  await testDb.signal.deleteMany();
  vi.clearAllMocks();
  publishedEvents.length = 0;
  // Restore default balance mock after clearAllMocks
  mockBybit.getBalance = vi.fn().mockResolvedValue({ coin: "USDT", equity: 1000, available: 900 });
});

// ── helpers ──────────────────────────────────────────────────────────────────

async function createSignalAndTrade(
  overrides: Partial<{
    side: string;
    symbol: string;
    qty: number;
    entryPrice: number;
    status: string;
    closingOrderId: string | null;
    exchangeOrderId: string;
  }> = {}
) {
  const sig = await testDb.signal.create({
    data: {
      botId,
      webhookId: randomUUID(),
      action: overrides.side ?? "BUY",
      payload: "{}",
      status: "EXECUTED",
    },
  });
  return testDb.trade.create({
    data: {
      botId,
      signalId: sig.id,
      exchangeOrderId: overrides.exchangeOrderId ?? randomUUID(),
      symbol: overrides.symbol ?? "XRPUSDT",
      side: overrides.side ?? "BUY",
      qty: overrides.qty ?? 100,
      entryPrice: overrides.entryPrice ?? 3.00,
      status: overrides.status ?? "OPEN",
      closingOrderId: overrides.closingOrderId ?? null,
    },
  });
}

function makeOrderEvent(overrides: Partial<{
  orderId: string;
  symbol: string;
  side: string;
  qty: string;
  avgPrice: string;
  cumExecFee: string;
  closedPnl: string;
  reduceOnly: boolean;
  orderStatus: string;
  createType: string;
}> = {}) {
  return {
    orderId: overrides.orderId ?? "close-ord-1",
    symbol: overrides.symbol ?? "XRPUSDT",
    side: overrides.side ?? "Buy",     // Bybit side for the closing order (Buy closes a Short/SELL trade)
    qty: overrides.qty ?? "100",
    orderStatus: overrides.orderStatus ?? "Filled",
    avgPrice: overrides.avgPrice ?? "2.90",
    cumExecFee: overrides.cumExecFee ?? "0.15",
    closedPnl: overrides.closedPnl ?? "9.85",
    reduceOnly: overrides.reduceOnly ?? true,
    updatedTime: String(Date.now()),
    createType: overrides.createType,
  };
}

// Call private handleUpdate via reconciler instance
async function triggerOrderFill(
  reconciler: InstanceType<typeof Reconciler>,
  order: ReturnType<typeof makeOrderEvent>
) {
  await (reconciler as unknown as { handleUpdate: (e: unknown) => Promise<void> }).handleUpdate({
    topic: "order",
    data: [order],
  });
}

async function triggerPositionZero(
  reconciler: InstanceType<typeof Reconciler>,
  symbol: string
) {
  await (reconciler as unknown as { handleUpdate: (e: unknown) => Promise<void> }).handleUpdate({
    topic: "position",
    data: [{ symbol, size: "0", markPrice: "2.90" }],
  });
}

// ── closeTradesByOrderFill ────────────────────────────────────────────────────

describe("closeTradesByOrderFill", () => {
  it("closes the matching SELL trade on a Buy reduce-only fill", async () => {
    const trade = await createSignalAndTrade({ side: "SELL", qty: 100, entryPrice: 3.00 });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({
      side: "Buy",     // Buy order closes a SELL (short) position
      qty: "100",
      avgPrice: "2.90",
      closedPnl: "9.85",
      cumExecFee: "0.15",
    }));

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.pnlSource).toBe("BYBIT_WS");
    expect(updated.realizedPnlUsd).toBeCloseTo(9.85);
    expect(updated.exitFillPrice).toBeCloseTo(2.90);
    expect(updated.feeCloseUsd).toBeCloseTo(0.15);
    expect(updated.closingOrderId).toBe("close-ord-1");
    expect(updated.closedAt).not.toBeNull();
  });

  it("closes the matching BUY trade on a Sell reduce-only fill", async () => {
    const trade = await createSignalAndTrade({ side: "BUY", qty: 50, entryPrice: 3.00 });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({
      side: "Sell",
      qty: "50",
      avgPrice: "3.50",
      closedPnl: "25.00",
      cumExecFee: "0.10",
    }));

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.realizedPnlUsd).toBeCloseTo(25.00);
    expect(updated.pnlSource).toBe("BYBIT_WS");
  });

  it("bails when two trades match (ambiguous) — neither gets closed", async () => {
    const t1 = await createSignalAndTrade({ side: "SELL", qty: 100, symbol: "XRPUSDT" });
    const t2 = await createSignalAndTrade({ side: "SELL", qty: 100, symbol: "XRPUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({ side: "Buy", qty: "100" }));

    const [r1, r2] = await Promise.all([
      testDb.trade.findUniqueOrThrow({ where: { id: t1.id } }),
      testDb.trade.findUniqueOrThrow({ where: { id: t2.id } }),
    ]);
    expect(r1.status).toBe("OPEN");
    expect(r2.status).toBe("OPEN");
  });

  it("does nothing when no matching trade exists", async () => {
    // Trade exists for a different symbol
    await createSignalAndTrade({ side: "SELL", qty: 100, symbol: "BTCUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    // Order fill is for XRPUSDT — no matching trade
    await expect(
      triggerOrderFill(reconciler, makeOrderEvent({ symbol: "XRPUSDT", side: "Buy", qty: "100" }))
    ).resolves.not.toThrow();
  });

  it("is idempotent — same orderId processed twice leaves trade CLOSED once", async () => {
    await createSignalAndTrade({ side: "SELL", qty: 100 });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    const order = makeOrderEvent({ orderId: "idem-ord", side: "Buy", qty: "100" });

    await triggerOrderFill(reconciler, order);
    await triggerOrderFill(reconciler, order); // second call is a no-op

    const trades = await testDb.trade.findMany({ where: { closingOrderId: "idem-ord" } });
    expect(trades).toHaveLength(1);
    expect(trades[0]!.status).toBe("CLOSED");
  });

  it("short PnL sign: SELL at 3.00 closed at 2.90 → positive realizedPnlUsd", async () => {
    await createSignalAndTrade({ side: "SELL", qty: 100, entryPrice: 3.00 });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    // closedPnl = (3.00 - 2.90) * 100 - fees = 10 - fee
    await triggerOrderFill(reconciler, makeOrderEvent({
      side: "Buy",
      qty: "100",
      avgPrice: "2.90",
      closedPnl: "9.85",  // Bybit's value, net of fees
    }));

    const trade = await testDb.trade.findFirstOrThrow({ where: { status: "CLOSED" } });
    expect(trade.realizedPnlUsd).toBeGreaterThan(0);
    expect(trade.realizedPnlUsd).toBeCloseTo(9.85);
  });

  it("qty tolerance: matches a trade within 0.5% qty difference", async () => {
    // qty on exchange fill slightly differs due to lot-size rounding
    const trade = await createSignalAndTrade({ side: "SELL", qty: 100.4, symbol: "XRPUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({ side: "Buy", qty: "100" }));

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
  });

  it("publishes trade.closed event on success", async () => {
    await createSignalAndTrade({ side: "SELL", qty: 100 });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({ side: "Buy", qty: "100" }));

    const closedEvents = publishedEvents.filter(
      (e) => (e as { type: string }).type === "trade.closed"
    );
    expect(closedEvents).toHaveLength(1);
  });

  it("also closes a CLOSING trade (not just OPEN)", async () => {
    const trade = await createSignalAndTrade({ side: "SELL", qty: 100, status: "CLOSING" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({ side: "Buy", qty: "100" }));

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
  });
});

// ── hydrateOpenTradeFill ──────────────────────────────────────────────────────

describe("hydrateOpenTradeFill", () => {
  it("updates entryFillPrice and feeOpenUsd when trade is found by exchangeOrderId", async () => {
    const openOrderId = "open-ord-1";
    const trade = await createSignalAndTrade({ side: "BUY", exchangeOrderId: openOrderId });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    // Non-reduce-only fill → open trade hydration
    await triggerOrderFill(reconciler, {
      ...makeOrderEvent({ orderId: openOrderId, side: "Buy", qty: "100", avgPrice: "3.05" }),
      reduceOnly: false,
    });

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.entryFillPrice).toBeCloseTo(3.05);
    expect(updated.feeOpenUsd).toBeCloseTo(0.15); // cumExecFee default
    expect(updated.entryPrice).toBeCloseTo(3.05);  // entryPrice kept in sync
    expect(updated.status).toBe("OPEN"); // not closed
  });

  it("does nothing when no trade matches the orderId", async () => {
    await createSignalAndTrade({ side: "BUY", exchangeOrderId: "some-other-ord" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await expect(
      triggerOrderFill(reconciler, {
        ...makeOrderEvent({ orderId: "unknown-ord", side: "Buy" }),
        reduceOnly: false,
      })
    ).resolves.not.toThrow();
  });
});

// ── closeRemainingOpenTrades ──────────────────────────────────────────────────

describe("closeRemainingOpenTrades", () => {
  it("closes an OPEN trade with EXEC_FALLBACK when a reduce-only execution is found", async () => {
    const trade = await createSignalAndTrade({ side: "BUY", qty: 100, entryPrice: 3.00, symbol: "XRPUSDT" });
    mockGetExecutionList.mockResolvedValueOnce([
      {
        orderId: "close-exec-ord",
        execId: "exec-close-1",
        symbol: "XRPUSDT",
        side: "Sell",
        execPrice: 3.50,
        execQty: 100,
        execFee: 0.18,
        execTime: Date.now(),
        closedSize: 100, // > 0 → reduce-only execution
      },
    ]);

    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerPositionZero(reconciler, "XRPUSDT");

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.pnlSource).toBe("EXEC_FALLBACK");
    expect(updated.exitFillPrice).toBeCloseTo(3.50);
    // PnL = (3.50 - 3.00) * 100 * 1 (BUY) - 0.18 fee = 49.82
    expect(updated.realizedPnlUsd).toBeCloseTo(49.82);
  });

  it("closes all OPEN and CLOSING trades for the symbol", async () => {
    await createSignalAndTrade({ side: "BUY", qty: 50, status: "OPEN", symbol: "XRPUSDT" });
    await createSignalAndTrade({ side: "BUY", qty: 50, status: "CLOSING", symbol: "XRPUSDT" });
    mockGetExecutionList.mockResolvedValueOnce([
      {
        orderId: "exec-close-multi",
        execId: "exec-m-1",
        symbol: "XRPUSDT",
        side: "Sell",
        execPrice: 3.10,
        execQty: 100,
        execFee: 0.10,
        execTime: Date.now(),
        closedSize: 100,
      },
    ]);

    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerPositionZero(reconciler, "XRPUSDT");

    const openTrades = await testDb.trade.findMany({
      where: { symbol: "XRPUSDT", status: { in: ["OPEN", "CLOSING"] } },
    });
    expect(openTrades).toHaveLength(0);
  });

  it("closes with no fill data when getExecutionList returns no reduce-only executions and getClosedPnL returns empty", async () => {
    const trade = await createSignalAndTrade({ side: "BUY", qty: 100, symbol: "XRPUSDT" });
    // Execution list has no closedSize > 0
    mockGetExecutionList.mockResolvedValueOnce([
      {
        orderId: "open-ord",
        execId: "exec-open",
        symbol: "XRPUSDT",
        side: "Buy",
        execPrice: 3.00,
        execQty: 100,
        execFee: 0.10,
        execTime: Date.now(),
        closedSize: 0, // not a close execution
      },
    ]);
    mockGetClosedPnL.mockResolvedValueOnce([]); // no closed PnL entries either

    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerPositionZero(reconciler, "XRPUSDT");

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.pnlSource).toBe("EXEC_FALLBACK");
    expect(updated.exitFillPrice).toBeNull();
  });

  it("closes with BYBIT_REST when getExecutionList finds nothing but getClosedPnL matches", async () => {
    const trade = await createSignalAndTrade({ side: "BUY", qty: 100, entryPrice: 3.00, symbol: "XRPUSDT" });
    mockGetExecutionList.mockResolvedValueOnce([]); // no executions
    mockGetClosedPnL.mockResolvedValueOnce([
      {
        orderId: "rest-ord-1",
        symbol: "XRPUSDT",
        side: "Buy",       // position side = Buy = long = BUY trade
        qty: 100,
        avgEntryPrice: 3.00,
        avgExitPrice: 3.50,
        closedPnl: 48.75,  // Bybit's authoritative value
        openFee: 0.15,
        closeFee: 0.10,
        createdTime: Date.now() - 5000,
        updatedTime: Date.now(),
      },
    ]);

    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerPositionZero(reconciler, "XRPUSDT");

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.pnlSource).toBe("BYBIT_REST");
    expect(updated.realizedPnlUsd).toBeCloseTo(48.75);
    expect(updated.exitFillPrice).toBeCloseTo(3.50);
    expect(updated.feeCloseUsd).toBeCloseTo(0.10);
    expect(updated.feeOpenUsd).toBeCloseTo(0.15);
    expect(updated.closingOrderId).toBe("rest-ord-1");
  });

  it("falls back to null PnL when getClosedPnL returns ambiguous matches", async () => {
    const trade = await createSignalAndTrade({ side: "BUY", qty: 100, symbol: "XRPUSDT" });
    mockGetExecutionList.mockResolvedValueOnce([]);
    // Two entries with same side+qty — ambiguous
    const entry = {
      orderId: "rest-amb",
      symbol: "XRPUSDT",
      side: "Buy",
      qty: 100,
      avgEntryPrice: 3.00,
      avgExitPrice: 3.50,
      closedPnl: 48.75,
      openFee: 0.15,
      closeFee: 0.10,
      createdTime: Date.now() - 5000,
      updatedTime: Date.now(),
    };
    mockGetClosedPnL.mockResolvedValueOnce([entry, { ...entry, orderId: "rest-amb-2" }]);

    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerPositionZero(reconciler, "XRPUSDT");

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.pnlSource).toBe("EXEC_FALLBACK");
    expect(updated.realizedPnlUsd).toBeNull();
  });

  it("closes even when getExecutionList throws", async () => {
    const trade = await createSignalAndTrade({ side: "BUY", qty: 100, symbol: "XRPUSDT" });
    mockGetExecutionList.mockRejectedValueOnce(new Error("network failure"));
    mockGetClosedPnL.mockResolvedValueOnce([]); // closedPnL returns nothing

    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerPositionZero(reconciler, "XRPUSDT");

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.exitFillPrice).toBeNull();
  });

  it("does nothing when there are no open trades for the symbol", async () => {
    // Create a trade for a different symbol
    await createSignalAndTrade({ symbol: "BTCUSDT", side: "BUY" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await expect(triggerPositionZero(reconciler, "XRPUSDT")).resolves.not.toThrow();

    // BTCUSDT trade unchanged
    const btcTrade = await testDb.trade.findFirstOrThrow({ where: { symbol: "BTCUSDT" } });
    expect(btcTrade.status).toBe("OPEN");
  });
});

// ── Liquidation handling ──────────────────────────────────────────────────────

describe("closeTradesByOrderFill — liquidations", () => {
  it("closes 1 OPEN trade despite qty mismatch when createType is CreateByLiq", async () => {
    // Bot opened a 30-SOL long; liquidation order is for 87.9 SOL (cumulative position)
    const trade = await createSignalAndTrade({ side: "BUY", qty: 30, symbol: "XRPUSDT", entryPrice: 1.50 });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({
      orderId: "liq-ord-1",
      symbol: "XRPUSDT",
      side: "Sell",     // Sell order liquidates a BUY (long) trade
      qty: "87.9",      // full position size on exchange — mismatches trade.qty=30
      avgPrice: "1.20",
      closedPnl: "-87.00",
      cumExecFee: "0.56",
      createType: "CreateByLiq",
    }));

    const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
    expect(updated.status).toBe("CLOSED");
    expect(updated.pnlSource).toBe("BYBIT_LIQUIDATION");
    expect(updated.realizedPnlUsd).toBeCloseTo(-87.00);
    expect(updated.feeCloseUsd).toBeCloseTo(0.56);
    expect(updated.closingOrderId).toBe("liq-ord-1");
  });

  it("handles CreateByTakeOver_PassThrough (bankruptcy) and CreateByAdl_PassThrough", async () => {
    for (const createType of ["CreateByTakeOver_PassThrough", "CreateByAdl_PassThrough"]) {
      const trade = await createSignalAndTrade({ side: "BUY", qty: 50, symbol: "XRPUSDT" });
      const reconciler = new Reconciler(testDb, mockBybit, mockBus);

      await triggerOrderFill(reconciler, makeOrderEvent({
        orderId: `liq-${createType}`,
        symbol: "XRPUSDT",
        side: "Sell",
        qty: "999",        // very different qty — would fail normal path
        avgPrice: "1.00",
        closedPnl: "-200",
        createType,
      }));

      const updated = await testDb.trade.findUniqueOrThrow({ where: { id: trade.id } });
      expect(updated.status).toBe("CLOSED");
      expect(updated.pnlSource).toBe("BYBIT_LIQUIDATION");
    }
  });

  it("closes 2 OPEN BUY trades; first absorbs full PnL, second gets zero-attributed", async () => {
    const t1 = await createSignalAndTrade({ side: "BUY", qty: 30, symbol: "XRPUSDT" });
    const t2 = await createSignalAndTrade({ side: "BUY", qty: 50, symbol: "XRPUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({
      orderId: "liq-multi",
      symbol: "XRPUSDT",
      side: "Sell",
      qty: "80",
      avgPrice: "1.10",
      closedPnl: "-50.00",
      cumExecFee: "0.40",
      createType: "CreateByLiq",
    }));

    const [r1, r2] = await Promise.all([
      testDb.trade.findUniqueOrThrow({ where: { id: t1.id } }),
      testDb.trade.findUniqueOrThrow({ where: { id: t2.id } }),
    ]);

    // Both closed
    expect(r1.status).toBe("CLOSED");
    expect(r2.status).toBe("CLOSED");
    expect(r1.pnlSource).toBe("BYBIT_LIQUIDATION");
    expect(r2.pnlSource).toBe("BYBIT_LIQUIDATION");
    expect(r1.closingOrderId).toBe("liq-multi");
    expect(r2.closingOrderId).toBe("liq-multi");

    // First absorbs full PnL; second gets zero
    const pnlTotal = (r1.realizedPnlUsd ?? 0) + (r2.realizedPnlUsd ?? 0);
    expect(pnlTotal).toBeCloseTo(-50.00);
    const feeTotal = (r1.feeCloseUsd ?? 0) + (r2.feeCloseUsd ?? 0);
    expect(feeTotal).toBeCloseTo(0.40);
  });

  it("is idempotent — second liquidation event for same orderId is a no-op", async () => {
    await createSignalAndTrade({ side: "BUY", qty: 30, symbol: "XRPUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    const order = makeOrderEvent({ orderId: "liq-idem", side: "Sell", qty: "87.9", createType: "CreateByLiq" });

    await triggerOrderFill(reconciler, order);
    await triggerOrderFill(reconciler, order);

    const closed = await testDb.trade.findMany({ where: { status: "CLOSED" } });
    expect(closed).toHaveLength(1);
  });

  it("publishes trade.liquidated exactly once per liquidation order", async () => {
    await createSignalAndTrade({ side: "BUY", qty: 30, symbol: "XRPUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    await triggerOrderFill(reconciler, makeOrderEvent({
      orderId: "liq-event",
      side: "Sell",
      qty: "87.9",
      closedPnl: "-45.00",
      createType: "CreateByLiq",
    }));

    const liqEvents = publishedEvents.filter((e) => (e as { type: string }).type === "trade.liquidated");
    expect(liqEvents).toHaveLength(1);
    const evt = liqEvents[0] as { type: string; data: { realizedPnlUsd: number } };
    expect(evt.data.realizedPnlUsd).toBeCloseTo(-45.00);
  });

  it("does not skip qty match for a normal reduceOnly order (regression)", async () => {
    // Two SELL trades with different qtys — normal close should still require match
    await createSignalAndTrade({ side: "SELL", qty: 100, symbol: "XRPUSDT" });
    const t2 = await createSignalAndTrade({ side: "SELL", qty: 200, symbol: "XRPUSDT" });
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);

    // createType is undefined (normal order) → uses qty match
    await triggerOrderFill(reconciler, makeOrderEvent({
      side: "Buy",
      qty: "200",
    }));

    // Only the 200-qty trade should close; the 100-qty one stays OPEN
    const updated200 = await testDb.trade.findUniqueOrThrow({ where: { id: t2.id } });
    expect(updated200.status).toBe("CLOSED");
    expect(updated200.pnlSource).toBe("BYBIT_WS");

    const stillOpen = await testDb.trade.findMany({ where: { status: "OPEN" } });
    expect(stillOpen).toHaveLength(1);
  });
});

// ── Funding events ────────────────────────────────────────────────────────────

describe("handleFundingExecution", () => {
  async function triggerFundingExecution(
    reconciler: InstanceType<typeof Reconciler>,
    exec: { execType: string; symbol: string; execId: string; execFee: string; execTime: string }
  ) {
    await (reconciler as unknown as { handleUpdate: (e: unknown) => Promise<void> }).handleUpdate({
      topic: "execution",
      data: [exec],
    });
  }

  it("creates a FundingEvent row for execType=Funding", async () => {
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    const execTime = String(Date.now());

    await triggerFundingExecution(reconciler, {
      execType: "Funding",
      symbol: "XRPUSDT",
      execId: "funding-exec-1",
      execFee: "-0.1234",  // negative = paid out
      execTime,
    });

    const event = await testDb.fundingEvent.findUniqueOrThrow({ where: { execId: "funding-exec-1" } });
    expect(event.symbol).toBe("XRPUSDT");
    expect(event.fundingUsd).toBeCloseTo(-0.1234);
  });

  it("is idempotent — duplicate execId does not throw or create a second row", async () => {
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    const execTime = String(Date.now());
    const exec = { execType: "Funding", symbol: "XRPUSDT", execId: "funding-idem-2", execFee: "-0.05", execTime };

    await triggerFundingExecution(reconciler, exec);
    await expect(triggerFundingExecution(reconciler, exec)).resolves.not.toThrow();

    const rows = await testDb.fundingEvent.findMany({ where: { execId: "funding-idem-2" } });
    expect(rows).toHaveLength(1);
  });

  it("does NOT create a FundingEvent for execType=Trade", async () => {
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerFundingExecution(reconciler, {
      execType: "Trade",
      symbol: "XRPUSDT",
      execId: "trade-exec-99",
      execFee: "-1.00",
      execTime: String(Date.now()),
    });

    const rows = await testDb.fundingEvent.findMany({ where: { execId: "trade-exec-99" } });
    expect(rows).toHaveLength(0);
  });

  it("stores positive funding (received) correctly", async () => {
    const reconciler = new Reconciler(testDb, mockBybit, mockBus);
    await triggerFundingExecution(reconciler, {
      execType: "Funding",
      symbol: "SOLUSDT",
      execId: "funding-pos-3",
      execFee: "0.0888",  // positive = received
      execTime: String(Date.now()),
    });

    const event = await testDb.fundingEvent.findUniqueOrThrow({ where: { execId: "funding-pos-3" } });
    expect(event.fundingUsd).toBeCloseTo(0.0888);
  });
});
