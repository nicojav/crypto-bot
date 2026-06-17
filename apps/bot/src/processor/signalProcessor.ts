import type { PrismaClient, Bot, Signal, Trade } from "../generated/prisma/client.js";
import type { EventBus } from "../eventBus.js";

type SignalWithBot = Signal & { bot: Bot };

// Minimal interface — BybitClient satisfies this structurally
export interface Exchange {
  getMarkPrice(symbol: string): Promise<number>;
  getPositions(symbol: string): Promise<Array<{ side: "Buy" | "Sell" | "None"; size: number }>>;
  getInstrumentInfo(symbol: string): Promise<{ lotSize: number; minQty: number; tickSize: number }>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketOrder(params: { symbol: string; side: "Buy" | "Sell"; qty: number; reduceOnly: boolean; takeProfit?: number; stopLoss?: number }): Promise<string>;
}

function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  if (s.includes("e+")) return 0;
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function calcQty(maxUsd: number, leverage: number, markPrice: number, lotSize: number): number {
  const steps = Math.floor(maxUsd * leverage / markPrice / lotSize);
  return Number((steps * lotSize).toFixed(decimalsOf(lotSize)));
}

/** Round a price to the nearest instrument tick, preventing Bybit error 10001 on excess decimals. */
export function roundToTick(price: number, tickSize: number): number {
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price;
  const steps = Math.round(price / tickSize);
  return Number((steps * tickSize).toFixed(decimalsOf(tickSize)));
}

function pnlForTrade(trade: Trade, exitPrice: number): number {
  return (exitPrice - trade.entryPrice) * trade.qty * (trade.side === "BUY" ? 1 : -1);
}

