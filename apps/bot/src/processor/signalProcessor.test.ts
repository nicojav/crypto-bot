import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { SignalProcessor, type Exchange } from "./signalProcessor.js";

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

function makeMockExchange(): Exchange & { [K in keyof Exchange]: ReturnType<typeof vi.fn> } {
  return {
    getMarkPrice: vi.fn(),
    getPositions: vi.fn(),
    getInstrumentInfo: vi.fn(),
    setLeverage: vi.fn(),
    placeMarketOrder: vi.fn(),
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

describe("SignalProcessor", () => {
  it("BUY signal (live mode) → EXECUTED with Trade row", async () => {
    const exchange = makeMockExchange();
    exchange.getInstrumentInfo.mockResolvedValue({ lotSize: 0.001, minQty: 0.001 });
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
