import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { SignalProcessor, calcQty, roundToTick, type Exchange } from "./signalProcessor.js";

vi.mock("../env.js", () => ({
  env: {
    WEBHOOK_SECRET: "test_secret_xyz_123",
    DATABASE_URL: "file:./dev.db",
    PORT: 3000,
    LOG_LEVEL: "error",
    BYBIT_API_KEY: "test",
    BYBIT_API_SECRET: "test",
    BYBIT_TESTNET: true,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any
const BetterSqlite3 = require("better-sqlite3") as any;

const MIGRATIONS_DIR = resolve(__dirname, "../../prisma/migrations");
const MIGRATION_SQL = readdirSync(MIGRATIONS_DIR)
  .filter((d) => d !== "migration_lock.toml")
  .sort()
  .map((d) => readFileSync(resolve(MIGRATIONS_DIR, d, "migration.sql"), "utf8"))
  .join("\n");

const DEFAULT_FILL = { cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" };

function makeMockExchange(): Exchange & { [K in keyof Exchange]: ReturnType<typeof vi.fn> } {
  return {
    getMarkPrice: vi.fn(),
    getPositions: vi.fn(),
    getInstrumentInfo: vi.fn(),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn(),
    getOrderFill: vi.fn().mockResolvedValue(DEFAULT_FILL),
    setTradingStop: vi.fn().mockResolvedValue(undefined),
  };
}

let testDb: PrismaClient;
let testDbPath: string;
let botId: number;

beforeAll(async () => {
  testDbPath = join(tmpdir(), `test-processor-${randomUUID()}.db`);
  const setup = new BetterSqlite3(testDbPath);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${testDbPath}` });
  testDb = new PrismaClient({ adapter });

  const bot = await testDb.bot.create({
    data: {
      name: "Processor Test Bot",
      symbol: "BTCUSDT",
      enabled: true,
      dryRun: false,
      maxLeverage: 5,
      maxPositionUsd: 100,
      dailyLossLimitUsd: -500,
    },
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
});

async function createPendingSignal(action: "BUY" | "SELL" | "CLOSE", price = 50000) {
  return testDb.signal.create({
    data: {
      botId,
      webhookId: `wh-${randomUUID()}`,
      action,
      payload: JSON.stringify({ symbol: "BTCUSDT", price }),
      status: "PENDING",
    },
    include: { bot: true },
  });
}

describe("roundToTick", () => {
  it("rounds to nearest tick (tickSize=1)", () => {
    expect(roundToTick(51500.3, 1)).toBe(51500);
    expect(roundToTick(51500.7, 1)).toBe(51501);
  });

  it("rounds to 0.5 tick correctly", () => {
    expect(roundToTick(51500.3, 0.5)).toBe(51500.5);
    expect(roundToTick(48499.7, 0.5)).toBe(48499.5);
  });

  it("rounds to 0.0001 tick (XRP-style)", () => {
    expect(roundToTick(1.12347, 0.0001)).toBe(1.1235);
    expect(roundToTick(1.12341, 0.0001)).toBe(1.1234);
  });

  it("passthrough when tickSize is 0 or non-finite", () => {
    expect(roundToTick(1234.5, 0)).toBe(1234.5);
    expect(roundToTick(1234.5, -1)).toBe(1234.5);
    expect(roundToTick(1234.5, NaN)).toBe(1234.5);
  });

  it("already-valid price unchanged", () => {
    expect(roundToTick(51500, 1)).toBe(51500);
    expect(roundToTick(1.1234, 0.0001)).toBe(1.1234);
  });
});

describe("calcQty", () => {
  it("returns clean float for lotSize=0.1 with large steps", () => {
    const result = calcQty(100, 5, 43.1, 0.1); // steps = floor(100*5/43.1/0.1) = 116
    expect(result).toBe(11.6);
    expect(Number.isInteger(result * 10)).toBe(true);
  });

  it("returns clean float for large XRP-style steps", () => {
    const result = calcQty(100, 5, 0.3425, 0.1); // steps = floor(100*5/0.3425/0.1) = 14598
    expect(result).toBe(1459.8);
    expect(Number.isInteger(result * 10)).toBe(true);
  });

  it("returns whole number multiple of lotSize=0.1", () => {
    const result = calcQty(100, 1, 14.28, 0.1); // steps=70, qty=7
    expect(result).toBe(7);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("BTC regression: floor(100*5/50000/0.001)*0.001 = 0.01", () => {
    expect(calcQty(100, 5, 50000, 0.001)).toBe(0.01);
  });

  it("returns integer for lotSize=1", () => {
    const result = calcQty(100, 1, 50, 1);
    expect(result).toBe(2);
    expect(Number.isInteger(result)).toBe(true);
  });
});

describe("SignalProcessor", () => {
  it("BUY signal (live mode) → EXECUTED with Trade row", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-abc-123");

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await createPendingSignal("BUY");

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");
    expect(updated.processedAt).not.toBeNull();

    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade).not.toBeNull();
    expect(trade?.side).toBe("BUY");
    expect(trade?.exchangeOrderId).toBe("order-abc-123");
    expect(trade?.qty).toBe(0.01); // floor(100 * 5 / 50000 / 0.001) * 0.001 = 10 * 0.001
    expect(trade?.entryPrice).toBe(50000);
    expect(trade?.status).toBe("OPEN");

    expect(exchange.setLeverage).toHaveBeenCalledWith("BTCUSDT", 5);
    expect(exchange.placeMarketOrder).toHaveBeenCalledWith({
      symbol: "BTCUSDT",
      side: "Buy",
      qty: 0.01,
      reduceOnly: false,
    });
    // No TP/SL in this signal → setTradingStop must not be called
    expect(exchange.setTradingStop).not.toHaveBeenCalled();
  });

  it("CLOSE signal with no open position → REJECTED", async () => {
    const exchange = makeMockExchange();
    exchange.getPositions.mockResolvedValue([{ side: "None", size: 0 }]);

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await createPendingSignal("CLOSE");

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toMatch(/no open position/i);
    expect(exchange.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("signal rejected when bot is disabled (kill switch)", async () => {
    const disabledBot = await testDb.bot.create({
      data: {
        name: "Disabled Bot",
        symbol: "ETHUSDT",
        enabled: false,
        dryRun: false,
        dailyLossLimitUsd: -500,
      },
    });

    const signal = await testDb.signal.create({
      data: {
        botId: disabledBot.id,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "ETHUSDT", price: 3000 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    const exchange = makeMockExchange();
    const processor = new SignalProcessor(testDb, exchange);

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toMatch(/disabled/i);
    expect(exchange.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("signal rejected when daily loss limit is breached", async () => {
    // Create a closed trade with a large loss today
    const openSignal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000 }),
        status: "EXECUTED",
        processedAt: new Date(),
      },
    });
    await testDb.trade.create({
      data: {
        botId,
        signalId: openSignal.id,
        exchangeOrderId: "order-old",
        symbol: "BTCUSDT",
        side: "BUY",
        qty: 0.01,
        entryPrice: 50000,
        exitPrice: 44000,
        pnlUsd: -600, // exceeds -500 daily limit
        status: "CLOSED",
        closedAt: new Date(),
      },
    });

    const exchange = makeMockExchange();
    const processor = new SignalProcessor(testDb, exchange);
    const signal = await createPendingSignal("BUY");

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toMatch(/daily loss limit/i);
    expect(exchange.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("reversal happy path: SELL against open BUY → reduce-only Sell then open Sell", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    // First call: reduce-only close; second call: open new position
    exchange.placeMarketOrder
      .mockResolvedValueOnce("order-close-123")
      .mockResolvedValueOnce("order-open-456");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([{ side: "Buy", size: 0.01 }]);

    const processor = new SignalProcessor(testDb, exchange);

    const openSignal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000 }),
        status: "EXECUTED",
        processedAt: new Date(),
      },
    });
    await testDb.trade.create({
      data: {
        botId,
        signalId: openSignal.id,
        exchangeOrderId: "order-prior",
        symbol: "BTCUSDT",
        side: "BUY",
        qty: 0.01,
        entryPrice: 50000,
        status: "OPEN",
      },
    });

    const signal = await createPendingSignal("SELL");
    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    expect(exchange.placeMarketOrder).toHaveBeenCalledTimes(2);
    expect(exchange.placeMarketOrder).toHaveBeenNthCalledWith(1, { symbol: "BTCUSDT", side: "Sell", qty: 0.01, reduceOnly: true });
    expect(exchange.placeMarketOrder).toHaveBeenNthCalledWith(2, expect.objectContaining({ side: "Sell", reduceOnly: false }));

    // Reversal path: old trade is marked CLOSING (reconciler finalizes with real fill price)
    const closedTrade = await testDb.trade.findFirst({ where: { signalId: openSignal.id } });
    expect(closedTrade?.status).toBe("CLOSING");
    expect(closedTrade?.closingOrderId).not.toBeNull();
    // pnlUsd is null until reconciler receives the WS order fill
    expect(closedTrade?.pnlUsd).toBeNull();

    const newTrade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(newTrade?.side).toBe("SELL");
    expect(newTrade?.status).toBe("OPEN");
  });

  it("divergence guard: DB has SELL trade but exchange has Buy position → skip reduce-only, reconcile DB, open Buy", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-open-789");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    // Exchange has Buy position (same side as incoming BUY signal) — divergence
    exchange.getPositions.mockResolvedValue([{ side: "Buy", size: 0.01 }]);

    const processor = new SignalProcessor(testDb, exchange);

    const staleSignal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "SELL",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000 }),
        status: "EXECUTED",
        processedAt: new Date(),
      },
    });
    await testDb.trade.create({
      data: {
        botId,
        signalId: staleSignal.id,
        exchangeOrderId: "order-stale",
        symbol: "BTCUSDT",
        side: "SELL",
        qty: 0.01,
        entryPrice: 50000,
        status: "OPEN",
      },
    });

    const signal = await createPendingSignal("BUY");
    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    // Exactly one order placed — the opening Buy, NOT a reduce-only
    expect(exchange.placeMarketOrder).toHaveBeenCalledTimes(1);
    expect(exchange.placeMarketOrder).toHaveBeenCalledWith(expect.objectContaining({ side: "Buy", reduceOnly: false }));

    const staleTrade = await testDb.trade.findFirst({ where: { signalId: staleSignal.id } });
    expect(staleTrade?.status).toBe("CLOSED");
    expect(staleTrade?.pnlUsd).not.toBeNull();
  });

  it("reduce-only throws → signal REJECTED, no opening order placed", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockRejectedValueOnce(new Error("Bybit error 110017: reduce-only order has same side with current position"));
    exchange.getPositions.mockResolvedValue([{ side: "Buy", size: 0.01 }]);

    const processor = new SignalProcessor(testDb, exchange);

    const openSignal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000 }),
        status: "EXECUTED",
        processedAt: new Date(),
      },
    });
    await testDb.trade.create({
      data: {
        botId,
        signalId: openSignal.id,
        exchangeOrderId: "order-prior-2",
        symbol: "BTCUSDT",
        side: "BUY",
        qty: 0.01,
        entryPrice: 50000,
        status: "OPEN",
      },
    });

    const signal = await createPendingSignal("SELL");
    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toMatch(/110017/);

    // No opening order attempted
    expect(exchange.placeMarketOrder).toHaveBeenCalledTimes(1);

    const originalTrade = await testDb.trade.findFirst({ where: { signalId: openSignal.id } });
    expect(originalTrade?.status).toBe("OPEN");
  });

  it("symbol mismatch → signal REJECTED, no exchange call", async () => {
    const exchange = makeMockExchange();
    const processor = new SignalProcessor(testDb, exchange);

    // Bot is configured for BTCUSDT but signal payload says ETHUSDT (wrong URL pasted in TradingView)
    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "ETHUSDT", price: 3000 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toMatch(/symbol mismatch/i);
    expect(updated.rejectionReason).toMatch(/ETHUSDT/);
    expect(updated.rejectionReason).toMatch(/BTCUSDT/);
    expect(exchange.placeMarketOrder).not.toHaveBeenCalled();
  });

  it("BUY signal with stale TP/SL re-anchored to live markPrice, tick-rounded", async () => {
    // Simulate: bar closed at 50000, TP=51500, SL=48500, but live price has drifted to 50100.
    // Expected re-anchored: TP=50100+(51500-50000)=51600, SL=50100-(50000-48500)=48600.
    // With tickSize=1 → same values (already integers).
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50100);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-tp-sl");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50100, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);

    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, takeProfit: 51500, stopLoss: 48500 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    // TP/SL goes via setTradingStop, NOT attached to the market order
    expect(exchange.placeMarketOrder).toHaveBeenCalledWith(
      expect.not.objectContaining({ takeProfit: expect.anything() })
    );
    expect(exchange.setTradingStop).toHaveBeenCalledWith("BTCUSDT", {
      takeProfit: 51600, // 50100 + 1500 offset
      stopLoss: 48600,  // 50100 - 1500 offset
    });

    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade?.takeProfitPrice).toBe(51600);
    expect(trade?.stopLossPrice).toBe(48600);
    expect(trade?.tpslSet).toBe(true);
  });

  it("BUY signal with extreme price drift → TP on wrong side after re-anchor, TP dropped, SL kept", async () => {
    // Bar closed at 50000, TP=50100 (very tight — 100 pts up), but live price surged to 50200.
    // After re-anchor: TP = 50200 + (50100-50000) = 50300 → valid (above markPrice).
    // SL raw=49900, offset=-100, anchored=50200-100=50100 < markPrice → valid for BUY.
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50200);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-partial-tpsl");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50200, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);

    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, takeProfit: 50100, stopLoss: 49900 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    // TP/SL sent via setTradingStop, not the market order
    expect(exchange.setTradingStop).toHaveBeenCalledWith("BTCUSDT", {
      takeProfit: 50300, // 50200 + 100
      stopLoss: 50100,   // 50200 - 100
    });
  });

  it("TP/SL tick-rounding: raw values with sub-tick decimals are rounded", async () => {
    // tickSize=0.5, raw takeProfit=51500.3, stopLoss=48499.7
    // roundToTick(51500.3, 0.5) = round(51500.3/0.5)*0.5 = 103001*0.5 = 51500.5
    // roundToTick(48499.7, 0.5) = round(48499.7/0.5)*0.5 = 96999*0.5 = 48499.5
    // (with price=markPrice=50000 → no drift, offsets preserved exactly, just tick-rounded)
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 0.5 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-ticked");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);

    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, takeProfit: 51500.3, stopLoss: 48499.7 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    // TP/SL goes via setTradingStop with tick-rounded values
    expect(exchange.setTradingStop).toHaveBeenCalledWith("BTCUSDT", {
      takeProfit: 51500.5,
      stopLoss: 48499.5,
    });
  });

  // ── Percentage-based TP/SL (tpPct / slPct) ───────────────────────────────────

  it("BUY with tpPct=1.5 slPct=0.75 → TP and SL computed from live markPrice", async () => {
    // markPrice=50000, tpPct=1.5 → TP = 50000 × 1.015 = 50750
    //                   slPct=0.75 → SL = 50000 × 0.9925 = 49625
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-pct-buy");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, tpPct: 1.5, slPct: 0.75 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");
    // TP/SL goes via setTradingStop
    expect(exchange.setTradingStop).toHaveBeenCalledWith("BTCUSDT", {
      takeProfit: 50750, // 50000 × 1.015
      stopLoss: 49625,   // 50000 × 0.9925
    });
    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade?.tpslSet).toBe(true);
    expect(trade?.takeProfitPrice).toBe(50750);
    expect(trade?.stopLossPrice).toBe(49625);
  });

  it("SELL with tpPct=1.5 slPct=0.75 → TP below mark, SL above mark", async () => {
    // markPrice=50000, tpPct=1.5 → TP = 50000 × 0.985 = 49250
    //                   slPct=0.75 → SL = 50000 × 1.0075 = 50375
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-pct-sell");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "SELL",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, tpPct: 1.5, slPct: 0.75 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");
    expect(exchange.setTradingStop).toHaveBeenCalledWith("BTCUSDT", {
      takeProfit: 49250, // 50000 × 0.985
      stopLoss: 50375,   // 50000 × 1.0075
    });
  });

  it("tpPct only (no slPct) → setTradingStop called with TP only, SL undefined", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-tp-only");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, tpPct: 2.0 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const call = exchange.setTradingStop.mock.calls[0] as [string, { takeProfit?: number; stopLoss?: number }];
    expect(call[1].takeProfit).toBe(51000); // 50000 × 1.02
    expect(call[1].stopLoss).toBeUndefined();
  });

  it("tpPct takes priority over absolute takeProfit when both present", async () => {
    // tpPct=2.0 → TP=51000; should ignore absolute takeProfit=55000
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.placeMarketOrder.mockResolvedValue("order-pct-priority");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.getPositions.mockResolvedValue([]);

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        // Both present — tpPct should win
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, tpPct: 2.0, takeProfit: 55000 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    const call = exchange.setTradingStop.mock.calls[0] as [string, { takeProfit?: number }];
    expect(call[1].takeProfit).toBe(51000); // pct wins: 50000 × 1.02 = 51000
  });

  it("setTradingStop failure → Trade still created with tpslSet=false, signal EXECUTED", async () => {
    // Entry order fills fine; setTradingStop fails (e.g. position not yet settled on testnet).
    // We must NOT abort the trade — the position is real, just unprotected.
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.getPositions.mockResolvedValue([]);
    exchange.placeMarketOrder.mockResolvedValue("order-tpsl-failed");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0.01, avgPrice: 50000, status: "Cancelled" });
    exchange.setTradingStop.mockRejectedValueOnce(new Error("Bybit error 10001: invalid tp/sl price"));

    const processor = new SignalProcessor(testDb, exchange);

    const signal = await testDb.signal.create({
      data: {
        botId,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000, takeProfit: 50500, stopLoss: 49500 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    await processor.processSignal(signal);

    // Signal must EXECUTE — the position exists even without a bracket
    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");
    expect(updated.rejectionReason).toBeNull();

    // placeMarketOrder called once only — no retry, no TP/SL on the order
    expect(exchange.placeMarketOrder).toHaveBeenCalledTimes(1);

    // Trade created with tpslSet=false (bracket not applied)
    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade).not.toBeNull();
    expect(trade?.tpslSet).toBe(false);
    expect(trade?.takeProfitPrice).toBe(50500); // intent recorded even though not applied
    expect(trade?.stopLossPrice).toBe(49500);
  });

  it("getOrderFill throws → signal EXECUTED, Trade still created with requested qty (reconciler repairs)", async () => {
    // Simulates the timing race: order filled on Bybit but getOrderFill can't read it yet.
    // The Trade must still be created so the position is not orphaned.
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.getPositions.mockResolvedValue([]);
    exchange.placeMarketOrder.mockResolvedValue("order-fill-error");
    exchange.getOrderFill.mockRejectedValue(new Error("Order not found after 4 attempts: order-fill-error"));

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await createPendingSignal("BUY");

    await processor.processSignal(signal);

    // Signal is EXECUTED — the order reached the exchange
    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    // Trade exists with the requested qty (reconciler will correct it later)
    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade).not.toBeNull();
    expect(trade?.status).toBe("OPEN");
    expect(trade?.qty).toBe(0.01); // requested qty, not fill qty
    expect(trade?.exchangeOrderId).toBe("order-fill-error");
  });

  it("0-fill entry order → signal EXECUTED, Trade created then immediately closed as PHANTOM", async () => {
    // Market order placed and registered but fills 0 (testnet thin book).
    // The order DID reach the exchange so signal is EXECUTED; Trade is closed as PHANTOM.
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.getPositions.mockResolvedValue([]);
    exchange.placeMarketOrder.mockResolvedValue("order-zero-fill");
    exchange.getOrderFill.mockResolvedValue({ cumExecQty: 0, avgPrice: 0, status: "Cancelled" });

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await createPendingSignal("BUY");

    await processor.processSignal(signal);

    // Signal is EXECUTED — the order reached the exchange
    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    // Trade is created then immediately closed as PHANTOM (0 fill = no real position)
    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade).not.toBeNull();
    expect(trade?.status).toBe("CLOSED");
    expect(trade?.pnlSource).toBe("PHANTOM");
    expect(trade?.pnlUsd).toBe(0);

    // setTradingStop must not be called (no position to protect)
    expect(exchange.setTradingStop).not.toHaveBeenCalled();
  });

  it("non-TP/SL exchange error is NOT retried → signal REJECTED", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001, tickSize: 1 });
    exchange.getMarkPrice.mockResolvedValue(50000);
    exchange.setLeverage.mockResolvedValue(undefined);
    exchange.getPositions.mockResolvedValue([]);
    exchange.placeMarketOrder.mockRejectedValueOnce(new Error("Bybit error 110001: insufficient balance"));

    const processor = new SignalProcessor(testDb, exchange);
    const signal = await createPendingSignal("BUY");

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("REJECTED");
    expect(updated.rejectionReason).toMatch(/insufficient balance/);
    // Only one attempt — no retry for non-price errors
    expect(exchange.placeMarketOrder).toHaveBeenCalledTimes(1);
  });

  it("BUY signal in dry-run mode → EXECUTED with synthetic Trade, no exchange call", async () => {
    const dryBot = await testDb.bot.create({
      data: {
        name: "Dry Run Bot",
        symbol: "BTCUSDT",
        enabled: true,
        dryRun: true,
        maxPositionUsd: 100,
        dailyLossLimitUsd: -500,
      },
    });

    const signal = await testDb.signal.create({
      data: {
        botId: dryBot.id,
        webhookId: `wh-${randomUUID()}`,
        action: "BUY",
        payload: JSON.stringify({ symbol: "BTCUSDT", price: 50000 }),
        status: "PENDING",
      },
      include: { bot: true },
    });

    const exchange = makeMockExchange();
    const processor = new SignalProcessor(testDb, exchange);

    await processor.processSignal(signal);

    const updated = await testDb.signal.findUniqueOrThrow({ where: { id: signal.id } });
    expect(updated.status).toBe("EXECUTED");

    const trade = await testDb.trade.findFirst({ where: { signalId: signal.id } });
    expect(trade).not.toBeNull();
    expect(trade?.exchangeOrderId).toMatch(/^dry-/);
    expect(exchange.placeMarketOrder).not.toHaveBeenCalled();
  });
});
