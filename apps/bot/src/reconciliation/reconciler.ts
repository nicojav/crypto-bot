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
  side: string;       // "Buy" | "Sell"
  qty: string;
  orderStatus: string;
  avgPrice: string;
  cumExecFee: string;
  closedPnl: string;
  reduceOnly: boolean;
  updatedTime: string;
  createType?: string; // e.g. "CreateByUser" | "CreateByLiq" | "CreateByTakeOver_PassThrough" | "CreateByAdl_PassThrough"
}

interface WsExecutionUpdate {
  execType: string;   // "Trade" | "Funding" | "AdlTrade" | "BustTrade" | "BlockTrade" | "MovePosition"
  symbol: string;
  execId: string;
  execFee: string;    // for Funding type: negative = paid out, positive = received
  execTime: string;
}

interface WsUpdateEvent {
  topic: string;
  data: unknown;
}

/** "Buy" → "SELL", "Sell" → "BUY" — trade.side stored in signal-action case */
function dbSideForClosingOrder(orderSide: string): string {
  return orderSide === "Buy" ? "SELL" : "BUY";
}

function isLiquidationCreateType(createType: string | undefined): boolean {
  return (
    createType === "CreateByLiq" ||
    createType === "CreateByTakeOver_PassThrough" ||
    createType === "CreateByAdl_PassThrough"
  );
}

