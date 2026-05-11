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
  unrealisedPnl: number;
}

export interface InstrumentInfo {
  symbol: string;
  tickSize: number;
  lotSize: number;
  minQty: number;
  maxQty: number;
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
      // totalAvailableBalance is the account-level margin available for new orders
      available: Number((account as unknown as { totalAvailableBalance?: string })?.totalAvailableBalance ?? coinData?.availableToWithdraw ?? 0),
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
}
