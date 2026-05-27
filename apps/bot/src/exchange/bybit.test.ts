import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../env.js", () => ({
  env: {
    BYBIT_API_KEY: "test_key",
    BYBIT_API_SECRET: "test_secret",
    BYBIT_TESTNET: true,
  },
}));

// Keep references to the mock functions so individual tests can override them.
const mockGetExecutionList = vi.fn();
const mockGetClosedPnL = vi.fn();

vi.mock("bybit-api", () => ({
  RestClientV5: vi.fn(() => ({
    getExecutionList: mockGetExecutionList,
    getClosedPnL: mockGetClosedPnL,
    getServerTime: vi.fn().mockResolvedValue({ retCode: 0, result: { timeNano: String(Date.now() * 1_000_000) } }),
  })),
  WebsocketClient: vi.fn(() => ({
    on: vi.fn(),
    subscribeV5: vi.fn(),
    closeAll: vi.fn(),
  })),
}));

// Import after mocks are established
const { BybitClient } = await import("./bybit.js");

// ── helpers ──────────────────────────────────────────────────────────────────

function execFillRaw(overrides: Record<string, string> = {}) {
  return {
    orderId: "ord-1",
    execId: "exec-1",
    symbol: "XRPUSDT",
    side: "Buy",
    execPrice: "3.00",
    execQty: "100",
    execFee: "0.15",
    execTime: "1716480000000",
    closedSize: "100",
    ...overrides,
  };
}

function closedPnLRaw(overrides: Record<string, string> = {}) {
  return {
    orderId: "ord-1",
    symbol: "XRPUSDT",
    side: "Sell",
    qty: "100",
    avgEntryPrice: "3.00",
    avgExitPrice: "2.90",
    closedPnl: "9.85",
    openFee: "0.10",
    closeFee: "0.05",
    createdTime: "1716480000000",
    updatedTime: "1716480060000",
    ...overrides,
  };
}

function okPage(list: unknown[], nextPageCursor = "") {
  return { retCode: 0, result: { list, nextPageCursor } };
}

// ── getExecutionList ──────────────────────────────────────────────────────────

