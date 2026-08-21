import { RestClientV5, type KlineIntervalV3 } from "bybit-api";

import { env } from "../env.js";

// Timeframes supported by the backtesting tool, mapped to Bybit's kline interval codes.
export type TimeframeId = "5m" | "15m" | "4h" | "1d" | "1w";

const BYBIT_INTERVAL: Record<TimeframeId, KlineIntervalV3> = {
  "5m": "5",
  "15m": "15",
  "4h": "240",
  "1d": "D",
  "1w": "W",
};

export const TIMEFRAME_MS: Record<TimeframeId, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000,
  "1w": 7 * 24 * 60 * 60_000,
};

export interface Balance {
  equity: number;
  available: number;
  coin: string;
}

export interface Position {
  symbol: string;
  side: "Buy" | "Sell" | "None";
  size: number;
  entryPrice: number;
  markPrice: number;
  unrealisedPnl: number;
}

export interface InstrumentInfo {
  symbol: string;
  tickSize: number;
  lotSize: number;
  minQty: number;
  maxQty: number;
}

export interface ExecutionFill {
  orderId: string;
  execId: string;
  symbol: string;
  side: string;
  execPrice: number;
  execQty: number;
  execFee: number;
  execTime: number;
  closedSize: number;
}

export interface Kline {
  openTime: number; // ms epoch
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FundingRateEntry {
  fundingTime: number; // ms epoch
  fundingRate: number; // e.g. 0.0001 = 0.01%; positive = longs pay shorts
}

export interface ClosedPnLEntry {
  orderId: string;
  symbol: string;
  side: string;
  qty: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  closedPnl: number;
  openFee: number;
  closeFee: number;
  createdTime: number;
  updatedTime: number;
}

const RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

// Terminal order states for IOC/market orders — once reached, cumExecQty is final.
// "New"/"PartiallyFilled"/"Untriggered" mean the order may still fill further.
const TERMINAL_ORDER_STATUSES = new Set(["Filled", "Cancelled", "Rejected", "PartiallyFilledCanceled"]);

function isNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return (
    msg.includes("econnreset") ||
    msg.includes("etimedout") ||
    msg.includes("enotfound") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  );
}

// Bybit's rate-limit retCode (10006, "too many visits") surfaces as a normal 200 response with a
// non-zero retCode, not a thrown network error — bybitError() turns that into an
// Error("Bybit error 10006: ..."), which is what this matches on. The 429/"too many requests"
// text checks are a fallback for the rare case the SDK's HTTP layer throws before a retCode is
// ever parsed (a hard proxy/gateway-level rate limit rather than Bybit's own API response).
function isRateLimitError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  return msg.includes("bybit error 10006") || msg.includes("429") || msg.includes("too many");
}

function isRetryable(err: unknown): boolean {
  return isNetworkError(err) || isRateLimitError(err);
}

async function withRetry<T>(fn: () => Promise<T>, retryable: (err: unknown) => boolean = isNetworkError): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!retryable(err) || attempt === RETRY_DELAYS_MS.length) break;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[bybit] retryable error, retry ${attempt + 1} in ${delay}ms:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Gap between consecutive pagination requests in getKline/getFundingHistory — these are the only
// methods that can fire dozens to hundreds of sequential requests for a single call (a multi-year
// 5m backtest window), so they're the only ones that need proactive throttling on top of the
// retryable-429 handling above.
const PAGINATION_DELAY_MS = 150;

function bybitError(err: unknown): never {
  if (err && typeof err === "object" && "retCode" in err) {
    const e = err as { retCode: number; retMsg: string };
    throw new Error(`Bybit error ${e.retCode}: ${e.retMsg}`);
  }
  throw err;
}

export class BybitClient {
  private client: RestClientV5;
  // Historical klines must reflect real prices regardless of which environment the account
  // trades in — Bybit's testnet market data is synthetic and not representative (observed
  // >100% average daily moves). getKline() is the only method that uses this client; every
  // other (account-scoped) method stays on `client` above. No API keys needed — the v5
  // market-data kline endpoint is public/unauthenticated.
  private marketDataClient: RestClientV5;

  constructor() {
    this.client = new RestClientV5({
      key: env.BYBIT_API_KEY,
      secret: env.BYBIT_API_SECRET,
      testnet: env.BYBIT_TESTNET,
    });
    this.marketDataClient = new RestClientV5({ testnet: false });
  }

