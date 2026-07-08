import type { PrismaClient, Trade } from "../generated/prisma/client.js";
import type { BybitClient, ClosedPnLEntry } from "../exchange/bybit.js";
import type { EventBus } from "../eventBus.js";
import { matchClosedPnl, type ClosedPnlMatch } from "./closedPnlMatcher.js";

/**
 * Shared core of the grouped PnL backfill: finds CLOSED trades with an untrusted
 * pnlSource (EXEC_FALLBACK or null), groups them by (symbol, side, closedAt-minute),
 * and resolves each group's real PnL via Bybit's getClosedPnL — using the same
 * matchClosedPnl logic as the live reconciler.
 *
 * Used by two callers:
 *   - the manual CLI script (apps/bot/src/scripts/backfillRealizedPnlGrouped.ts),
 *     which supplies a reporter to keep its existing console output.
 *   - the reconciler's periodic retry (reconciliation/reconciler.ts runPnlBackfill),
 *     which closes the gap left by closeRemainingOpenTrades' one-shot live attempt
 *     (Bybit's closedPnl endpoint can lag a just-closed position by a few minutes).
 */

export type PnlBackfillGroupOutcome =
  | {
      kind: "matched";
      symbol: string;
      side: string;
      groupTrades: Trade[];
      sumQty: number;
      match: ClosedPnlMatch;
      distribution: { trade: Trade; share: number; pnl: number; feeOpen: number; feeClose: number }[];
    }
  | { kind: "qtyFix"; symbol: string; side: string; trade: Trade; entry: ClosedPnLEntry; applied: boolean }
  | { kind: "ambiguous"; symbol: string; side: string; sumQty: number; windowEntries: ClosedPnLEntry[] }
  | { kind: "unmatched"; symbol: string; side: string; sumQty: number }
  | { kind: "error"; symbol: string; side: string; error: Error };

export interface PnlBackfillReporter {
  onStart?(candidateCount: number, groupCount: number): void;
  onGroupStart?(symbol: string, side: string, groupTrades: Trade[], sumQty: number): void;
  onGroupOutcome?(outcome: PnlBackfillGroupOutcome): void;
}

export interface PnlBackfillOptions {
  /** Lower bound on closedAt for the candidate query. */
  since: Date;
  symbol?: string;
  dryRun?: boolean;
  /** Apply the qty correction on unambiguous single-row/single-entry mismatches. */
  allowQtyFix?: boolean;
  reporter?: PnlBackfillReporter;
  /** When supplied, publishes trade.closed for each row updated. */
  bus?: EventBus;
}

export interface PnlBackfillResult {
  candidatesScanned: number;
  groupsScanned: number;
  matchedGroups: number;
  matchedRows: number;
  qtyFixed: number;
  qtyFixAvailable: number;
  ambiguousGroups: number;
  unmatchedGroups: number;
}