describe("getExecutionList", () => {
  let client: InstanceType<typeof BybitClient>;

  beforeEach(() => {
    client = new BybitClient();
    vi.clearAllMocks();
  });

  it("returns mapped fills from a single page", async () => {
    mockGetExecutionList.mockResolvedValueOnce(okPage([execFillRaw()]));

    const fills = await client.getExecutionList({ symbol: "XRPUSDT" });

    expect(fills).toHaveLength(1);
    expect(fills[0]).toEqual({
      orderId: "ord-1",
      execId: "exec-1",
      symbol: "XRPUSDT",
      side: "Buy",
      execPrice: 3,
      execQty: 100,
      execFee: 0.15,
      execTime: 1716480000000,
      closedSize: 100,
    });
  });

  it("paginates across multiple pages when no limit is specified", async () => {
    mockGetExecutionList
      .mockResolvedValueOnce(okPage([execFillRaw({ execId: "exec-1" })], "cursor-page2"))
      .mockResolvedValueOnce(okPage([execFillRaw({ execId: "exec-2" })], ""));

    const fills = await client.getExecutionList({ symbol: "XRPUSDT" });

    expect(fills).toHaveLength(2);
    expect(fills[0].execId).toBe("exec-1");
    expect(fills[1].execId).toBe("exec-2");
    // Second call should carry the cursor
    expect(mockGetExecutionList).toHaveBeenCalledTimes(2);
    expect(mockGetExecutionList.mock.calls[1][0]).toMatchObject({ cursor: "cursor-page2" });
  });

  it("stops after the first page when limit is specified", async () => {
    mockGetExecutionList.mockResolvedValueOnce(
      okPage([execFillRaw({ execId: "exec-1" }), execFillRaw({ execId: "exec-2" })], "cursor-page2")
    );

    const fills = await client.getExecutionList({ symbol: "XRPUSDT", limit: 20 });

    expect(fills).toHaveLength(2);
    // Should NOT make a second call even though cursor was present
    expect(mockGetExecutionList).toHaveBeenCalledTimes(1);
  });

  it("throws when retCode is non-zero", async () => {
    mockGetExecutionList.mockResolvedValueOnce({
      retCode: 10001,
      retMsg: "Invalid parameter",
      result: { list: [], nextPageCursor: "" },
    });

    await expect(client.getExecutionList({ symbol: "XRPUSDT" })).rejects.toThrow(
      /Bybit error 10001/
    );
  });

  it("retries on network errors", async () => {
    const networkErr = Object.assign(new Error("ECONNRESET socket hang up"), { code: "ECONNRESET" });
    mockGetExecutionList
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(okPage([execFillRaw()]));

    const fills = await client.getExecutionList({ symbol: "XRPUSDT" });

    expect(fills).toHaveLength(1);
    expect(mockGetExecutionList).toHaveBeenCalledTimes(2);
  }, 15_000); // allow retry delay

  it("gives up after exhausting retries", async () => {
    const networkErr = Object.assign(new Error("ECONNRESET"), { code: "ECONNRESET" });
    mockGetExecutionList.mockRejectedValue(networkErr);

    await expect(client.getExecutionList({ symbol: "XRPUSDT" })).rejects.toThrow("ECONNRESET");
    // 4 total attempts: 1 initial + 3 retries
    expect(mockGetExecutionList.mock.calls.length).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it("passes through all filter params", async () => {
    mockGetExecutionList.mockResolvedValueOnce(okPage([]));

    await client.getExecutionList({ symbol: "BTCUSDT", orderId: "ord-99", startTime: 1000, endTime: 2000, limit: 10 });

    expect(mockGetExecutionList).toHaveBeenCalledWith(
      expect.objectContaining({ category: "linear", symbol: "BTCUSDT", orderId: "ord-99", startTime: 1000, endTime: 2000, limit: 10 })
    );
  });

  it("returns empty array for empty page", async () => {
    mockGetExecutionList.mockResolvedValueOnce(okPage([]));

    const fills = await client.getExecutionList({ symbol: "XRPUSDT" });
    expect(fills).toHaveLength(0);
  });
});

// ── getClosedPnL ──────────────────────────────────────────────────────────────

describe("getClosedPnL", () => {
  let client: InstanceType<typeof BybitClient>;

  beforeEach(() => {
    client = new BybitClient();
    vi.clearAllMocks();
  });

  it("returns mapped entries from a single page", async () => {
    mockGetClosedPnL.mockResolvedValueOnce(okPage([closedPnLRaw()]));

    const entries = await client.getClosedPnL({ symbol: "XRPUSDT" });

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      orderId: "ord-1",
      symbol: "XRPUSDT",
      side: "Sell",
      qty: 100,
      avgEntryPrice: 3,
      avgExitPrice: 2.9,
      closedPnl: 9.85,
      openFee: 0.1,
      closeFee: 0.05,
      createdTime: 1716480000000,
      updatedTime: 1716480060000,
    });
  });

  it("paginates when no limit specified", async () => {
    mockGetClosedPnL
      .mockResolvedValueOnce(okPage([closedPnLRaw({ orderId: "ord-1" })], "cur-p2"))
      .mockResolvedValueOnce(okPage([closedPnLRaw({ orderId: "ord-2" })], ""));

    const entries = await client.getClosedPnL({ symbol: "XRPUSDT" });

    expect(entries).toHaveLength(2);
    expect(mockGetClosedPnL).toHaveBeenCalledTimes(2);
  });

  it("stops after first page when limit is specified", async () => {
    mockGetClosedPnL.mockResolvedValueOnce(okPage([closedPnLRaw()], "cur-p2"));

    await client.getClosedPnL({ symbol: "XRPUSDT", limit: 5 });

    expect(mockGetClosedPnL).toHaveBeenCalledTimes(1);
  });

  it("throws when retCode is non-zero", async () => {
    mockGetClosedPnL.mockResolvedValueOnce({
      retCode: 10002,
      retMsg: "Request failed",
      result: { list: [], nextPageCursor: "" },
    });

    await expect(client.getClosedPnL({ symbol: "XRPUSDT" })).rejects.toThrow(/Bybit error 10002/);
  });

  it("retries once on network error before succeeding", async () => {
    const networkErr = new Error("ETIMEDOUT connection timed out");
    mockGetClosedPnL
      .mockRejectedValueOnce(networkErr)
      .mockResolvedValueOnce(okPage([closedPnLRaw()]));

    const entries = await client.getClosedPnL({ symbol: "XRPUSDT" });

    expect(entries).toHaveLength(1);
    expect(mockGetClosedPnL).toHaveBeenCalledTimes(2);
  }, 15_000);

  it("does not retry non-network errors", async () => {
    const apiErr = { retCode: 10003, retMsg: "Forbidden" };
    mockGetClosedPnL.mockResolvedValue({ ...apiErr, result: { list: [], nextPageCursor: "" } });

    await expect(client.getClosedPnL({})).rejects.toThrow(/Bybit error 10003/);
    // Should not retry — only one call
    expect(mockGetClosedPnL).toHaveBeenCalledTimes(1);
  });
});
