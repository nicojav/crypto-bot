import { RestClientV5 } from "bybit-api";
import { env } from "../env.js";

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

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isNetworkError(err) || attempt === RETRY_DELAYS_MS.length) break;
      const delay = RETRY_DELAYS_MS[attempt];
      console.warn(`[bybit] network error, retry ${attempt + 1} in ${delay}ms:`, (err as Error).message);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

function bybitError(err: unknown): never {
  if (err && typeof err === "object" && "retCode" in err) {
    const e = err as { retCode: number; retMsg: string };
    throw new Error(`Bybit error ${e.retCode}: ${e.retMsg}`);
  }
  throw err;
}

export class BybitClient {
  private client: RestClientV5;

  constructor() {
    this.client = new RestClientV5({
      key: env.BYBIT_API_KEY,
      secret: env.BYBIT_API_SECRET,
      testnet: env.BYBIT_TESTNET,
    });
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

    return {
      coin,
      equity: Number(coinData?.equity ?? 0),
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
    // No retry on order placement — partial fills and duplicates are dangerous
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
}
