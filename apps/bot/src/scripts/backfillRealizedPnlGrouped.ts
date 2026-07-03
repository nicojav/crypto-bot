#!/usr/bin/env tsx
/**
 * Grouped PnL backfill for trades that the per-row backfill couldn't match.
 *
 * Root cause: when TradingView fires N same-side signals, the bot creates N Trade rows
 * that aggregate into 1 Bybit position. Bybit's closedPnL returns ONE entry whose qty
 * equals the TOTAL position — the per-row qty matcher rejects all N rows.
 *
 * This script groups Trade rows by (symbol, side, closedAt-minute-bucket), sums their
 * qtys, matches the sum against Bybit's closedPnL, and distributes the returned
 * PnL/fees proportionally by each row's qty share.
 *
 * Usage:
 *   npm run backfill:pnl-grouped -- --dry-run       # print matches without writing
 *   npm run backfill:pnl-grouped -- --symbol SOLUSDT
 *   npm run backfill:pnl-grouped                     # write changes
 *   npm run backfill:pnl-grouped -- --allow-qty-fix   # also correct qty on single-row
 *                                                       groups where the DB qty disagrees
 *                                                       with Bybit's real qty (see below)
 *
 * --allow-qty-fix: a separate opt-in flag (in addition to --confirm-production for a
 * live run) required to correct a trade's `qty` field, not just its PnL. This can happen
 * when a trade's own fill was under-recorded (e.g. a premature zero-read during entry —
 * see bybit.ts getOrderFill) and the real executed size only shows up later in Bybit's
 * closedPnl data. Only applied when there is NO ambiguity: exactly one DB row in the
 * group and exactly one Bybit entry in its window. Tagged with a distinct pnlSource
 * (BYBIT_REST_GROUPED_QTY_FIX) so the qty rewrite is permanently auditable. Without this
 * flag, such rows are reported as "[qty-fix available]" but left untouched.
 */
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { existsSync } from "fs";
import { matchClosedPnl } from "../reconciliation/closedPnlMatcher.js";

const envPath = resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

const rawDbUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const absoluteDbPath = rawDbUrl.startsWith("file:/")
  ? rawDbUrl.slice("file:".length)
  : resolve(dirname(envPath), rawDbUrl.slice("file:".length));

const dryRun = process.argv.includes("--dry-run");
const allowQtyFix = process.argv.includes("--allow-qty-fix");
const symbolArg = (() => {
  const idx = process.argv.indexOf("--symbol");
  return idx !== -1 ? process.argv[idx + 1] : undefined;
})();

const isProd = process.env.RAILWAY_ENVIRONMENT_NAME === "production"
  || process.env.DATABASE_URL?.includes("prod");
if (isProd && !dryRun && !process.argv.includes("--confirm-production")) {
  console.error("Refusing to run backfill:pnl-grouped on production without --confirm-production");
  process.exit(2);
}

function fmtUsd(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(4) + " USD";
}

