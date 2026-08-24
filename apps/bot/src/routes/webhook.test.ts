import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { readdirSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "../generated/prisma/client.js";
import { buildApp } from "../app.js";

const TEST_SECRET = vi.hoisted(() => "test_webhook_secret_xyz");

vi.mock("../env.js", () => ({
  env: {
    WEBHOOK_SECRET: TEST_SECRET,
    API_TOKEN: "test_api_token_1234567890",
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
let testDbPath: string;
let app: ReturnType<typeof buildApp>;

beforeAll(async () => {
  // Apply schema to a temp file, then hand the path to Prisma
  testDbPath = join(tmpdir(), `test-bot-${randomUUID()}.db`);
  const setup = new BetterSqlite3(testDbPath);
  setup.exec(MIGRATION_SQL);
  setup.close();

  const adapter = new PrismaBetterSqlite3({ url: `file:${testDbPath}` });
  testDb = new PrismaClient({ adapter });

  const bot = await testDb.bot.create({
    data: { name: "Test Bot", symbol: "BTCUSDT", enabled: true, dryRun: true },
  });
  botId = bot.id;

  app = buildApp(testDb, false);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await testDb.$disconnect();
  try { unlinkSync(testDbPath); } catch { /* ignore */ }
});

beforeEach(async () => {
  await testDb.signal.deleteMany();
});

const validBody = () => ({
  secret: TEST_SECRET,
  webhookId: `wh-${Math.random()}`,
  action: "BUY" as const,
  symbol: "BTCUSDT",
  price: 50000,
});

describe("POST /webhook/:botId", () => {
  it("valid signal → 202 and creates a PENDING signal row", async () => {
    const body = validBody();
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: body,
    });

    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "ACCEPTED" });

    const signal = await testDb.signal.findUnique({ where: { webhookId: body.webhookId } });
    expect(signal).not.toBeNull();
    expect(signal?.status).toBe("PENDING");
    expect(signal?.action).toBe("BUY");
    expect(signal?.botId).toBe(botId);
  });

  it("duplicate webhookId → 200 DUPLICATE without error", async () => {
    const body = validBody();
    await app.inject({ method: "POST", url: `/webhook/${botId}`, payload: body });
    const res = await app.inject({ method: "POST", url: `/webhook/${botId}`, payload: body });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "DUPLICATE" });

    const count = await testDb.signal.count({ where: { webhookId: body.webhookId } });
    expect(count).toBe(1);
  });

  it("bad secret → 401", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: { ...validBody(), secret: "wrong_secret_value" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("unknown botId → 404", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/webhook/99999",
      payload: validBody(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("disabled bot → 404", async () => {
    const disabled = await testDb.bot.create({
      data: { name: "Disabled Bot", symbol: "ETHUSDT", enabled: false, dryRun: true },
    });
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${disabled.id}`,
      payload: validBody(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("malformed payload (missing action) → 400", async () => {
    const { action: _action, ...noAction } = validBody();
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: noAction,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("Invalid payload");
  });

  it("malformed payload (invalid action value) → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: { ...validBody(), action: "HOLD" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("TradingView lowercase 'buy' → 202 stored as BUY", async () => {
    const body = { ...validBody(), action: "buy", webhookId: `tv-buy-${Math.random()}` };
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const signal = await testDb.signal.findUnique({ where: { webhookId: body.webhookId } });
    expect(signal?.action).toBe("BUY");
  });

  it("TradingView lowercase 'sell' → 202 stored as SELL", async () => {
    const body = { ...validBody(), action: "sell", webhookId: `tv-sell-${Math.random()}` };
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const signal = await testDb.signal.findUnique({ where: { webhookId: body.webhookId } });
    expect(signal?.action).toBe("SELL");
  });

  it("lowercase 'close' → 202 stored as CLOSE", async () => {
    const body = { ...validBody(), action: "close", webhookId: `tv-close-${Math.random()}` };
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    const signal = await testDb.signal.findUnique({ where: { webhookId: body.webhookId } });
    expect(signal?.action).toBe("CLOSE");
  });

  // Regression guard: tpPct/slPct is the preferred bracket path for all current Pine
  // strategies (see SignalProcessor), but the schema previously only accepted absolute
  // takeProfit/stopLoss — zod's default (non-strict) object silently stripped tpPct/slPct
  // on the way in, so every live signal from those strategies placed a naked order.
  it("tpPct/slPct → 202 and persisted into signal.payload", async () => {
    const body = { ...validBody(), tpPct: 12.3456, slPct: 2.4691, webhookId: `tv-tpsl-${Math.random()}` };
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: body,
    });
    expect(res.statusCode).toBe(202);

    const signal = await testDb.signal.findUnique({ where: { webhookId: body.webhookId } });
    const payload = JSON.parse(signal!.payload!);
    expect(payload.tpPct).toBe(12.3456);
    expect(payload.slPct).toBe(2.4691);
  });

  it("no bracket fields → tpPct/slPct absent from signal.payload", async () => {
    const body = validBody();
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: body,
    });
    expect(res.statusCode).toBe(202);

    const signal = await testDb.signal.findUnique({ where: { webhookId: body.webhookId } });
    const payload = JSON.parse(signal!.payload!);
    expect(payload.tpPct).toBeUndefined();
    expect(payload.slPct).toBeUndefined();
  });

  it("negative tpPct → 400", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/webhook/${botId}`,
      payload: { ...validBody(), tpPct: -1 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("GET /health", () => {
  it("returns 200 ok", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });
});
