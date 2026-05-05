import type { PrismaClient, Bot, Signal, Trade } from "../generated/prisma/client.js";

type SignalWithBot = Signal & { bot: Bot };

// Minimal interface — BybitClient satisfies this structurally
export interface Exchange {
  getMarkPrice(symbol: string): Promise<number>;
  getPositions(symbol: string): Promise<Array<{ side: "Buy" | "Sell" | "None"; size: number }>>;
  getInstrumentInfo(symbol: string): Promise<{ lotSize: number; minQty: number }>;
  setLeverage(symbol: string, leverage: number): Promise<void>;
  placeMarketOrder(params: { symbol: string; side: "Buy" | "Sell"; qty: number; reduceOnly: boolean }): Promise<string>;
}

function calcQty(maxUsd: number, markPrice: number, lotSize: number): number {
  const steps = Math.floor(maxUsd / markPrice / lotSize);
  return steps * lotSize;
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

  private async processDryRun(
    signal: SignalWithBot,
    bot: Bot,
    symbol: string,
    price: number,
  ): Promise<void> {
    console.log(`[processor] dry-run ${signal.action} ${symbol} @ ~${price} USD (bot ${bot.id})`);

    if (signal.action === "CLOSE") {
      const openTrades = await this.db.trade.findMany({
        where: { botId: bot.id, symbol, status: "OPEN" },
      });
      const now = new Date();
      await this.db.$transaction([
        ...openTrades.map((t) =>
          this.db.trade.update({
            where: { id: t.id },
            data: {
              status: "CLOSED",
              exitPrice: price,
              pnlUsd: pnlForTrade(t, price),
              closedAt: now,
            },
          })
        ),
        this.db.signal.update({
          where: { id: signal.id },
          data: { status: "EXECUTED", processedAt: now },
        }),
      ]);
      return;
    }

    const qty = calcQty(bot.maxPositionUsd, price, 0.001);
    await this.db.$transaction([
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
      const openTrades = await this.db.trade.findMany({ where: { botId: bot.id, symbol, status: "OPEN" } });
      const now = new Date();
      await this.db.$transaction([
        ...openTrades.map((t) =>
          this.db.trade.update({
            where: { id: t.id },
            data: {
              status: "CLOSED",
              exitPrice: markPrice,
              pnlUsd: pnlForTrade(t, markPrice),
              closedAt: now,
            },
          })
        ),
        this.db.signal.update({
          where: { id: signal.id },
          data: { status: "EXECUTED", processedAt: now },
        }),
      ]);
      console.log(`[processor] CLOSE ${symbol} orderId=${orderId} markPrice=${markPrice}`);
      return;
    }

    const instrument = await this.exchange.getInstrumentInfo(symbol);
    const markPrice = await this.exchange.getMarkPrice(symbol);
    const qty = calcQty(bot.maxPositionUsd, markPrice, instrument.lotSize);

    if (qty < instrument.minQty) {
      await this.reject(signal.id, `Calculated qty ${qty} is below minQty ${instrument.minQty}`);
      return;
    }

    await this.exchange.setLeverage(symbol, bot.maxLeverage);
    const side = signal.action === "BUY" ? "Buy" : "Sell";
    const orderId = await this.exchange.placeMarketOrder({ symbol, side, qty, reduceOnly: false });

    await this.db.$transaction([
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