async function main() {
  if (!existsSync(absoluteDbPath)) {
    console.error(`[error] Database file not found: ${absoluteDbPath}`);
    console.error(`        Check DATABASE_URL in ${envPath}`);
    process.exit(1);
  }

  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../generated/prisma/client.js");
  const { BybitClient } = await import("../exchange/bybit.js");

  const adapter = new PrismaBetterSqlite3({ url: `file:${absoluteDbPath}` });
  const prisma = new PrismaClient({ adapter });
  const bybit = new BybitClient();

  console.log("=== Grouped PnL Backfill ===");
  console.log(`DB:   ${absoluteDbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  if (symbolArg) console.log(`Symbol filter: ${symbolArg}`);
  console.log();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Target rows with an untrusted PnL source: EXEC_FALLBACK (locally-estimated, possibly
  // inflated) and null-source (never attributed). PHANTOM and already-trusted sources
  // (BYBIT_WS/BYBIT_REST/BYBIT_REST_GROUPED) are left untouched.
  const candidates = await prisma.trade.findMany({
    where: {
      status: "CLOSED",
      closedAt: { gte: sevenDaysAgo },
      OR: [{ pnlSource: "EXEC_FALLBACK" }, { pnlSource: null }],
      ...(symbolArg ? { symbol: symbolArg } : {}),
    },
    orderBy: { closedAt: "asc" },
  });

  if (candidates.length === 0) {
    console.log("No EXEC_FALLBACK or null-source CLOSED trades found.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${candidates.length} candidate trade(s) — grouping by (symbol, side, closedAt minute)...\n`);

  // Group by (symbol, side, floor(closedAt / 60s))
  const groups = new Map<string, typeof candidates>();
  for (const trade of candidates) {
    const closedMs = (trade.closedAt ?? trade.openedAt).getTime();
    const bucket = Math.floor(closedMs / 60_000);
    const key = `${trade.symbol}|${trade.side}|${bucket}`;
    const list = groups.get(key) ?? [];
    list.push(trade);
    groups.set(key, list);
  }

  console.log(`Formed ${groups.size} group(s):\n`);

  let matchedGroups = 0;
  let matchedRows = 0;
  let ambiguousGroups = 0;
  let unmatchedGroups = 0;
  let qtyFixed = 0;
  let qtyFixAvailable = 0;

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

    console.log(`  Group: ${symbol} ${side} rows=${groupTrades.length} sumQty=${sumQty.toFixed(4)}`);
    groupTrades.forEach((t) =>
      console.log(`    trade #${t.id} qty=${t.qty} opened=${t.openedAt.toISOString()} closed=${(t.closedAt ?? t.openedAt).toISOString()}`)
    );

    let closedPnlEntries: Awaited<ReturnType<typeof bybit.getClosedPnL>>;
    try {
      closedPnlEntries = await bybit.getClosedPnL({ symbol, startTime, endTime });
    } catch (err) {
      console.error(`  [error] getClosedPnL failed: ${(err as Error).message}`);
      unmatchedGroups++;
      console.log();
      continue;
    }

    const windowEntries = closedPnlEntries.filter(
      (e) => e.side === sideFilter && e.updatedTime >= startTime && e.updatedTime <= endTime
    );
    const match = matchClosedPnl(windowEntries, sumQty);

    if (match) {
      console.log(
        `  [match ${match.mode}] pnl=${fmtUsd(match.closedPnl)} openFee=${match.openFee.toFixed(4)} closeFee=${match.closeFee.toFixed(4)} bybitQty=${match.qty.toFixed(4)} (from ${match.entries.length} fill(s), orderId(s)=${match.entries.map((e) => e.orderId).join(",")})`
      );

      for (const trade of groupTrades) {
        const share = trade.qty / sumQty;
        const tradeRealizedPnl = match.closedPnl * share;
        const tradeFeeOpen = match.openFee * share;
        const tradeFeeClose = match.closeFee * share;

        console.log(
          `    → trade #${trade.id} qty=${trade.qty} share=${(share * 100).toFixed(1)}%` +
          ` pnl=${fmtUsd(tradeRealizedPnl)} feeOpen=${tradeFeeOpen.toFixed(4)} feeClose=${tradeFeeClose.toFixed(4)}`
        );

        if (!dryRun) {
          await prisma.trade.update({
            where: { id: trade.id },
            data: {
              realizedPnlUsd: tradeRealizedPnl,
              pnlUsd: tradeRealizedPnl,
              feeOpenUsd: tradeFeeOpen,
              feeCloseUsd: tradeFeeClose,
              entryFillPrice: match.avgEntryPrice,
              exitFillPrice: match.avgExitPrice,
              exitPrice: match.avgExitPrice,
              pnlSource: "BYBIT_REST_GROUPED",
              closingOrderId: trade.closingOrderId ?? match.lastEntry.orderId,
            },
          });
        }
      }

      matchedGroups++;
      matchedRows += groupTrades.length;
    } else if (groupTrades.length === 1 && windowEntries.length === 1) {
      // No ambiguity about WHICH entry belongs here (exactly one DB row, exactly one
      // Bybit entry in the window) — only the qty disagrees. This is a known bug where
      // a trade's own fill was under-recorded (see bybit.ts getOrderFill fix) and the
      // real executed size only surfaces later in Bybit's closedPnl data. Since there's
      // no ambiguity, the lone entry is authoritative for qty too — but this rewrites a
      // previously-recorded historical fact, so it's gated behind --allow-qty-fix.
      const trade = groupTrades[0]!;
      const entry = windowEntries[0]!;
      const diff = entry.qty - trade.qty;
      console.log(
        `  [qty-fix ${allowQtyFix ? "applying" : "available, rerun with --allow-qty-fix"}] ` +
        `trade #${trade.id} DB qty=${trade.qty} → Bybit qty=${entry.qty} (diff ${diff >= 0 ? "+" : ""}${diff.toFixed(4)}) ` +
        `orderId=${entry.orderId} pnl=${fmtUsd(entry.closedPnl)}`
      );

      if (allowQtyFix) {
        if (!dryRun) {
          await prisma.trade.update({
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
        }
        qtyFixed++;
      } else {
        qtyFixAvailable++;
      }
    } else {
      const windowSumQty = windowEntries.reduce((acc, e) => acc + e.qty, 0);
      if (windowEntries.length === 0) {
        console.log(`  [no match] sumQty=${sumQty.toFixed(4)} — no Bybit entry matched`);
        unmatchedGroups++;
      } else {
        console.log(`  [ambiguous] ${windowEntries.length} Bybit entries found but sumQty=${windowSumQty.toFixed(4)} != expected=${sumQty.toFixed(4)}`);
        ambiguousGroups++;
      }
    }

    console.log();
  }

  console.log("=== Summary ===");
  console.log(`  Groups scanned:    ${groups.size}`);
  console.log(`  Matched:           ${matchedGroups} (${matchedRows} rows updated)`);
  console.log(`  Qty-fixed:         ${qtyFixed}`);
  console.log(`  Qty-fix available: ${qtyFixAvailable}${qtyFixAvailable > 0 && !allowQtyFix ? " (rerun with --allow-qty-fix to apply)" : ""}`);
  console.log(`  Ambiguous:         ${ambiguousGroups}`);
  console.log(`  Unmatched:         ${unmatchedGroups}`);
  if (dryRun) console.log("\n  (DRY RUN — no changes written)");

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
