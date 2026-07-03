import { WebsocketClient } from "bybit-api";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { BybitClient, ClosedPnLEntry } from "../exchange/bybit.js";
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
  cumExecQty: string; // actual filled qty (may be < qty for IOC partial fills)
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
  private reconciliationTimer: ReturnType<typeof setInterval> | null = null;
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
    this.startPeriodicReconciliation();
  }

  stop(): void {
    this.stopping = true;
    if (this.balanceTimer !== null) {
      clearInterval(this.balanceTimer);
      this.balanceTimer = null;
    }
    if (this.reconciliationTimer !== null) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    if (this.ws) {
      this.ws.closeAll();
      this.ws = null;
    }
  }

  private startPeriodicReconciliation(): void {
    this.reconciliationTimer = setInterval(() => {
      if (this.stopping) return;
      this.runReconciliation("periodic").catch((err: unknown) =>
        console.error("[reconciler] periodic reconciliation error:", err)
      );
    }, 60_000);
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
  /** Last successfully persisted equity value — used to detect implausible spikes. */
  private lastKnownEquity: number | null = null;

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

    let bal: { equity: number; available: number };
    try {
      bal = await this.bybit.getBalance("USDT");
    } catch (err) {
      // getBalance throws when equity is missing or malformed — skip this snapshot
      console.warn(`[reconciler] snapshot skipped: getBalance failed — ${(err as Error).message}`);
      return;
    }

    // Sanity: skip snapshots that spike or crater implausibly vs the last known good value.
    // A 10× move in one snapshot interval is almost certainly a transient bad read or an
    // open position with an inflated unrealized PnL (e.g. Inf qty). Skipping prevents one
    // bad snapshot from permanently corrupting the equity chart.
    if (this.lastKnownEquity !== null && this.lastKnownEquity > 0) {
      const ratio = bal.equity / this.lastKnownEquity;
      if (ratio > 10 || ratio < 0.1) {
        console.warn(
          `[reconciler] snapshot skipped: equity=${bal.equity.toFixed(2)} vs last=${this.lastKnownEquity.toFixed(2)} (ratio=${ratio.toFixed(2)}) — implausible spike/drop, discarding`
        );
        return;
      }
    }

    this.lastKnownEquity = bal.equity;
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
        const filled = Number(order.cumExecQty) > 0;
        if (!filled) continue;
        if (order.orderStatus === "Filled") {
          // Fully filled: handle entries and reduce-only closes
          if (order.reduceOnly) {
            await this.closeTradesByOrderFill(order);
          } else {
            await this.hydrateOpenTradeFill(order);
          }
        } else if (!order.reduceOnly) {
          // Partially filled IOC entry (status=Cancelled / PartiallyFilledCanceled):
          // hydrate qty/price — we only handle entries here since partial reduce-only
          // closes leave a remaining position that requires reconciler-level handling.
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
    entryFillPrice?: number;
    feeOpenUsd?: number;
  }): Promise<void> {
    const { tradeId, botId, symbol, exitFillPrice, feeCloseUsd, closingOrderId, realizedPnlUsd, pnlSource, entryFillPrice, feeOpenUsd } = params;
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
        ...(entryFillPrice !== undefined ? { entryFillPrice } : {}),
        ...(feeOpenUsd !== undefined ? { feeOpenUsd } : {}),
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

    // 2. Liquidation branch: skip qty match — close all trades on the affected side.
    // Distribute PnL + fees proportionally by qty-share so no single row looks inflated.
    if (isLiquidationCreateType(order.createType)) {
      const liquidationTrades = candidates.filter((t) => t.side === expectedDbSide);
      if (liquidationTrades.length === 0) {
        console.warn(`[reconciler] liquidation ${order.orderId}: no matching trades for ${order.symbol} side=${expectedDbSide}`);
        return;
      }
      const sumQty = liquidationTrades.reduce((acc, t) => acc + t.qty, 0);
      for (const trade of liquidationTrades) {
        const share = sumQty > 0 ? trade.qty / sumQty : 1 / liquidationTrades.length;
        const tradeRealizedPnl = realizedPnlUsd * share;
        const tradeFeeClose   = feeCloseUsd   * share;
        await this.applyCloseExecution({
          tradeId: trade.id,
          botId: trade.botId,
          symbol: order.symbol,
          exitFillPrice,
          feeCloseUsd: tradeFeeClose,
          closingOrderId: order.orderId,
          realizedPnlUsd: tradeRealizedPnl,
          pnlSource: "BYBIT_LIQUIDATION",
        });
        this.bus?.publish({ type: "trade.liquidated", data: { tradeId: trade.id, botId: trade.botId, symbol: order.symbol, realizedPnlUsd: tradeRealizedPnl, createType: order.createType ?? "" } });
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

    // Widen lookup window from oldest open trade's openedAt, capped at 7 days
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const oldestOpenedAt = Math.min(...openTrades.map((t) => t.openedAt.getTime()));
    const startTime = Math.max(Date.now() - sevenDaysMs, oldestOpenedAt - 5 * 60 * 1000);

    const now = new Date();
    const nowMs = now.getTime();

    // 1. Try getClosedPnL first for Bybit's authoritative per-position PnL.
    // A single Bybit position is often made up of N bot Trade rows (stacked signals).
    // Match by the sum of all row qtys, then distribute PnL + fees by qty-share.
    let closedPnlEntries: ClosedPnLEntry[] = [];
    try {
      closedPnlEntries = await this.bybit.getClosedPnL({ symbol, startTime });
    } catch (err) {
      console.warn("[reconciler] closeRemainingOpenTrades: getClosedPnL failed", err);
    }

    // Group by side — each side's rows form one Bybit position
    const tradesBySide = new Map<string, typeof openTrades>();
    for (const trade of openTrades) {
      const existing = tradesBySide.get(trade.side) ?? [];
      existing.push(trade);
      tradesBySide.set(trade.side, existing);
    }

    const unresolvedGroups: [string, typeof openTrades][] = [];

    for (const [side, sideGroup] of tradesBySide) {
      const sideFilter = side === "BUY" ? "Buy" : "Sell";
      const sumQty = sideGroup.reduce((acc, t) => acc + t.qty, 0);
      const minOpenedAt = Math.min(...sideGroup.map((t) => t.openedAt.getTime()));

      // Bybit often splits one position close into multiple partial-fill closedPnl entries
      // (different exit prices as the close order walks the book) — sum every entry in the
      // side+time window rather than requiring a single entry to match the group's qty.
      const windowStart = minOpenedAt - 5 * 60 * 1000;
      const windowEnd = nowMs + 5 * 60 * 1000;
      const windowEntries = closedPnlEntries.filter(
        (e) => e.side === sideFilter && e.updatedTime >= windowStart && e.updatedTime <= windowEnd
      );
      const windowSumQty = windowEntries.reduce((acc, e) => acc + e.qty, 0);
      const isAggregateMatch =
        windowEntries.length > 0 && Math.abs(windowSumQty - sumQty) / Math.max(windowSumQty, sumQty) < 0.005;

      if (isAggregateMatch) {
        const aggClosedPnl = windowEntries.reduce((acc, e) => acc + e.closedPnl, 0);
        const aggOpenFee = windowEntries.reduce((acc, e) => acc + e.openFee, 0);
        const aggCloseFee = windowEntries.reduce((acc, e) => acc + e.closeFee, 0);
        const aggEntryPrice = windowEntries.reduce((acc, e) => acc + e.avgEntryPrice * e.qty, 0) / windowSumQty;
        const aggExitPrice = windowEntries.reduce((acc, e) => acc + e.avgExitPrice * e.qty, 0) / windowSumQty;
        const lastEntry = [...windowEntries].sort((a, b) => b.updatedTime - a.updatedTime)[0]!;
        for (const trade of sideGroup) {
          const share = sumQty > 0 ? trade.qty / sumQty : 1 / sideGroup.length;
          await this.applyCloseExecution({
            tradeId: trade.id,
            botId: trade.botId,
            symbol,
            exitFillPrice: aggExitPrice,
            feeCloseUsd: aggCloseFee * share,
            feeOpenUsd: aggOpenFee * share,
            entryFillPrice: aggEntryPrice,
            closingOrderId: lastEntry.orderId,
            realizedPnlUsd: aggClosedPnl * share,
            pnlSource: "BYBIT_REST",
          });
          console.log(`[reconciler] closedPnl: closed trade #${trade.id} for ${symbol} share=${(share * 100).toFixed(1)}% pnl=${(aggClosedPnl * share).toFixed(4)} (from ${windowEntries.length} fill(s))`);
        }
      } else {
        if (windowEntries.length > 0) {
          console.warn(`[reconciler] closedPnl: ${windowEntries.length} entries found but sumQty=${windowSumQty.toFixed(4)} != expected=${sumQty.toFixed(4)} for ${symbol} side=${side} — falling back to execution list`);
        } else {
          console.warn(`[reconciler] closedPnl: no entries found for ${symbol} side=${side} sumQty=${sumQty} — falling back to execution list`);
        }
        unresolvedGroups.push([side, sideGroup]);
      }
    }

    if (unresolvedGroups.length > 0) {
      // 2. getClosedPnL couldn't resolve these — try the execution list for a real fill
      // price (locally-computed PnL). The close fee applies to the whole position once,
      // not to each constituent trade row — distribute it proportionally by qty-share.
      let exitFillPrice: number | null = null;
      let feeCloseUsd = 0;
      try {
        const execs = await this.bybit.getExecutionList({ symbol, startTime, limit: 100 });
        const closeExec = execs
          .filter((e) => e.closedSize > 0)
          .sort((a, b) => b.execTime - a.execTime)[0];
        if (closeExec) {
          exitFillPrice = closeExec.execPrice;
          feeCloseUsd = closeExec.execFee;
        }
      } catch (err) {
        console.warn("[reconciler] closeRemainingOpenTrades: getExecutionList failed", err);
      }

      const unresolvedTrades = unresolvedGroups.flatMap(([, group]) => group);

      if (exitFillPrice !== null) {
        const sumQty = unresolvedTrades.reduce((acc, t) => acc + t.qty, 0);
        for (const trade of unresolvedTrades) {
          // Notional PnL is naturally per-trade (each row's qty × price delta).
          // Fee is paid once for the whole position — split by qty-share.
          const feeShare = sumQty > 0 ? trade.qty / sumQty : 1 / unresolvedTrades.length;
          const realizedPnlUsd =
            (exitFillPrice - trade.entryPrice) * trade.qty * (trade.side === "BUY" ? 1 : -1) - feeCloseUsd * feeShare;
          await this.db.trade.update({
            where: { id: trade.id },
            data: {
              status: "CLOSED",
              exitPrice: exitFillPrice,
              exitFillPrice,
              pnlUsd: realizedPnlUsd,
              realizedPnlUsd,
              feeCloseUsd: feeCloseUsd * feeShare,
              pnlSource: "EXEC_FALLBACK",
              closedAt: now,
            },
          });
          this.bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd: realizedPnlUsd } });
        }
      } else {
        // 3. No execution data either — mark as phantom (if very recent) or leave PnL
        // unattributed (EXEC_FALLBACK with null PnL), to be resolved by the backfill script.
        for (const trade of unresolvedTrades) {
          const ageMs = nowMs - trade.openedAt.getTime();
          const isPhantom = ageMs < 5_000;
          await this.db.trade.update({
            where: { id: trade.id },
            data: isPhantom
              ? { status: "CLOSED", pnlUsd: 0, realizedPnlUsd: 0, pnlSource: "PHANTOM", closedAt: now }
              : { status: "CLOSED", pnlSource: "EXEC_FALLBACK", closedAt: now },
          });
          if (isPhantom) {
            console.warn(`[reconciler] phantom: trade #${trade.id} for ${symbol} had no Bybit record (age=${ageMs}ms) — marked as PHANTOM`);
          }
          this.bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd: isPhantom ? 0 : null } });
        }
      }
    }

    console.log(`[reconciler] position zero: closed ${openTrades.length} trade(s) for ${symbol}`);
  }

  private async hydrateOpenTradeFill(order: WsOrderUpdate): Promise<void> {
    // Non-reduce-only fill → hydrate entry fields on the matching open trade.
    // Also sync qty to cumExecQty so downstream PnL calculations use the real fill size.
    const entryFillPrice = Number(order.avgPrice);
    if (!entryFillPrice) return;

    const trade = await this.db.trade.findFirst({
      where: { exchangeOrderId: order.orderId, status: { in: ["OPEN", "CLOSING"] } },
    });
    if (!trade) return;

    const cumExecQty = Number(order.cumExecQty);
    await this.db.trade.update({
      where: { id: trade.id },
      data: {
        entryFillPrice,
        feeOpenUsd: Number(order.cumExecFee),
        entryPrice: entryFillPrice,    // keep entryPrice in sync with actual fill
        ...(cumExecQty > 0 ? { qty: cumExecQty } : {}), // reconcile qty to actual fill
      },
    });
    console.log(`[reconciler] open fill: hydrated trade #${trade.id} entryFillPrice=${entryFillPrice} qty=${cumExecQty > 0 ? cumExecQty : trade.qty}`);
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
          console.warn(`[reconciler] MISMATCH: ${dbTrades.length} trade(s) for ${symbol} but exchange has no position — auto-closing`);
          mismatches += dbTrades.length;
          await this.closeRemainingOpenTrades(symbol);
        } else if (openPos && closingTrades.length > 0) {
          // Close order was placed but the position is still open (unfilled order — common on
          // testnet with thin liquidity; also covers crash-restart between order placement and fill).
          // Cancel the stale order so it can't fill late, then force-close the DB trade.
          // In production, market orders fill in <1s so this path only triggers after restarts.
          console.warn(`[reconciler] ${closingTrades.length} CLOSING trade(s) for ${symbol} — close order unresolved, cancelling and force-closing`);
          mismatches += closingTrades.length;
          for (const t of closingTrades) {
            if (t.closingOrderId) {
              await this.bybit.cancelOrder(symbol, t.closingOrderId).catch(() => {
                // already filled, expired, or cancelled — proceed
              });
            }
          }
          await this.closeRemainingOpenTrades(symbol);
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