  async checkClockDrift(): Promise<void> {
    const res = await withRetry(() => this.client.getServerTime());
    if (res.retCode !== 0) bybitError(res);
    const serverMs = Number(res.result.timeNano) / 1_000_000;
    const localMs = Date.now();
    const driftMs = Math.abs(serverMs - localMs);
    if (driftMs > 2_000) {
      console.warn(`[bybit] WARNING: clock drift is ${Math.round(driftMs)}ms — this may cause signature errors`);
    } else {
      console.log(`[bybit] clock drift: ${Math.round(driftMs)}ms (OK)`);
    }
  }

  async getBalance(coin = "USDT"): Promise<Balance> {
    const res = await withRetry(() =>
      this.client.getWalletBalance({ accountType: "UNIFIED", coin })
    );
    if (res.retCode !== 0) bybitError(res);

    const account = res.result.list[0];
    const coinData = account?.coin.find((c) => c.coin === coin);

    const equity = Number(coinData?.equity);
    if (!Number.isFinite(equity) || equity < 0) {
      throw new Error(
        `getBalance: received invalid equity for ${coin}: ${String(coinData?.equity)} — Bybit may have returned an empty or malformed account payload`
      );
    }

    return {
      coin,
      equity,
      available: Number(coinData?.walletBalance ?? 0),
    };
  }

  async getPositions(symbol: string): Promise<Position[]> {
    const res = await withRetry(() =>
      this.client.getPositionInfo({ category: "linear", symbol })
    );
    if (res.retCode !== 0) bybitError(res);

    return res.result.list.map((p) => ({
      symbol: p.symbol,
      side: p.side as "Buy" | "Sell" | "None",
      size: Number(p.size),
      entryPrice: Number(p.avgPrice),
      markPrice: Number(p.markPrice),
      unrealisedPnl: Number(p.unrealisedPnl),
    }));
  }

  /** Returns all active linear perpetual positions across all symbols (for reconciliation). */
  async getAllPositions(): Promise<Position[]> {
    const res = await withRetry(() =>
      this.client.getPositionInfo({ category: "linear", settleCoin: "USDT" })
    );
    if (res.retCode !== 0) bybitError(res);

    return res.result.list
      .filter((p) => Number(p.size) > 0)
      .map((p) => ({
        symbol: p.symbol,
        side: p.side as "Buy" | "Sell" | "None",
        size: Number(p.size),
        entryPrice: Number(p.avgPrice),
        markPrice: Number(p.markPrice),
        unrealisedPnl: Number(p.unrealisedPnl),
      }));
  }

  async cancelOrder(symbol: string, orderId: string): Promise<void> {
    const res = await withRetry(() =>
      this.client.cancelOrder({ category: "linear", symbol, orderId })
    );
    if (res.retCode !== 0) bybitError(res);
  }

  async getMarkPrice(symbol: string): Promise<number> {
    const res = await withRetry(() =>
      this.client.getTickers({ category: "linear", symbol })
    );
    if (res.retCode !== 0) bybitError(res);
    const ticker = res.result.list[0] as { markPrice: string } | undefined;
    if (!ticker) throw new Error(`No ticker found for ${symbol}`);
    return Number(ticker.markPrice);
  }

  async setLeverage(symbol: string, leverage: number): Promise<void> {
    const res = await this.client.setLeverage({
      category: "linear",
      symbol,
      buyLeverage: String(leverage),
      sellLeverage: String(leverage),
    });
    // 110043 = leverage not modified (already at requested value)
    if (res.retCode !== 0 && res.retCode !== 110043) bybitError(res);
  }

  async placeMarketOrder(params: {
    symbol: string;
    side: "Buy" | "Sell";
    qty: number;
    reduceOnly: boolean;
  }): Promise<string> {
    // No retry on order placement — partial fills and duplicates are dangerous.
    // TP/SL is set separately via setTradingStop after the position is confirmed.
    const res = await this.client.submitOrder({
      category: "linear",
      symbol: params.symbol,
      side: params.side,
      orderType: "Market",
      qty: String(params.qty),
      reduceOnly: params.reduceOnly,
    });
    if (res.retCode !== 0) bybitError(res);
    return res.result.orderId;
  }

