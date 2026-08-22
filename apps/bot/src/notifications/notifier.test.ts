import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventBus } from "../eventBus.js";
import { Notifier } from "./notifier.js";

vi.mock("../env.js", () => ({
  env: {
    TELEGRAM_BOT_TOKEN: "test-token",
    TELEGRAM_CHAT_ID: "123456",
    DAILY_SUMMARY_HOUR_UTC: 8,
  },
}));

// Minimal stub that satisfies the Prisma queries Notifier makes
function makeDb(overrides: Partial<{ trades: object[]; balance: object | null }> = {}) {
  const trades = overrides.trades ?? [];
  const balance = overrides.balance ?? null;
  return {
    trade: { findMany: vi.fn().mockResolvedValue(trades) },
    balanceSnapshot: { findFirst: vi.fn().mockResolvedValue(balance) },
  };
}

function mockFetch(ok = true, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status,
    text: vi.fn().mockResolvedValue("Telegram error body"),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function sentText(fetchMock: ReturnType<typeof vi.fn>, callIndex = 0): string {
  const body = JSON.parse(fetchMock.mock.calls[callIndex][1].body as string) as { text: string };
  return body.text;
}

describe("Notifier", () => {
  let bus: EventBus;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    bus = new EventBus();
    fetchMock = mockFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends trade.opened message", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "trade.opened", data: { tradeId: 1, botId: 1, symbol: "BTCUSDT", side: "BUY", qty: 0.01, entryPrice: 50000 } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    expect(sentText(fetchMock)).toContain("Trade opened");
    expect(sentText(fetchMock)).toContain("BUY");
    expect(sentText(fetchMock)).toContain("BTCUSDT");
    expect(sentText(fetchMock)).toContain("50000.00");
    notifier.stop();
  });

  it("sends trade.closed message with positive PnL", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "trade.closed", data: { tradeId: 1, botId: 1, symbol: "ETHUSDT", pnlUsd: 42.5 } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    const text = sentText(fetchMock);
    expect(text).toContain("Trade closed");
    expect(text).toContain("ETHUSDT");
    expect(text).toContain("+42.50 USDT");
    notifier.stop();
  });

  it("sends trade.closed message with negative PnL", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "trade.closed", data: { tradeId: 2, botId: 1, symbol: "BTCUSDT", pnlUsd: -15.0 } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    const text = sentText(fetchMock);
    expect(text).toContain("-15.00 USDT");
    notifier.stop();
  });

  it("sends kill switch message for disabled-bot rejection", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "signal.rejected", data: { signalId: 7, botId: 1, reason: "Bot is disabled (kill switch)" } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    const text = sentText(fetchMock);
    expect(text).toContain("Kill switch");
    expect(text).toContain("Signal #7");
    notifier.stop();
  });

  it("sends daily-loss-limit message for loss-limit rejection", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "signal.rejected", data: { signalId: 8, botId: 1, reason: "Daily loss limit reached (-600 USD < limit -500 USD)" } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    const text = sentText(fetchMock);
    expect(text).toContain("Daily loss limit");
    notifier.stop();
  });

  it("sends generic rejected message for other rejections", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "signal.rejected", data: { signalId: 9, botId: 1, reason: "Calculated qty 0 is below minQty 0.001" } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    const text = sentText(fetchMock);
    expect(text).toContain("Signal #9 rejected");
    notifier.stop();
  });

  it("sends ws.reconnected message when disconnect was ≥30s", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "ws.reconnected", data: { disconnectedMs: 45_000 } });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    expect(sentText(fetchMock)).toContain("45s");
    notifier.stop();
  });

  it("does NOT send ws.reconnected message when disconnect was <30s", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "ws.reconnected", data: { disconnectedMs: 10_000 } });
    // Give the async handler time to run
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).not.toHaveBeenCalled();
    notifier.stop();
  });

  it("sends storage.critical message with GB usage and percent", async () => {
    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({
      type: "storage.critical",
      data: { dbSizeBytes: 912_680_550, volumeSizeBytes: 1_073_741_824, percentUsed: 85.0 },
    });
    await vi.waitUntil(() => fetchMock.mock.calls.length > 0);

    const text = sentText(fetchMock);
    expect(text).toContain("Database storage critical");
    expect(text).toContain("0.85 GB");
    expect(text).toContain("1.00 GB");
    expect(text).toContain("85.0%");
    notifier.stop();
  });

  it("does not call fetch when TELEGRAM_BOT_TOKEN is blank", async () => {
    vi.doMock("../env.js", () => ({
      env: { TELEGRAM_BOT_TOKEN: "", TELEGRAM_CHAT_ID: "", DAILY_SUMMARY_HOUR_UTC: 8 },
    }));
    // Re-import to pick up the blank-token mock
    const { Notifier: N } = await import("./notifier.js?blank");
    const notifier = new N(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "trade.opened", data: { tradeId: 1, botId: 1, symbol: "BTCUSDT", side: "BUY", qty: 0.01, entryPrice: 50000 } });
    await new Promise((r) => setTimeout(r, 50));

    expect(fetchMock).not.toHaveBeenCalled();
    notifier.stop();
    vi.doUnmock("../env.js");
  });

  describe("sendDailySummary", () => {
    it("includes trade count, win rate, PnL, and equity", async () => {
      const trades = [
        { pnlUsd: 100 },
        { pnlUsd: -20 },
        { pnlUsd: 50 },
      ];
      const balance = { equityUsd: 1234.56, availableUsd: 900 };
      const db = makeDb({ trades, balance });

      const notifier = new Notifier(bus, db as never);
      // @ts-expect-error — calling private method directly for testing
      await notifier.sendDailySummary();

      expect(fetchMock).toHaveBeenCalledOnce();
      const text = sentText(fetchMock);
      expect(text).toContain("Daily Summary");
      expect(text).toContain("Trades today: 3");
      expect(text).toContain("66.7%");       // 2/3 wins
      expect(text).toContain("+130.00 USDT"); // 100-20+50
      expect(text).toContain("1234.56 USDT");
    });

    it("handles zero trades gracefully", async () => {
      const db = makeDb({ trades: [], balance: null });
      const notifier = new Notifier(bus, db as never);
      // @ts-expect-error — calling private method directly for testing
      await notifier.sendDailySummary();

      const text = sentText(fetchMock);
      expect(text).toContain("Trades today: 0");
      expect(text).toContain("Win rate: —");
      expect(text).toContain("Current equity: —");
    });
  });

  it("logs Telegram API errors without throwing", async () => {
    mockFetch(false, 400); // ok = false, status = 400
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const notifier = new Notifier(bus, makeDb() as never);
    notifier.start();

    bus.publish({ type: "trade.opened", data: { tradeId: 1, botId: 1, symbol: "BTCUSDT", side: "BUY", qty: 0.01, entryPrice: 50000 } });
    await vi.waitUntil(() => consoleSpy.mock.calls.length > 0);

    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("[notifier] Telegram error 400"));
    consoleSpy.mockRestore();
    notifier.stop();
  });
});
