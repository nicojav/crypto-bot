import type { PrismaClient, Bot, Signal, Trade } from "../generated/prisma/client.js";
import type { EventBus } from "../eventBus.js";

type SignalWithBot = Signal & { bot: Bot };

// Minimal interface — BybitClient satisfies this structurally
export interface Exchange {
  getMarkPrice(symbol: string): Promise<number>;
  getPositions(symbol: string): Promise<Array<{ side: "Buy" | "Sell" | "None"; size: number }>>;
  getInstrumentInfo(symbol: string): Promise<{ lotSize: number; minQty: number }>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketOrder(params: { symbol: string; side: "Buy" | "Sell"; qty: number; reduceOnly: boolean }): Promise<string>;
}

function decimalsOf(lotSize: number): number {
  if (!Number.isFinite(lotSize) || lotSize <= 0) return 0;
  const s = lotSize.toString();
  if (s.includes("e-")) return Number(s.split("e-")[1]);
  if (s.includes("e+")) return 0;
  const dot = s.indexOf(".");
  return dot === -1 ? 0 : s.length - dot - 1;
}

export function calcQty(maxUsd: number, leverage: number, markPrice: number, lotSize: number): number {
  const steps = Math.floor(maxUsd * leverage / markPrice / lotSize);
  return Number((steps * lotSize).toFixed(decimalsOf(lotSize)));
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

    // Kill-switch applies to all actions; other risk checks skip CLOSE (reduces exposure)
    if (!bot.enabled) {
      await this.reject(signal.id, "Bot is disabled (kill switch)");
      return;
    }

    if (signal.action !== "CLOSE") {
      const riskReject = await this.runRiskChecks(bot);
      if (riskReject) {
        await this.reject(signal.id, riskReject);
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
      await this.reject(signal.id, err instanceof Error ? err.message : String(err));
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
        await this.reject(signal.id, "No open position to close");
        return;
      }
      const closeSide = pos.side === "Buy" ? "Sell" : "Buy";
      const orderId = await this.exchange.placeMarketOrder({ symbol, side: closeSide, qty: pos.size, reduceOnly: true });
      const markPrice = await this.exchange.getMarkPrice(symbol);
      await this.closeOpenTradesInDb(bot.id, symbol, markPrice);
      await this.db.signal.update({
        where: { id: signal.id },
        data: { status: "EXECUTED", processedAt: new Date() },
      });
      console.log(`[processor] CLOSE ${symbol} orderId=${orderId} markPrice=${markPrice}`);
      return;
    }

    const instrument = await this.exchange.getInstrumentInfo(symbol);
    const markPrice = await this.exchange.getMarkPrice(symbol);
    const qty = calcQty(bot.maxPositionUsd, bot.maxLeverage, markPrice, instrument.lotSize);

    if (qty < instrument.minQty) {
      await this.reject(signal.id, `Calculated qty ${qty} is below minQty ${instrument.minQty}`);
      return;
    }

    await this.exchange.setLeverage(symbol, bot.maxLeverage).catch((err: unknown) => {
      console.warn(`[processor] setLeverage failed — proceeding with order anyway:`, (err as Error).message);
    });

    const side = signal.action === "BUY" ? "Buy" : "Sell";

    const existing = await this.db.trade.findMany({
      where: { botId: bot.id, symbol, status: "OPEN" },
    });
    if (existing.some((t) => t.side !== signal.action)) {
      const positions = await this.exchange.getPositions(symbol);
      const oppositePos = positions.find((p) => p.size > 0);
      const closePrice = await this.exchange.getMarkPrice(symbol);

      if (oppositePos && oppositePos.side !== side) {
        const closeSide = oppositePos.side === "Buy" ? "Sell" : "Buy";
        try {
          await this.exchange.placeMarketOrder({ symbol, side: closeSide, qty: oppositePos.size, reduceOnly: true });
        } catch (err) {
          await this.reject(signal.id, `Reduce-only close failed: ${(err as Error).message}`);
          return;
        }
      } else if (oppositePos) {
        console.warn(`[processor] divergence: DB has OPEN ${existing[0]?.side ?? "?"} trade(s) for ${symbol} but exchange has same-side ${oppositePos.side} position — closing DB rows only`);
      } else {
        console.warn(`[processor] reversal: DB has OPEN trade for ${symbol} but exchange has no position — closing DB only`);
      }

      await this.closeOpenTradesInDb(bot.id, symbol, closePrice, existing);
    }

    const orderId = await this.exchange.placeMarketOrder({ symbol, side, qty, reduceOnly: false });

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

  private async reject(signalId: number, reason: string): Promise<void> {
    console.warn(`[processor] REJECT signal ${signalId}: ${reason}`);
    await this.db.signal.update({
      where: { id: signalId },
      data: { status: "REJECTED", rejectionReason: reason, processedAt: new Date() },
    });
  }
}
