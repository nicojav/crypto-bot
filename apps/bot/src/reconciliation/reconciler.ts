import { WebsocketClient } from "bybit-api";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { BybitClient } from "../exchange/bybit.js";
import type { EventBus } from "../eventBus.js";
import { env } from "../env.js";

interface WsPositionUpdate {
  symbol: string;
  size: string;
  markPrice: string;
}

interface WsOrderUpdate {
  orderId: string;
  symbol: string;
  orderStatus: string;
  avgPrice: string;
  reduceOnly: boolean;
}

interface WsUpdateEvent {
  topic: string;
  data: unknown;
}

function pnlForClose(entryPrice: number, exitPrice: number, qty: number, side: string): number {
  return (exitPrice - entryPrice) * qty * (side === "BUY" ? 1 : -1);
}

export class Reconciler {
  private ws: WebsocketClient | null = null;
  private balanceTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly bybit: BybitClient,
    private readonly bus?: EventBus,
  ) {}

  async start(): Promise<void> {
    await this.runReconciliation("startup").catch((err: unknown) => {
      console.error("[reconciler] startup reconciliation failed:", err);
    });
    this.initWebSocket();
    this.startBalanceSnapshots();
  }

  stop(): void {
    this.stopping = true;
    if (this.balanceTimer !== null) {
      clearInterval(this.balanceTimer);
      this.balanceTimer = null;
    }
    if (this.ws) {
      this.ws.closeAll();
      this.ws = null;
    }
  }

  private initWebSocket(): void {
    const ws = new WebsocketClient({
      key: env.BYBIT_API_KEY,
      secret: env.BYBIT_API_SECRET,
      testnet: env.BYBIT_TESTNET,
    });

    ws.on("update", (data: WsUpdateEvent) => {
      this.handleUpdate(data).catch((err: unknown) =>
        console.error("[reconciler] WS update error:", err)
      );
    });

    ws.on("reconnected", () => {
      console.log("[reconciler] WS reconnected — running REST reconciliation");
      this.runReconciliation("reconnect").catch((err: unknown) =>
        console.error("[reconciler] post-reconnect reconciliation error:", err)
      );
    });

    ws.on("exception", (data: unknown) => {
      console.error("[reconciler] WS exception:", data);
    });

    ws.subscribeV5(["position", "order", "wallet"], "linear");
    this.ws = ws;
    console.log("[reconciler] subscribed to position/order/wallet");
  }

  private startBalanceSnapshots(): void {
    const snap = () =>
      this.takeBalanceSnapshot().catch((err: unknown) =>
        console.error("[reconciler] balance snapshot error:", err)
      );
    snap();
    this.balanceTimer = setInterval(snap, 60_000);
  }

  private async takeBalanceSnapshot(): Promise<void> {
    if (this.stopping) return;
    const bal = await this.bybit.getBalance("USDT");
    await this.db.balanceSnapshot.create({
      data: { equityUsd: bal.equity, availableUsd: bal.available },
    });
    this.bus?.publish({ type: "balance.updated", data: { equityUsd: bal.equity, availableUsd: bal.available } });
    console.log(`[reconciler] snapshot: equity=${bal.equity} available=${bal.available}`);
  }

  private async handleUpdate(event: WsUpdateEvent): Promise<void> {
    if (!event.topic) return;

    if (event.topic === "order") {
      const orders = event.data as WsOrderUpdate[];
      for (const order of orders) {
        if (order.orderStatus === "Filled" && order.reduceOnly) {
          await this.closeTradesByOrderFill(order);
        }
      }
    } else if (event.topic === "position") {
      const positions = event.data as WsPositionUpdate[];
      for (const pos of positions) {
        if (Number(pos.size) === 0) {
          await this.closeRemainingOpenTrades(pos.symbol, Number(pos.markPrice));
        }
      }
    }
  }

  private async closeTradesByOrderFill(order: WsOrderUpdate): Promise<void> {
    const exitPrice = Number(order.avgPrice);
    if (!exitPrice) return;

    const openTrades = await this.db.trade.findMany({
      where: { symbol: order.symbol, status: "OPEN" },
    });
    if (openTrades.length === 0) return;

    const now = new Date();
    await this.db.$transaction(
      openTrades.map((t) =>
        this.db.trade.update({
          where: { id: t.id },
          data: {
            status: "CLOSED",
            exitPrice,
            pnlUsd: pnlForClose(t.entryPrice, exitPrice, t.qty, t.side),
            closedAt: now,
          },
        })
      )
    );
    for (const t of openTrades) {
      this.bus?.publish({ type: "trade.closed", data: { tradeId: t.id, botId: t.botId, symbol: order.symbol, pnlUsd: pnlForClose(t.entryPrice, exitPrice, t.qty, t.side) } });
    }
    console.log(`[reconciler] order fill: closed ${openTrades.length} trade(s) for ${order.symbol} @ ${exitPrice}`);
  }

  private async closeRemainingOpenTrades(symbol: string, exitPrice: number): Promise<void> {
    // Position size hit 0 — close any trades the order-fill handler missed
    const openTrades = await this.db.trade.findMany({
      where: { symbol, status: "OPEN" },
    });
    if (openTrades.length === 0) return;

    const now = new Date();
    await this.db.$transaction(
      openTrades.map((t) =>
        this.db.trade.update({
          where: { id: t.id },
          data: {
            status: "CLOSED",
            exitPrice,
            pnlUsd: pnlForClose(t.entryPrice, exitPrice, t.qty, t.side),
            closedAt: now,
          },
        })
      )
    );
    for (const t of openTrades) {
      this.bus?.publish({ type: "trade.closed", data: { tradeId: t.id, botId: t.botId, symbol, pnlUsd: pnlForClose(t.entryPrice, exitPrice, t.qty, t.side) } });
    }
    console.log(`[reconciler] position closed: ${openTrades.length} remaining trade(s) for ${symbol} @ ${exitPrice}`);
  }

  async runReconciliation(reason: string): Promise<void> {
    console.log(`[reconciler] ${reason} reconciliation running...`);

    const openTrades = await this.db.trade.findMany({
      where: { status: "OPEN" },
    });

    if (openTrades.length === 0) {
      console.log(`[reconciler] ${reason}: 0 open trades — 0 mismatches`);
      return;
    }

    const symbols = [...new Set(openTrades.map((t) => t.symbol))];
    let mismatches = 0;

    for (const symbol of symbols) {
      try {
        const positions = await this.bybit.getPositions(symbol);
        const openPos = positions.find((p) => p.size > 0);
        const dbTrades = openTrades.filter((t) => t.symbol === symbol);

        if (!openPos && dbTrades.length > 0) {
          console.warn(
            `[reconciler] MISMATCH: DB has ${dbTrades.length} OPEN trade(s) for ${symbol} but exchange has no position`
          );
          mismatches += dbTrades.length;
        } else if (openPos && dbTrades.length === 0) {
          console.warn(
            `[reconciler] MISMATCH: Exchange has open position for ${symbol} (size=${openPos.size}) but DB has no OPEN trades`
          );
          mismatches++;
        } else {
          console.log(`[reconciler] OK: ${symbol} — ${dbTrades.length} trade(s), exchange size=${openPos?.size ?? 0}`);
        }
      } catch (err) {
        console.error(`[reconciler] failed to check ${symbol}:`, err);
      }
    }

    const summary =
      mismatches === 0
        ? "0 mismatches"
        : `${mismatches} mismatch(es) detected — investigate before live trading`;
    console.log(`[reconciler] ${reason} reconciliation done — ${summary}`);
  }
}
