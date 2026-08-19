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
const mockGetActiveOrders = vi.fn();
// Two distinct getKline mocks so tests can assert getKline() is issued against the
// mainnet market-data client (testnet: false, no keys), never the account/testnet client.
const mockGetKlineAccount = vi.fn();
const mockGetKlineMarketData = vi.fn();
// Same split for getFundingRateHistory.
const mockGetFundingRateHistoryAccount = vi.fn();
const mockGetFundingRateHistoryMarketData = vi.fn();

vi.mock("bybit-api", () => ({
  RestClientV5: vi.fn((opts?: { testnet?: boolean }) => {
    const isMarketDataClient = opts?.testnet === false;
    return {
      getExecutionList: mockGetExecutionList,
      getClosedPnL: mockGetClosedPnL,
      getActiveOrders: mockGetActiveOrders,
      getServerTime: vi.fn().mockResolvedValue({ retCode: 0, result: { timeNano: String(Date.now() * 1_000_000) } }),
      getKline: isMarketDataClient ? mockGetKlineMarketData : mockGetKlineAccount,
      getFundingRateHistory: isMarketDataClient ? mockGetFundingRateHistoryMarketData : mockGetFundingRateHistoryAccount,
    };
  }),
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

// ── getOrderFill ────────────────────────────────────────────────────────────

function activeOrderRaw(overrides: Record<string, string> = {}) {
  return {
    cumExecQty: "0",
    avgPrice: "0",
    orderStatus: "New",
    ...overrides,
  };
}

describe("getOrderFill", () => {
  let client: InstanceType<typeof BybitClient>;

  beforeEach(() => {
    client = new BybitClient();
    vi.clearAllMocks();
  });

  it("returns immediately when the order is already Filled", async () => {
    mockGetActiveOrders.mockResolvedValueOnce(
      okPage([activeOrderRaw({ orderStatus: "Filled", cumExecQty: "30.8", avgPrice: "80.5" })])
    );

    const fill = await client.getOrderFill("SOLUSDT", "ord-1");

    expect(fill).toEqual({ cumExecQty: 30.8, avgPrice: 80.5, status: "Filled" });
    expect(mockGetActiveOrders).toHaveBeenCalledTimes(1);
  });

  it("regression: waits for a terminal status instead of returning on first visibility (premature zero-read)", async () => {
    // First read: order visible but still "New" with cumExecQty=0 — must NOT be
    // treated as a genuine zero-fill. Second read: reaches Filled with the real qty.
    mockGetActiveOrders
      .mockResolvedValueOnce(okPage([activeOrderRaw({ orderStatus: "New", cumExecQty: "0" })]))
      .mockResolvedValueOnce(okPage([activeOrderRaw({ orderStatus: "Filled", cumExecQty: "30.8", avgPrice: "80.5" })]));

    const fill = await client.getOrderFill("SOLUSDT", "ord-1");

    expect(fill).toEqual({ cumExecQty: 30.8, avgPrice: 80.5, status: "Filled" });
    expect(mockGetActiveOrders).toHaveBeenCalledTimes(2);
  }, 10_000);

  it("returns correctly on a genuine zero-fill (terminal Cancelled status)", async () => {
    mockGetActiveOrders.mockResolvedValueOnce(
      okPage([activeOrderRaw({ orderStatus: "Cancelled", cumExecQty: "0" })])
    );

    const fill = await client.getOrderFill("SOLUSDT", "ord-1");

    expect(fill).toEqual({ cumExecQty: 0, avgPrice: 0, status: "Cancelled" });
  });

  it("throws after exhausting attempts if the order never reaches a terminal status", async () => {
    mockGetActiveOrders.mockResolvedValue(okPage([activeOrderRaw({ orderStatus: "PartiallyFilled", cumExecQty: "10" })]));

    await expect(client.getOrderFill("SOLUSDT", "ord-1")).rejects.toThrow(/never reached a terminal status/);
    expect(mockGetActiveOrders).toHaveBeenCalledTimes(6);
  }, 10_000);

  it("throws after exhausting attempts if the order is never visible", async () => {
    mockGetActiveOrders.mockResolvedValue(okPage([]));

    await expect(client.getOrderFill("SOLUSDT", "ord-1")).rejects.toThrow(/Order not found after 6 attempts/);
  }, 10_000);
});

describe("getKline", () => {
  let client: InstanceType<typeof BybitClient>;

  beforeEach(() => {
    client = new BybitClient();
    vi.clearAllMocks();
  });

  it("issues the request against the mainnet market-data client, never the account/testnet client", async () => {
    mockGetKlineMarketData.mockResolvedValueOnce(
      okPage([["1700000000000", "100", "101", "99", "100.5", "10", "1000"]])
    );

    const klines = await client.getKline("BTCUSDT", "1d", 1_700_000_000_000, 1_700_000_000_000);

    expect(mockGetKlineMarketData).toHaveBeenCalledTimes(1);
    expect(mockGetKlineMarketData).toHaveBeenCalledWith({
      category: "linear", symbol: "BTCUSDT", interval: "D", start: 1_700_000_000_000, end: 1_700_000_000_000, limit: 1000,
    });
    expect(mockGetKlineAccount).not.toHaveBeenCalled();
    expect(klines).toEqual([{ openTime: 1_700_000_000_000, open: 100, high: 101, low: 99, close: 100.5, volume: 10 }]);
  });

  it("paginates forward across multiple 1000-row pages", async () => {
    const intervalMs = 24 * 60 * 60 * 1000;
    const fullPage = Array.from({ length: 1000 }, (_, i) => [
      String(1_700_000_000_000 + i * intervalMs), "100", "101", "99", "100.5", "10", "1000",
    ]);
    const lastPage = [["1700086400000", "100", "101", "99", "100.5", "10", "1000"]];
    mockGetKlineMarketData
      .mockResolvedValueOnce(okPage(fullPage))
      .mockResolvedValueOnce(okPage(lastPage));

    const klines = await client.getKline("BTCUSDT", "1d", 1_700_000_000_000, 1_700_000_000_000 + 1001 * intervalMs);

    expect(mockGetKlineMarketData).toHaveBeenCalledTimes(2);
    expect(klines.length).toBeGreaterThan(1000);
  });
});

describe("getFundingHistory", () => {
  let client: InstanceType<typeof BybitClient>;

  beforeEach(() => {
    client = new BybitClient();
    vi.clearAllMocks();
  });

  it("issues the request against the mainnet market-data client, never the account/testnet client", async () => {
    mockGetFundingRateHistoryMarketData.mockResolvedValueOnce(
      okPage([{ symbol: "BTCUSDT", fundingRate: "0.0001", fundingRateTimestamp: "1700000000000" }])
    );

    const rates = await client.getFundingHistory("BTCUSDT", 1_700_000_000_000, 1_700_000_000_000);

    expect(mockGetFundingRateHistoryMarketData).toHaveBeenCalledTimes(1);
    expect(mockGetFundingRateHistoryMarketData).toHaveBeenCalledWith({
      category: "linear", symbol: "BTCUSDT", startTime: 1_700_000_000_000, endTime: 1_700_000_000_000, limit: 200,
    });
    expect(mockGetFundingRateHistoryAccount).not.toHaveBeenCalled();
    expect(rates).toEqual([{ fundingTime: 1_700_000_000_000, fundingRate: 0.0001 }]);
  });

  it("paginates forward across multiple 200-row pages, cursoring by the last timestamp + 1ms", async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({
      symbol: "BTCUSDT", fundingRate: "0.0001", fundingRateTimestamp: String(1_700_000_000_000 + i * 60_000),
    }));
    const lastPage = [{ symbol: "BTCUSDT", fundingRate: "0.0002", fundingRateTimestamp: "1700000012000000" }];
    mockGetFundingRateHistoryMarketData
      .mockResolvedValueOnce(okPage(fullPage))
      .mockResolvedValueOnce(okPage(lastPage));

    const rates = await client.getFundingHistory("BTCUSDT", 1_700_000_000_000, 1_700_000_020_000_000);

    expect(mockGetFundingRateHistoryMarketData).toHaveBeenCalledTimes(2);
    const secondCallArgs = mockGetFundingRateHistoryMarketData.mock.calls[1]![0] as { startTime: number };
    expect(secondCallArgs.startTime).toBe(1_700_000_000_000 + 199 * 60_000 + 1);
    expect(rates.length).toBe(201);
  });

  it("returns an empty array when there's nothing in range", async () => {
    mockGetFundingRateHistoryMarketData.mockResolvedValueOnce(okPage([]));
    const rates = await client.getFundingHistory("BTCUSDT", 1_700_000_000_000, 1_700_000_000_000);
    expect(rates).toEqual([]);
  });
});