export class SignalProcessor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly exchange: Exchange,
    private readonly bus?: EventBus,
  ) {}

  start(intervalMs = 500): void {
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      this.tick()
        .catch((err: unknown) => console.error("[processor] tick error:", err))
        .finally(() => { this.busy = false; });
    }, intervalMs);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async tick(): Promise<void> {
    const signal = await this.db.signal.findFirst({
      where: { status: "PENDING" },
      orderBy: { receivedAt: "asc" },
      include: { bot: true },
    });
    if (!signal) return;
    await this.processSignal(signal as SignalWithBot);
  }

  async processSignal(signal: SignalWithBot): Promise<void> {
    const { bot } = signal;
    const payload = JSON.parse(signal.payload) as { symbol: string; price?: number };
    const { symbol } = payload;
    this.bus?.publish({ type: "signal.received", data: { signalId: signal.id, botId: bot.id, action: signal.action, symbol } });

    // Guard: reject if payload symbol doesn't match the bot's configured symbol.
    // Prevents silent mis-routing when a TradingView alert is pointed at the wrong /webhook/:botId.
    if (symbol !== bot.symbol) {
      await this.reject(signal.id, `Symbol mismatch: signal ${symbol} ≠ bot ${bot.symbol}`, bot.id);
      return;
    }

    // Kill-switch applies to all actions; other risk checks skip CLOSE (reduces exposure)
    if (!bot.enabled) {
      await this.reject(signal.id, "Bot is disabled (kill switch)", bot.id);
      return;
    }

    if (signal.action !== "CLOSE") {
      const riskReject = await this.runRiskChecks(bot);
      if (riskReject) {
        await this.reject(signal.id, riskReject, bot.id);
        return;
      }
    }

    if (bot.dryRun) {
      await this.processDryRun(signal, bot, symbol, payload.price ?? 0);
      return;
    }

    try {
      await this.processLive(signal, bot, symbol);
    } catch (err: unknown) {
      await this.reject(signal.id, err instanceof Error ? err.message : String(err), bot.id);
    }
  }

  private async runRiskChecks(bot: Bot): Promise<string | null> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const agg = await this.db.trade.aggregate({
      where: { botId: bot.id, status: "CLOSED", closedAt: { gte: startOfDay } },
      _sum: { pnlUsd: true },
    });
    const dailyPnl = agg._sum.pnlUsd ?? 0;
    if (dailyPnl < bot.dailyLossLimitUsd) {
      return `Daily loss limit reached (${dailyPnl.toFixed(2)} USD < limit ${bot.dailyLossLimitUsd} USD)`;
    }

    return null;
  }

  private async closeOpenTradesInDb(botId: number, symbol: string, exitPrice: number, prefetched?: Trade[]): Promise<Trade[]> {
    const openTrades = prefetched ?? await this.db.trade.findMany({
      where: { botId, symbol, status: "OPEN" },
    });
    if (openTrades.length === 0) return [];
    const now = new Date();
    const withPnl = openTrades.map((t) => ({ trade: t, pnlUsd: pnlForTrade(t, exitPrice) }));
    await this.db.$transaction(
      withPnl.map(({ trade, pnlUsd }) =>
        this.db.trade.update({
          where: { id: trade.id },
          data: { status: "CLOSED", exitPrice, pnlUsd, closedAt: now },
        })
      )
    );
    for (const { trade, pnlUsd } of withPnl) {
      this.bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd } });
    }
    return openTrades;
  }

  // Sets OPEN trades to CLOSING so the reconciler's WS order-fill handler finalizes
  // them with the real fill price and fees from Bybit.
  private async markTradesAsClosing(botId: number, symbol: string, closingOrderId: string, prefetched?: Trade[]): Promise<Trade[]> {
    const trades = prefetched ?? await this.db.trade.findMany({
      where: { botId, symbol, status: "OPEN" },
    });
    if (trades.length === 0) return [];
    await this.db.$transaction(
      trades.map((t) =>
        this.db.trade.update({
          where: { id: t.id },
          data: { status: "CLOSING", closingOrderId },
        })
      )
    );
    return trades;
  }

  private async processDryRun(
    signal: SignalWithBot,
    bot: Bot,
    symbol: string,
    price: number,
  ): Promise<void> {
    console.log(`[processor] dry-run ${signal.action} ${symbol} @ ~${price} USD (bot ${bot.id})`);

    if (signal.action === "CLOSE") {
      await this.closeOpenTradesInDb(bot.id, symbol, price);
      await this.db.signal.update({
        where: { id: signal.id },
        data: { status: "EXECUTED", processedAt: new Date() },
      });
      return;
    }

    const existing = await this.db.trade.findMany({
      where: { botId: bot.id, symbol, status: "OPEN" },
    });
    if (existing.some((t) => t.side !== signal.action)) {
      await this.closeOpenTradesInDb(bot.id, symbol, price, existing);
    }

    const qty = calcQty(bot.maxPositionUsd, bot.maxLeverage, price, 0.001);
    const [, trade] = await this.db.$transaction([
      this.db.signal.update({
        where: { id: signal.id },
        data: { status: "EXECUTED", processedAt: new Date() },
      }),
      this.db.trade.create({
        data: {
          botId: bot.id,
          signalId: signal.id,
          exchangeOrderId: `dry-${Date.now()}-${signal.id}`,
          symbol,
          side: signal.action,
          qty,
          entryPrice: price,
          status: "OPEN",
        },
      }),
    ]);
    this.bus?.publish({ type: "trade.opened", data: { tradeId: trade.id, botId: bot.id, symbol, side: signal.action, qty, entryPrice: price } });
  }

  private async processLive(signal: SignalWithBot, bot: Bot, symbol: string): Promise<void> {
    if (signal.action === "CLOSE") {
      const positions = await this.exchange.getPositions(symbol);
      const pos = positions.find((p) => p.size > 0);
      if (!pos) {
        await this.reject(signal.id, "No open position to close", bot.id);
        return;
      }
      const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
      const orderId = await this.exchange.placeMarketOrder({ symbol, side: closeSide, qty: pos.size, reduceOnly: true });
      // Mark trades as CLOSING — the reconciler's WS order-fill handler will finalize
      // them with the real fill price and Bybit-computed PnL when the fill arrives.
      await this.markTradesAsClosing(bot.id, symbol, orderId);
      await this.db.signal.update({
        where: { id: signal.id },
        data: { status: "EXECUTED", processedAt: new Date() },
      });
      console.log(`[processor] CLOSE ${symbol} orderId=${orderId}`);
      return;
    }

    // Parse TP/SL (and the bar-close price at signal time) from the stored webhook payload.
    const parsedPayload = (() => {
      try { return JSON.parse(signal.payload ?? "{}") as { price?: number; takeProfit?: number; stopLoss?: number }; }
      catch { return {}; }
    })();
    const signalBarPrice = typeof parsedPayload.price === "number" ? parsedPayload.price : undefined;
    const rawTakeProfit = typeof parsedPayload.takeProfit === "number" ? parsedPayload.takeProfit : undefined;
    const rawStopLoss = typeof parsedPayload.stopLoss === "number" ? parsedPayload.stopLoss : undefined;

    const instrument = await this.exchange.getInstrumentInfo(symbol);
    const markPrice = await this.exchange.getMarkPrice(symbol);
    const qty = calcQty(bot.maxPositionUsd, bot.maxLeverage, markPrice, instrument.lotSize);

    if (qty < instrument.minQty) {
      await this.reject(signal.id, `Calculated qty ${qty} is below minQty ${instrument.minQty}`, bot.id);
      return;
    }

    // Re-anchor TP/SL from bar-close to live mark price, preserving the strategy's ATR distances.
    // This prevents Bybit error 10001 when price drifts between bar-close and order execution.
    const ref = signalBarPrice ?? markPrice; // fall back to markPrice if Pine didn't send price
    const tick = instrument.tickSize;
    let takeProfit: number | undefined;
    let stopLoss: number | undefined;
    if (rawTakeProfit != null) {
      const anchored = roundToTick(markPrice + (rawTakeProfit - ref), tick);
      const valid = signal.action === "BUY" ? anchored > markPrice : anchored < markPrice;
      if (valid) { takeProfit = anchored; }
      else { console.warn(`[processor] ${signal.action} TP ${anchored} is on wrong side of markPrice ${markPrice} after re-anchor — dropping TP`); }
    }
    if (rawStopLoss != null) {
      const anchored = roundToTick(markPrice + (rawStopLoss - ref), tick);
      const valid = signal.action === "BUY" ? anchored < markPrice : anchored > markPrice;
      if (valid) { stopLoss = anchored; }
      else { console.warn(`[processor] ${signal.action} SL ${anchored} is on wrong side of markPrice ${markPrice} after re-anchor — dropping SL`); }
    }

    await this.exchange.setLeverage(symbol, bot.maxLeverage).catch((err: unknown) => {
      console.warn(`[processor] setLeverage failed — proceeding with order anyway:`, (err as Error).message);
    });

    const side = signal.action === "BUY" ? "Buy" : "Sell";

    const existing = await this.db.trade.findMany({
      where: { botId: bot.id, symbol, status: { in: ["OPEN", "CLOSING"] } },
    });

    // Reject duplicate same-side signals to enforce 1:1 Trade↔Position
    const sameSide = existing.find((t) => t.side === signal.action);
    if (sameSide) {
      await this.reject(signal.id, `Duplicate ${signal.action}: OPEN trade #${sameSide.id} already exists for ${symbol}`, bot.id);
      return;
    }

    if (existing.some((t) => t.side !== signal.action)) {
      const positions = await this.exchange.getPositions(symbol);
      const oppositePos = positions.find((p) => p.size > 0);

      if (oppositePos && oppositePos.side !== side) {
        const closeSide = oppositePos.side === "Buy" ? "Sell" : "Buy";
        let closeOrderId: string;
        try {
          closeOrderId = await this.exchange.placeMarketOrder({ symbol, side: closeSide, qty: oppositePos.size, reduceOnly: true });
        } catch (err) {
          await this.reject(signal.id, `Reduce-only close failed: ${(err as Error).message}`, bot.id);
          return;
        }
        // Mark as CLOSING — reconciler finalizes with real fill price and Bybit PnL
        await this.markTradesAsClosing(bot.id, symbol, closeOrderId, existing);
      } else if (oppositePos) {
        console.warn(`[processor] divergence: DB has OPEN ${existing[0]?.side ?? "?"} trade(s) for ${symbol} but exchange has same-side ${oppositePos.side} position — closing DB rows only`);
        const markPrice = await this.exchange.getMarkPrice(symbol);
        await this.closeOpenTradesInDb(bot.id, symbol, markPrice, existing);
      } else {
        console.warn(`[processor] reversal: DB has OPEN trade for ${symbol} but exchange has no position — closing DB only`);
        const markPrice = await this.exchange.getMarkPrice(symbol);
        await this.closeOpenTradesInDb(bot.id, symbol, markPrice, existing);
      }
    }

    const orderId = await this.exchange.placeMarketOrder({ symbol, side, qty, reduceOnly: false, takeProfit, stopLoss });

    const [, liveTrade] = await this.db.$transaction([
      this.db.signal.update({
        where: { id: signal.id },
        data: { status: "EXECUTED", processedAt: new Date() },
      }),
      this.db.trade.create({
        data: {
          botId: bot.id,
          signalId: signal.id,
          exchangeOrderId: orderId,
          symbol,
          side: signal.action,
          qty,
          entryPrice: markPrice,
          status: "OPEN",
        },
      }),
    ]);
    this.bus?.publish({ type: "trade.opened", data: { tradeId: liveTrade.id, botId: bot.id, symbol, side: signal.action, qty, entryPrice: markPrice } });
    console.log(`[processor] ${signal.action} ${qty} ${symbol} @ ~${markPrice} orderId=${orderId}`);
  }

  private async reject(signalId: number, reason: string, botId?: number): Promise<void> {
    console.warn(`[processor] REJECT signal ${signalId}: ${reason}`);
    await this.db.signal.update({
      where: { id: signalId },
      data: { status: "REJECTED", rejectionReason: reason, processedAt: new Date() },
    });
    if (botId != null) {
      this.bus?.publish({ type: "signal.rejected", data: { signalId, botId, reason } });
    }
  }
}