  /**
   * Read the fill details of a just-placed order via the realtime endpoint.
   * getActiveOrders sees orders immediately; getHistoricOrders has a write-behind lag
   * that caused "Order not found" errors right after submitOrder returned.
   * Retries briefly because the order may not register on the first tick after placement.
   */
  async getOrderFill(symbol: string, orderId: string): Promise<{ cumExecQty: number; avgPrice: number; status: string }> {
    const ATTEMPTS = 6;
    const DELAY_MS = 250;
    let lastSeen: { cumExecQty: string; avgPrice: string; orderStatus: string } | undefined;
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
      const res = await withRetry(() =>
        this.client.getActiveOrders({ category: "linear", symbol, orderId })
      );
      if (res.retCode !== 0) bybitError(res);
      const order = res.result.list[0] as
        | { cumExecQty: string; avgPrice: string; orderStatus: string }
        | undefined;
      if (order) {
        if (TERMINAL_ORDER_STATUSES.has(order.orderStatus)) {
          return {
            cumExecQty: Number(order.cumExecQty),
            avgPrice: Number(order.avgPrice),
            status: order.orderStatus,
          };
        }
        lastSeen = order;
        console.warn(`[bybit] getOrderFill: ${orderId} not yet terminal (status=${order.orderStatus}, attempt ${attempt + 1}/${ATTEMPTS})`);
      } else {
        console.warn(`[bybit] getOrderFill: ${orderId} not yet visible (attempt ${attempt + 1}/${ATTEMPTS})`);
      }
    }
    if (lastSeen) {
      throw new Error(
        `Order ${orderId} never reached a terminal status after ${ATTEMPTS} attempts ` +
        `(last status=${lastSeen.orderStatus}, cumExecQty=${lastSeen.cumExecQty})`
      );
    }
    throw new Error(`Order not found after ${ATTEMPTS} attempts: ${orderId}`);
  }

  /**
   * Apply a full-position TP/SL bracket to an existing position via the
   * position-level setTradingStop endpoint. This bypasses the tight price-band
   * validation that applies to order-attached takeProfit/stopLoss params.
   */
  async setTradingStop(symbol: string, params: { takeProfit?: number; stopLoss?: number }): Promise<void> {
    if (params.takeProfit == null && params.stopLoss == null) return;
    const res = await this.client.setTradingStop({
      category: "linear",
      symbol,
      positionIdx: 0, // one-way mode
      tpslMode: "Full",
      ...(params.takeProfit != null ? { takeProfit: String(params.takeProfit) } : {}),
      ...(params.stopLoss != null ? { stopLoss: String(params.stopLoss) } : {}),
    });
    if (res.retCode !== 0) bybitError(res);
  }

  async getInstrumentInfo(symbol: string): Promise<InstrumentInfo> {
    const res = await withRetry(() =>
      this.client.getInstrumentsInfo({ category: "linear", symbol })
    );
    if (res.retCode !== 0) bybitError(res);

    const inst = res.result.list[0];
    if (!inst) throw new Error(`Instrument not found: ${symbol}`);

    // lotSizeFilter exists on linear instruments
    const lot = (inst as unknown as { lotSizeFilter: { qtyStep: string; minOrderQty: string; maxOrderQty: string } }).lotSizeFilter;
    const price = (inst as unknown as { priceFilter: { tickSize: string } }).priceFilter;

    return {
      symbol: inst.symbol,
      tickSize: Number(price.tickSize),
      lotSize: Number(lot.qtyStep),
      minQty: Number(lot.minOrderQty),
      maxQty: Number(lot.maxOrderQty),
    };
  }

  async getExecutionList(params: {
    symbol?: string;
    orderId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<ExecutionFill[]> {
    const results: ExecutionFill[] = [];
    let cursor: string | undefined;
    do {
      const res = await withRetry(() =>
        this.client.getExecutionList({
          category: "linear",
          ...params,
          limit: params.limit ?? 100,
          cursor,
        })
      );
      if (res.retCode !== 0) bybitError(res);
      for (const e of res.result.list) {
        results.push({
          orderId: e.orderId,
          execId: e.execId,
          symbol: e.symbol,
          side: e.side,
          execPrice: Number(e.execPrice),
          execQty: Number(e.execQty),
          execFee: Number(e.execFee),
          execTime: Number(e.execTime),
          closedSize: Number(e.closedSize ?? "0"),
        });
      }
      cursor = res.result.nextPageCursor ?? undefined;
      if (params.limit) break; // caller specified a limit — single page only
    } while (cursor);
    return results;
  }

  async getClosedPnL(params: {
    symbol?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
  }): Promise<ClosedPnLEntry[]> {
    const results: ClosedPnLEntry[] = [];
    let cursor: string | undefined;
    do {
      const res = await withRetry(() =>
        this.client.getClosedPnL({
          category: "linear",
          ...params,
          limit: params.limit ?? 100,
          cursor,
        })
      );
      if (res.retCode !== 0) bybitError(res);
      for (const p of res.result.list) {
        results.push({
          orderId: p.orderId,
          symbol: p.symbol,
          side: p.side,
          qty: Number(p.qty),
          avgEntryPrice: Number(p.avgEntryPrice),
          avgExitPrice: Number(p.avgExitPrice),
          closedPnl: Number(p.closedPnl),
          openFee: Number(p.openFee),
          closeFee: Number(p.closeFee),
          createdTime: Number(p.createdTime),
          updatedTime: Number(p.updatedTime),
        });
      }
      cursor = res.result.nextPageCursor ?? undefined;
      if (params.limit) break;
    } while (cursor);
    return results;
  }

  /**
   * Fetch OHLCV klines for [startMs, endMs], paginating forward 1000 bars/call
   * (Bybit's per-request max). Used by the backtest candle cache — never called
   * on the live trading path. Always reads from mainnet (see `marketDataClient`
   * above) — real historical prices don't depend on which environment trades.
   */
  async getKline(symbol: string, timeframe: TimeframeId, startMs: number, endMs: number): Promise<Kline[]> {
    const interval = BYBIT_INTERVAL[timeframe];
    const intervalMs = TIMEFRAME_MS[timeframe];
    const results: Kline[] = [];
    let cursorStart = startMs;
    let page = 0;

    while (cursorStart <= endMs) {
      // A long backtest window (e.g. 2 years of 5m data) can page through this loop 200+ times
      // in a row — throttle proactively, and check retCode *inside* the retried call so a
      // rate-limit response (a normal 200 with a non-zero retCode, not a thrown network error)
      // becomes something withRetry can actually catch and back off on. See isRetryable.
      if (page > 0) await sleep(PAGINATION_DELAY_MS);
      page++;

      const res = await withRetry(async () => {
        const r = await this.marketDataClient.getKline({ category: "linear", symbol, interval, start: cursorStart, end: endMs, limit: 1000 });
        if (r.retCode !== 0) bybitError(r);
        return r;
      }, isRetryable);

      // Bybit returns newest-first; normalise to ascending order.
      const batch = res.result.list
        .map((k) => ({
          openTime: Number(k[0]),
          open: Number(k[1]),
          high: Number(k[2]),
          low: Number(k[3]),
          close: Number(k[4]),
          volume: Number(k[5]),
        }))
        .sort((a, b) => a.openTime - b.openTime);

      if (batch.length === 0) break;
      results.push(...batch);

      if (batch.length < 1000) break; // exhausted available data in range
      cursorStart = batch[batch.length - 1]!.openTime + intervalMs;
    }

    return results;
  }

  /**
   * Fetch historical funding rate settlements for [startMs, endMs], paginating forward 200
   * entries/call (Bybit's per-request max for this endpoint). Used by the backtest funding
   * store — funding interval varies by symbol (not every 8h for every symbol), so unlike
   * getKline this cursors by the last returned timestamp + 1ms rather than a fixed step. Same
   * mainnet-only rationale as getKline: real funding history, independent of testnet mode.
   */
  async getFundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingRateEntry[]> {
    const results: FundingRateEntry[] = [];
    let cursorStart = startMs;
    let page = 0;

    while (cursorStart <= endMs) {
      // Same proactive throttling + in-loop retCode check as getKline — see its comment.
      if (page > 0) await sleep(PAGINATION_DELAY_MS);
      page++;

      const res = await withRetry(async () => {
        const r = await this.marketDataClient.getFundingRateHistory({ category: "linear", symbol, startTime: cursorStart, endTime: endMs, limit: 200 });
        if (r.retCode !== 0) bybitError(r);
        return r;
      }, isRetryable);

      // Bybit returns newest-first; normalise to ascending order.
      const batch = res.result.list
        .map((f) => ({
          fundingTime: Number(f.fundingRateTimestamp),
          fundingRate: Number(f.fundingRate),
        }))
        .sort((a, b) => a.fundingTime - b.fundingTime);

      if (batch.length === 0) break;
      results.push(...batch);

      if (batch.length < 200) break; // exhausted available data in range
      cursorStart = batch[batch.length - 1]!.fundingTime + 1;
    }

    return results;
  }
}
