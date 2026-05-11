import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { buildApp } from "../app.js";

const TEST_TOKEN = vi.hoisted(() => "test_api_token_1234567890abcdef");

vi.mock("../env.js", () => ({
  env: {
    WEBHOOK_SECRET: "test_webhook_secret_xyz",
    API_TOKEN: TEST_TOKEN,
    DASHBOARD_ORIGIN: "http://localhost:5173",
    DATABASE_URL: "file:./dev.db",
    PORT: 3000,
    LOG_LEVEL: "error",
    BYBIT_API_KEY: "test",
    BYBIT_API_SECRET: "test",
    BYBIT_TESTNET: true,
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

let testDb: PrismaClient;
let botId: number;
let bot2Id: number;
let testDbPath: string;
let app: ReturnType<typeof buildApp>;

const AUTH = { authorization: `Bearer ${TEST_TOKEN}` };

beforeAll(async () => {
  testDbPath = join(tmpdir(), `test-api-${randomUUID()}.db`);
  const setup = new BetterSqlite3(testDbPath);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${testDbPath}` });
  testDb = new PrismaClient({ adapter });

  const bot = await testDb.bot.create({
    data: { name: "Alpha Bot", symbol: "BTCUSDT", enabled: true, dryRun: true },
  });
  botId = bot.id;

  const bot2 = await testDb.bot.create({
    data: { name: "Beta Bot", symbol: "ETHUSDT", enabled: true, dryRun: false },
  });
  bot2Id = bot2.id;

  app = buildApp(testDb, false);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.$disconnect();
  try { unlinkSync(testDbPath); } catch { /* ignore */ }
});

beforeEach(async () => {
  await testDb.trade.deleteMany();
  await testDb.signal.deleteMany();
  await testDb.balanceSnapshot.deleteMany();
  await testDb.bot.updateMany({ data: { enabled: true } });
});

// ── Auth ─────────────────────────────────────────────────────────────────────

describe("bearer token auth", () => {
  it("missing token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bots" });
    expect(res.statusCode).toBe(401);
  });

  it("wrong token → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bots", headers: { authorization: "Bearer wrong" } });
    expect(res.statusCode).toBe(401);
  });

  it("correct token → not 401", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bots", headers: AUTH });
    expect(res.statusCode).not.toBe(401);
  });
});

// ── GET /api/bots ─────────────────────────────────────────────────────────────

describe("GET /api/bots", () => {
  it("returns all bots with openTradeCount", async () => {
    const signal = await testDb.signal.create({
      data: { botId, webhookId: "wh-open", action: "BUY", payload: "{}", status: "EXECUTED" },
    });
    await testDb.trade.create({
      data: { botId, signalId: signal.id, exchangeOrderId: "ord-1", symbol: "BTCUSDT", side: "BUY", qty: 0.001, entryPrice: 50000, status: "OPEN" },
    });

    const res = await app.inject({ method: "GET", url: "/api/bots", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ id: number; openTradeCount: number }>>();
    const alpha = body.find((b) => b.id === botId);
    expect(alpha?.openTradeCount).toBe(1);
    const beta = body.find((b) => b.id === bot2Id);
    expect(beta?.openTradeCount).toBe(0);
  });
});

// ── GET /api/bots/:id ─────────────────────────────────────────────────────────

describe("GET /api/bots/:id", () => {
  it("returns bot with signals and trades", async () => {
    const signal = await testDb.signal.create({
      data: { botId, webhookId: "wh-detail", action: "BUY", payload: "{}", status: "EXECUTED" },
    });
    await testDb.trade.create({
      data: { botId, signalId: signal.id, exchangeOrderId: "ord-2", symbol: "BTCUSDT", side: "BUY", qty: 0.001, entryPrice: 50000, status: "OPEN" },
    });

    const res = await app.inject({ method: "GET", url: `/api/bots/${botId}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ id: number; signals: unknown[]; trades: unknown[] }>();
    expect(body.id).toBe(botId);
    expect(body.signals.length).toBeGreaterThanOrEqual(1);
    expect(body.trades.length).toBeGreaterThanOrEqual(1);
  });

  it("unknown id → 404", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bots/99999", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });
});

// ── PATCH /api/bots/:id ───────────────────────────────────────────────────────

describe("PATCH /api/bots/:id", () => {
  it("updates allowed fields", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/bots/${botId}`,
      headers: AUTH,
      payload: { enabled: false, maxPositionUsd: 200, maxLeverage: 5 },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ enabled: boolean; maxPositionUsd: number; maxLeverage: number }>();
    expect(body.enabled).toBe(false);
    expect(body.maxPositionUsd).toBe(200);
    expect(body.maxLeverage).toBe(5);
  });

  it("unknown field → 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/bots/${botId}`,
      headers: AUTH,
      payload: { unknownField: true },
    });
    expect(res.statusCode).toBe(400);
  });

  it("empty body → 400", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: `/api/bots/${botId}`,
      headers: AUTH,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it("unknown id → 404", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/bots/99999",
      headers: AUTH,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ── GET /api/trades ───────────────────────────────────────────────────────────

describe("GET /api/trades", () => {
  it("returns all trades without filters", async () => {
    const signal = await testDb.signal.create({
      data: { botId, webhookId: "wh-trade1", action: "BUY", payload: "{}", status: "EXECUTED" },
    });
    await testDb.trade.create({
      data: { botId, signalId: signal.id, exchangeOrderId: "ord-3", symbol: "BTCUSDT", side: "BUY", qty: 0.001, entryPrice: 50000, status: "OPEN" },
    });

    const res = await app.inject({ method: "GET", url: "/api/trades", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<unknown[]>();
    expect(body.length).toBeGreaterThanOrEqual(1);
  });

  it("filters by botId", async () => {
    const signal = await testDb.signal.create({
      data: { botId: bot2Id, webhookId: "wh-trade2", action: "BUY", payload: "{}", status: "EXECUTED" },
    });
    await testDb.trade.create({
      data: { botId: bot2Id, signalId: signal.id, exchangeOrderId: "ord-4", symbol: "ETHUSDT", side: "BUY", qty: 0.01, entryPrice: 3000, status: "OPEN" },
    });

    const res = await app.inject({ method: "GET", url: `/api/trades?botId=${bot2Id}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ botId: number }>>();
    expect(body.every((t) => t.botId === bot2Id)).toBe(true);
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      const s = await testDb.signal.create({
        data: { botId, webhookId: `wh-lim-${i}`, action: "BUY", payload: "{}", status: "EXECUTED" },
      });
      await testDb.trade.create({
        data: { botId, signalId: s.id, exchangeOrderId: `ord-lim-${i}`, symbol: "BTCUSDT", side: "BUY", qty: 0.001, entryPrice: 50000, status: "CLOSED" },
      });
    }
    const res = await app.inject({ method: "GET", url: "/api/trades?limit=3", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json<unknown[]>().length).toBeLessThanOrEqual(3);
  });
});

// ── GET /api/equity ───────────────────────────────────────────────────────────

describe("GET /api/equity", () => {
  it("returns balance snapshots ordered by time asc", async () => {
    await testDb.balanceSnapshot.create({ data: { equityUsd: 1000, availableUsd: 800 } });
    await testDb.balanceSnapshot.create({ data: { equityUsd: 1050, availableUsd: 850 } });

    const res = await app.inject({ method: "GET", url: "/api/equity", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<Array<{ equityUsd: number }>>();
    expect(body.length).toBeGreaterThanOrEqual(2);
    expect(body[0].equityUsd).toBeLessThanOrEqual(body[body.length - 1].equityUsd);
  });
});

// ── POST /api/kill-switch ─────────────────────────────────────────────────────

describe("POST /api/kill-switch", () => {
  it("disables all enabled bots and returns count", async () => {
    const res = await app.inject({ method: "POST", url: "/api/kill-switch", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ disabled: number }>();
    expect(body.disabled).toBeGreaterThanOrEqual(2);

    const stillEnabled = await testDb.bot.count({ where: { enabled: true } });
    expect(stillEnabled).toBe(0);
  });

  it("returns 0 when all already disabled", async () => {
    await testDb.bot.updateMany({ data: { enabled: false } });
    const res = await app.inject({ method: "POST", url: "/api/kill-switch", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ disabled: number }>().disabled).toBe(0);
  });
});

// ── POST /api/bots ────────────────────────────────────────────────────────────

describe("POST /api/bots", () => {
  it("minimal body (name + symbol) → 201 with correct defaults", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bots", headers: AUTH,
      payload: { name: "New Bot", symbol: "SOLUSDT" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: number; name: string; symbol: string; dryRun: boolean; enabled: boolean; maxPositionUsd: number; maxLeverage: number; dailyLossLimitUsd: number; openTradeCount: number }>();
    expect(body.name).toBe("New Bot");
    expect(body.symbol).toBe("SOLUSDT");
    expect(body.enabled).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.maxPositionUsd).toBe(100);
    expect(body.maxLeverage).toBe(10);
    expect(body.dailyLossLimitUsd).toBe(-500);
    expect(body.openTradeCount).toBe(0);
    await testDb.bot.delete({ where: { id: body.id } });
  });

  it("full body → 201 with provided values", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bots", headers: AUTH,
      payload: { name: "Full Bot", symbol: "ETHUSDT", enabled: false, dryRun: false, maxPositionUsd: 500, maxLeverage: 5, dailyLossLimitUsd: -100 },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: number; enabled: boolean; dryRun: boolean; maxPositionUsd: number }>();
    expect(body.enabled).toBe(false);
    expect(body.dryRun).toBe(false);
    expect(body.maxPositionUsd).toBe(500);
    await testDb.bot.delete({ where: { id: body.id } });
  });

  it("missing name → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bots", headers: AUTH,
      payload: { symbol: "BTCUSDT" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("missing symbol → 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bots", headers: AUTH,
      payload: { name: "No Symbol Bot" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("no auth → 401", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/bots",
      payload: { name: "Unauth Bot", symbol: "BTCUSDT" },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ── CORS ─────────────────────────────────────────────────────────────────────

describe("CORS", () => {
  it("sets Access-Control-Allow-Origin on responses", async () => {
    const res = await app.inject({ method: "GET", url: "/api/bots", headers: AUTH });
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
  });

  it("OPTIONS preflight → 204 with CORS headers", async () => {
    const res = await app.inject({ method: "OPTIONS", url: "/api/bots" });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(res.headers["access-control-allow-methods"]).toContain("GET");
  });
});