export async function backfillClosedPnl(
  db: PrismaClient,
  bybit: BybitClient,
  opts: PnlBackfillOptions,
): Promise<PnlBackfillResult> {
  const { since, symbol: symbolArg, dryRun = false, allowQtyFix = false, reporter, bus } = opts;

  const result: PnlBackfillResult = {
    candidatesScanned: 0,
    groupsScanned: 0,
    matchedGroups: 0,
    matchedRows: 0,
    qtyFixed: 0,
    qtyFixAvailable: 0,
    ambiguousGroups: 0,
    unmatchedGroups: 0,
  };

  // Target rows with an untrusted PnL source: EXEC_FALLBACK (locally-estimated, possibly
  // inflated) and null-source (never attributed). PHANTOM and already-trusted sources
  // (BYBIT_WS/BYBIT_REST/BYBIT_REST_GROUPED/BYBIT_REST_GROUPED_QTY_FIX) are left untouched.
  const candidates = await db.trade.findMany({
    where: {
      status: "CLOSED",
      closedAt: { gte: since },
      OR: [{ pnlSource: "EXEC_FALLBACK" }, { pnlSource: null }],
      ...(symbolArg ? { symbol: symbolArg } : {}),
    },
    orderBy: { closedAt: "asc" },
  });
  result.candidatesScanned = candidates.length;

  if (candidates.length === 0) {
    reporter?.onStart?.(0, 0);
    return result;
  }

  // Group by (symbol, side, floor(closedAt / 60s))
  const groups = new Map<string, Trade[]>();
  for (const trade of candidates) {
    const closedMs = (trade.closedAt ?? trade.openedAt).getTime();
    const bucket = Math.floor(closedMs / 60_000);
    const key = `${trade.symbol}|${trade.side}|${bucket}`;
    const list = groups.get(key) ?? [];
    list.push(trade);
    groups.set(key, list);
  }
  result.groupsScanned = groups.size;
  reporter?.onStart?.(candidates.length, groups.size);

  for (const [key, groupTrades] of groups) {
    const [symbol, side] = key.split("|") as [string, string];
    // getClosedPnL's "side" is the closing order's side, opposite of the position/DB
    // side (same convention as dbSideForClosingOrder in reconciler.ts — verified
    // empirically: a DB BUY trade's close is reported with side="Sell", and vice versa).
    const sideFilter = side === "BUY" ? "Sell" : "Buy";
    const sumQty = groupTrades.reduce((acc, t) => acc + t.qty, 0);
    // Each row's closedAt is already known precisely for a backfill — anchor the window
    // on that (not openedAt, which for long-held trades can be hours earlier and pulls
    // in unrelated closes that happen to sit nearby in time; confirmed in prod).
    const minClosedAt = Math.min(...groupTrades.map((t) => (t.closedAt ?? t.openedAt).getTime()));
    const maxClosedAt = Math.max(...groupTrades.map((t) => (t.closedAt ?? t.openedAt).getTime()));
    const startTime = minClosedAt - 10 * 60 * 1000;
    const endTime = maxClosedAt + 10 * 60 * 1000;

    reporter?.onGroupStart?.(symbol, side, groupTrades, sumQty);

    let closedPnlEntries: ClosedPnLEntry[];
    try {
      closedPnlEntries = await bybit.getClosedPnL({ symbol, startTime, endTime });
    } catch (err) {
      result.unmatchedGroups++;
      reporter?.onGroupOutcome?.({ kind: "error", symbol, side, error: err as Error });
      continue;
    }

    const windowEntries = closedPnlEntries.filter(
      (e) => e.side === sideFilter && e.updatedTime >= startTime && e.updatedTime <= endTime
    );
    const match = matchClosedPnl(windowEntries, sumQty);

    if (match) {
      const distribution = groupTrades.map((trade) => {
        const share = trade.qty / sumQty;
        return {
          trade,
          share,
          pnl: match.closedPnl * share,
          feeOpen: match.openFee * share,
          feeClose: match.closeFee * share,
        };
      });

      for (const { trade, pnl, feeOpen, feeClose } of distribution) {
        if (!dryRun) {
          await db.trade.update({
            where: { id: trade.id },
            data: {
              realizedPnlUsd: pnl,
              pnlUsd: pnl,
              feeOpenUsd: feeOpen,
              feeCloseUsd: feeClose,
              entryFillPrice: match.avgEntryPrice,
              exitFillPrice: match.avgExitPrice,
              exitPrice: match.avgExitPrice,
              pnlSource: "BYBIT_REST_GROUPED",
              closingOrderId: trade.closingOrderId ?? match.lastEntry.orderId,
            },
          });
          bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd: pnl } });
        }
      }

      result.matchedGroups++;
      result.matchedRows += groupTrades.length;
      reporter?.onGroupOutcome?.({ kind: "matched", symbol, side, groupTrades, sumQty, match, distribution });
    } else if (groupTrades.length === 1 && windowEntries.length === 1) {
      // No ambiguity about WHICH entry belongs here (exactly one DB row, exactly one
      // Bybit entry in the window) — only the qty disagrees. This is a known bug where
      // a trade's own fill was under-recorded (see bybit.ts getOrderFill fix) and the
      // real executed size only surfaces later in Bybit's closedPnl data. Since there's
      // no ambiguity, the lone entry is authoritative for qty too — but this rewrites a
      // previously-recorded historical fact, so it's gated behind allowQtyFix.
      const trade = groupTrades[0]!;
      const entry = windowEntries[0]!;

      if (allowQtyFix) {
        if (!dryRun) {
          await db.trade.update({
            where: { id: trade.id },
            data: {
              qty: entry.qty,
              realizedPnlUsd: entry.closedPnl,
              pnlUsd: entry.closedPnl,
              feeOpenUsd: entry.openFee,
              feeCloseUsd: entry.closeFee,
              entryFillPrice: entry.avgEntryPrice,
              exitFillPrice: entry.avgExitPrice,
              exitPrice: entry.avgExitPrice,
              pnlSource: "BYBIT_REST_GROUPED_QTY_FIX",
              closingOrderId: trade.closingOrderId ?? entry.orderId,
            },
          });
          bus?.publish({ type: "trade.closed", data: { tradeId: trade.id, botId: trade.botId, symbol, pnlUsd: entry.closedPnl } });
        }
        result.qtyFixed++;
      } else {
        result.qtyFixAvailable++;
      }
      reporter?.onGroupOutcome?.({ kind: "qtyFix", symbol, side, trade, entry, applied: allowQtyFix });
    } else if (windowEntries.length === 0) {
      result.unmatchedGroups++;
      reporter?.onGroupOutcome?.({ kind: "unmatched", symbol, side, sumQty });
    } else {
      result.ambiguousGroups++;
      reporter?.onGroupOutcome?.({ kind: "ambiguous", symbol, side, sumQty, windowEntries });
    }
  }

  return result;
}