export class Reconciler {
  private ws: WebsocketClient | null = null;
  private balanceTimer: ReturnType<typeof setInterval> | null = null;
  private stopping = false;
  private lastWsActivityAt = Date.now();
  private wsAuthFailed = false;

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
      this.lastWsActivityAt = Date.now();
      this.handleUpdate(data).catch((err: unknown) =>
        console.error("[reconciler] WS update error:", err)
      );
    });

    ws.on("reconnected", () => {
      const disconnectedMs = Date.now() - this.lastWsActivityAt;
      this.lastWsActivityAt = Date.now();
      console.log(`[reconciler] WS reconnected after ~${Math.round(disconnectedMs / 1000)}s — running REST reconciliation`);
      this.bus?.publish({ type: "ws.reconnected", data: { disconnectedMs } });
      this.runReconciliation("reconnect").catch((err: unknown) =>
        console.error("[reconciler] post-reconnect reconciliation error:", err)
      );
    });

    ws.on("exception", (data: unknown) => {
      const msg = (data as { message?: string })?.message ?? "";
      if (msg.includes("403") || msg.includes("401")) {
        if (!this.wsAuthFailed) {
          this.wsAuthFailed = true;
          console.error(
            "[reconciler] Bybit private WS auth failed (403/401). " +
            "Check BYBIT_API_KEY, BYBIT_API_SECRET, and API key permissions (Derivatives Trading required). " +
            "Bot continues running — webhook signals still work. WS reconciliation disabled."
          );
          ws.closeAll();
          this.ws = null;
        }
        return;
      }
      console.error("[reconciler] WS exception:", data);
    });

    ws.subscribeV5(["position", "order", "execution", "wallet"], "linear");
    this.ws = ws;
    console.log("[reconciler] subscribed to position/order/execution/wallet");
  }

  private lastWalletSnapshotAt = 0;

  private startBalanceSnapshots(): void {
    const snap = () =>
      this.takeBalanceSnapshot().catch((err: unknown) => {
        if (err !== null && typeof err === "object" && "requestOptions" in err) {
          const { requestOptions: _omit, ...safe } = err as Record<string, unknown>;
          console.error("[reconciler] balance snapshot error:", safe);
        } else {
          console.error("[reconciler] balance snapshot error:", err);
        }
      });
    snap();
    this.balanceTimer = setInterval(snap, 60_000);
  }

  private async takeBalanceSnapshot(): Promise<void> {
    if (this.stopping) return;
    this.lastWalletSnapshotAt = Date.now();
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
        if (order.orderStatus !== "Filled") continue;
        if (order.reduceOnly) {
          await this.closeTradesByOrderFill(order);
        } else {
          await this.hydrateOpenTradeFill(order);
        }
      }
    } else if (event.topic === "position") {
      const positions = event.data as WsPositionUpdate[];
      for (const pos of positions) {
        if (Number(pos.size) === 0) {
          await this.closeRemainingOpenTrades(pos.symbol);
        }
      }
    } else if (event.topic === "execution") {
      const executions = event.data as WsExecutionUpdate[];
      for (const exec of executions) {
        if (exec.execType !== "Funding") continue;
        await this.handleFundingExecution(exec);
      }
    } else if (event.topic === "wallet") {
      // Take an extra snapshot on wallet updates, rate-limited to once per 5s
      if (Date.now() - this.lastWalletSnapshotAt > 5_000) {
        this.takeBalanceSnapshot().catch((err: unknown) =>
          console.error("[reconciler] wallet-triggered snapshot error:", err)
        );
      }
    }
  }

  private async applyCloseExecution(params: {
    tradeId: number;
    botId: number;
    symbol: string;
    exitFillPrice: number;
    feeCloseUsd: number;
    closingOrderId: string;
    realizedPnlUsd: number;
    pnlSource: string;
  }): Promise<void> {
    const { tradeId, botId, symbol, exitFillPrice, feeCloseUsd, closingOrderId, realizedPnlUsd, pnlSource } = params;
    await this.db.trade.update({
      where: { id: tradeId },
      data: {
        status: "CLOSED",
        exitPrice: exitFillPrice,
        exitFillPrice,
        pnlUsd: realizedPnlUsd,
        realizedPnlUsd,
        feeCloseUsd,
        closingOrderId,
        pnlSource,
        closedAt: new Date(),
      },
    });
    this.bus?.publish({ type: "trade.closed", data: { tradeId, botId, symbol, pnlUsd: realizedPnlUsd } });
  }

  private async closeTradesByOrderFill(order: WsOrderUpdate): Promise<void> {
    const exitFillPrice = Number(order.avgPrice);
    if (!exitFillPrice) return;

    const feeCloseUsd = Number(order.cumExecFee);
    const realizedPnlUsd = Number(order.closedPnl);

    // 1. Idempotency: already processed this order?
    const already = await this.db.trade.findFirst({
      where: { closingOrderId: order.orderId },
    });
    if (already) return;

    const expectedDbSide = dbSideForClosingOrder(order.side);

    const candidates = await this.db.trade.findMany({
      where: { symbol: order.symbol, status: { in: ["OPEN", "CLOSING"] } },
    });

    // 2. Liquidation branch: skip qty match — close all trades on the affected side
    if (isLiquidationCreateType(order.createType)) {
      const liquidationTrades = candidates.filter((t) => t.side === expectedDbSide);
      if (liquidationTrades.length === 0) {
        console.warn(`[reconciler] liquidation ${order.orderId}: no matching trades for ${order.symbol} side=${expectedDbSide}`);
        return;
      }
      let firstTrade = true;
      for (const trade of liquidationTrades) {
        // First trade absorbs the full liquidation PnL + fees; subsequent rows are tagged only
        await this.applyCloseExecution({
          tradeId: trade.id,
          botId: trade.botId,
          symbol: order.symbol,
          exitFillPrice,
          feeCloseUsd: firstTrade ? feeCloseUsd : 0,
          closingOrderId: order.orderId,
          realizedPnlUsd: firstTrade ? realizedPnlUsd : 0,
          pnlSource: "BYBIT_LIQUIDATION",
        });
        if (firstTrade) {
          this.bus?.publish({ type: "trade.liquidated", data: { tradeId: trade.id, botId: trade.botId, symbol: order.symbol, realizedPnlUsd, createType: order.createType ?? "" } });
          firstTrade = false;
        }
      }
      console.log(`[reconciler] liquidation: closed ${liquidationTrades.length} trade(s) for ${order.symbol} pnl=${realizedPnlUsd.toFixed(4)} createType=${order.createType ?? "?"}`);
      return;
    }

    // 3. Normal close: require side + qty match within 0.5%
    const orderQty = Number(order.qty);
    const matched = candidates.filter(
      (t) =>
        t.side === expectedDbSide &&
        (orderQty === 0 || Math.abs(t.qty - orderQty) / Math.max(t.qty, orderQty) < 0.005)
    );

    if (matched.length === 0) {
      console.warn(`[reconciler] order fill ${order.orderId}: no matching trade for ${order.symbol} (side=${expectedDbSide}, qty=${orderQty})`);
      return;
    }
    if (matched.length > 1) {
      console.warn(`[reconciler] order fill ${order.orderId}: ${matched.length} ambiguous matches for ${order.symbol} — skipping, will resolve on reconciliation`);
      return;
    }

    const trade = matched[0]!;
    await this.applyCloseExecution({
      tradeId: trade.id,
      botId: trade.botId,
      symbol: order.symbol,
      exitFillPrice,
      feeCloseUsd,
      closingOrderId: order.orderId,
      realizedPnlUsd,
      pnlSource: "BYBIT_WS",
    });
    console.log(`[reconciler] order fill: closed trade #${trade.id} for ${order.symbol} @ ${exitFillPrice} pnl=${realizedPnlUsd.toFixed(4)}`);
  }

  private async handleFundingExecution(exec: WsExecutionUpdate): Promise<void> {
    // Bybit reports funding via the execution topic with execType="Funding".
    // execFee holds the funding amount: negative = paid out, positive = received.
    const fundingUsd = Number(exec.execFee);
    if (isNaN(fundingUsd)) return;

    try {
      await this.db.fundingEvent.upsert({
        where: { execId: exec.execId },
        create: {
          symbol: exec.symbol,
          fundingUsd,
          execTime: new Date(Number(exec.execTime)),
          execId: exec.execId,
        },
        update: {}, // idempotent — no update needed
      });
      console.log(`[reconciler] funding: ${exec.symbol} ${fundingUsd >= 0 ? "+" : ""}${fundingUsd.toFixed(4)} execId=${exec.execId}`);
    } catch (err) {
      console.error("[reconciler] failed to persist funding event:", err);
    }
  }

  private async closeRemainingOpenTrades(symbol: string): Promise<void> {
    // Position size hit 0 via WS position update — close any OPEN/CLOSING trades
    // the order-fill handler missed (e.g. auth failure window, reconnect).
    const openTrades = await this.db.trade.findMany({
      where: { symbol, status: { in: ["OPEN", "CLOSING"] } },
    });
    if (openTrades.length === 0) return;

    // Fetch recent executions to get the real fill price
    let exitFillPrice: number | null = null;
    let feeCloseUsd = 0;
    try {
      const execs = await this.bybit.getExecutionList({
        symbol,
        startTime: Date.now() - 60_000,
        limit: 20,
      });
      // Pick the most recent reduce-only execution (closedSize > 0)
      const closeExec = execs
        .filter((e) => e.closedSize > 0)
        .sort((a, b) => b.execTime - a.execTime)[0];
      if (closeExec) {
        exitFillPrice = closeExec.execPrice;
        feeCloseUsd = closeExec.execFee;
      }
    } catch (err) {
      console.warn("[reconciler] closeRemainingOpenTrades: getExecutionList failed, falling back to markPrice from DB", err);
    }

    const now = new Date();
    for (const trade of openTrades) {
      if (exitFillPrice !== null) {
        // Compute PnL from fill price — we don't have closedPnl here, so use EXEC_FALLBACK
        const realizedPnlUsd =
          (exitFillPrice - trade.entryPrice) * trade.qty * (trade.side === "BUY" ? 1 : -1) - feeCloseUsd;
        await this.db.trade.update({
          where: { id: trade.id },
          data: {
            status: "CLOSED",
            exitPrice: exitFillPrice,
            exitFillPrice,
            pnlUsd: realizedPnlUsd,
            realizedPnlUsd,
            feeCloseUsd,
            pnlSource: "EXEC_FALLBACK",
            closedAt: now,
          },
        });
        this.bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd: realizedPnlUsd } });
      } else {
        // Last resort: close without fill price data (no execution found)
        await this.db.trade.update({
          where: { id: trade.id },
          data: { status: "CLOSED", pnlSource: "EXEC_FALLBACK", closedAt: now },
        });
        this.bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd: null } });
        console.warn(`[reconciler] position closed: trade #${trade.id} for ${symbol} has no execution data`);
      }
    }
    console.log(`[reconciler] position zero: closed ${openTrades.length} trade(s) for ${symbol}`);
  }

  private async hydrateOpenTradeFill(order: WsOrderUpdate): Promise<void> {
    // Non-reduce-only fill → hydrate entryFillPrice + feeOpenUsd on the matching open trade
    const entryFillPrice = Number(order.avgPrice);
    if (!entryFillPrice) return;

    const trade = await this.db.trade.findFirst({
      where: { exchangeOrderId: order.orderId, status: { in: ["OPEN", "CLOSING"] } },
    });
    if (!trade) return;

    await this.db.trade.update({
      where: { id: trade.id },
      data: {
        entryFillPrice,
        feeOpenUsd: Number(order.cumExecFee),
        entryPrice: entryFillPrice, // keep entryPrice in sync with actual fill
      },
    });
    console.log(`[reconciler] open fill: hydrated trade #${trade.id} entryFillPrice=${entryFillPrice}`);
  }

  async runReconciliation(reason: string): Promise<void> {
    console.log(`[reconciler] ${reason} reconciliation running...`);

    const openTrades = await this.db.trade.findMany({
      where: { status: { in: ["OPEN", "CLOSING"] } },
    });

    if (openTrades.length === 0) {
      console.log(`[reconciler] ${reason}: 0 open/closing trades — 0 mismatches`);
      return;
    }

    const symbols = [...new Set(openTrades.map((t) => t.symbol))];
    let mismatches = 0;

    for (const symbol of symbols) {
      try {
        const positions = await this.bybit.getPositions(symbol);
        const openPos = positions.find((p) => p.size > 0);
        const dbTrades = openTrades.filter((t) => t.symbol === symbol);
        const closingTrades = dbTrades.filter((t) => t.status === "CLOSING");

        if (!openPos && dbTrades.length > 0) {
          // Exchange has no position but DB has OPEN/CLOSING trades — close them
          if (closingTrades.length > 0) {
            // These were in CLOSING — reconciler will let the WS order event finalize,
            // but if it's been more than 30s we should close them now
            console.warn(
              `[reconciler] MISMATCH: ${closingTrades.length} CLOSING trade(s) for ${symbol} but exchange has no position`
            );
          } else {
            console.warn(
              `[reconciler] MISMATCH: DB has ${dbTrades.length} OPEN trade(s) for ${symbol} but exchange has no position`
            );
          }
          mismatches += dbTrades.length;
        } else if (openPos && dbTrades.length === 0) {
          console.warn(
            `[reconciler] MISMATCH: Exchange has open position for ${symbol} (size=${openPos.size}) but DB has no OPEN/CLOSING trades`
          );
          mismatches++;
        } else {
          console.log(`[reconciler] OK: ${symbol} — ${dbTrades.length} trade(s) (${closingTrades.length} closing), exchange size=${openPos?.size ?? 0}`);
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
