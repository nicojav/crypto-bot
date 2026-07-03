import type { ClosedPnLEntry } from "../exchange/bybit.js";

/**
 * Matches a set of side+time-window-filtered Bybit closedPnl entries against a target
 * qty (typically the sum of one or more DB Trade rows being closed together).
 *
 * Strategy:
 *   1. Single-entry preference — if any one entry's qty already reconciles with the
 *      target within tolerance, use that entry ALONE. This avoids blindly summing
 *      unrelated entries that happen to share the same side+window (confirmed in
 *      prod: a wide window can pull in a different position's close that coincidentally
 *      sits nearby in time — summing it in produces a false "no match").
 *   2. Aggregate fallback — only if no single entry matches, sum every entry in the
 *      window and check whether the aggregate reconciles. This is a safety net for a
 *      genuine multi-fill split of one close (Bybit can report one position's close as
 *      several partial-fill records at different prices) — no confirmed real-world case
 *      of this yet, but kept in case one occurs.
 *   3. No match — caller decides how to handle (ambiguous / qty-fix / fallback).
 */

export interface ClosedPnlMatch {
  mode: "single" | "aggregate";
  entries: ClosedPnLEntry[];
  qty: number;
  closedPnl: number;
  openFee: number;
  closeFee: number;
  avgEntryPrice: number;
  avgExitPrice: number;
  /** Most recent entry by updatedTime — used as the closingOrderId reference. */
  lastEntry: ClosedPnLEntry;
}

function withinTolerance(a: number, b: number, tolerance: number): boolean {
  return Math.abs(a - b) / Math.max(a, b) < tolerance;
}

function buildMatch(entries: ClosedPnLEntry[], mode: "single" | "aggregate"): ClosedPnlMatch {
  const qty = entries.reduce((acc, e) => acc + e.qty, 0);
  const closedPnl = entries.reduce((acc, e) => acc + e.closedPnl, 0);
  const openFee = entries.reduce((acc, e) => acc + e.openFee, 0);
  const closeFee = entries.reduce((acc, e) => acc + e.closeFee, 0);
  const avgEntryPrice = entries.reduce((acc, e) => acc + e.avgEntryPrice * e.qty, 0) / qty;
  const avgExitPrice = entries.reduce((acc, e) => acc + e.avgExitPrice * e.qty, 0) / qty;
  const lastEntry = [...entries].sort((a, b) => b.updatedTime - a.updatedTime)[0]!;
  return { mode, entries, qty, closedPnl, openFee, closeFee, avgEntryPrice, avgExitPrice, lastEntry };
}

export function matchClosedPnl(
  entries: ClosedPnLEntry[],
  targetQty: number,
  tolerance = 0.005
): ClosedPnlMatch | null {
  const singleMatches = entries.filter((e) => withinTolerance(e.qty, targetQty, tolerance));
  if (singleMatches.length > 0) {
    const best = singleMatches.reduce((a, b) =>
      Math.abs(a.qty - targetQty) <= Math.abs(b.qty - targetQty) ? a : b
    );
    return buildMatch([best], "single");
  }

  if (entries.length > 0) {
    const sumQty = entries.reduce((acc, e) => acc + e.qty, 0);
    if (withinTolerance(sumQty, targetQty, tolerance)) {
      return buildMatch(entries, "aggregate");
    }
  }

  return null;
}
