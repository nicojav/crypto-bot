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
 */
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { existsSync } from "fs";

const envPath = resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

const rawDbUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const absoluteDbPath = rawDbUrl.startsWith("file:/")
  ? rawDbUrl.slice("file:".length)
  : resolve(dirname(envPath), rawDbUrl.slice("file:".length));

const dryRun = process.argv.includes("--dry-run");
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

  for (const [key, groupTrades] of groups) {
    const [symbol, side] = key.split("|") as [string, string];
    const sideFilter = side === "BUY" ? "Buy" : "Sell";
    const sumQty = groupTrades.reduce((acc, t) => acc + t.qty, 0);
    const minOpenedAt = Math.min(...groupTrades.map((t) => t.openedAt.getTime()));
    const maxClosedAt = Math.max(...groupTrades.map((t) => (t.closedAt ?? t.openedAt).getTime()));
    const startTime = minOpenedAt - 5 * 60 * 1000;
    const endTime = maxClosedAt + 5 * 60 * 1000;

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

    // Bybit often splits one position close into multiple partial-fill closedPnl entries
    // (different exit prices as the close order walks the book) — sum every entry in the
    // side+time window rather than requiring a single entry to match the group's qty.
    const windowEntries = closedPnlEntries.filter(
      (e) => e.side === sideFilter && e.updatedTime >= startTime && e.updatedTime <= endTime
    );
    const windowSumQty = windowEntries.reduce((acc, e) => acc + e.qty, 0);
    const isAggregateMatch =
      windowEntries.length > 0 && Math.abs(windowSumQty - sumQty) / Math.max(windowSumQty, sumQty) < 0.005;

    if (!isAggregateMatch) {
      if (windowEntries.length === 0) {
        console.log(`  [no match] sumQty=${sumQty.toFixed(4)} — no Bybit entry matched`);
        unmatchedGroups++;
      } else {
        console.log(`  [ambiguous] ${windowEntries.length} Bybit entries found but sumQty=${windowSumQty.toFixed(4)} != expected=${sumQty.toFixed(4)}`);
        ambiguousGroups++;
      }
    } else {
      const aggClosedPnl = windowEntries.reduce((acc, e) => acc + e.closedPnl, 0);
      const aggOpenFee = windowEntries.reduce((acc, e) => acc + e.openFee, 0);
      const aggCloseFee = windowEntries.reduce((acc, e) => acc + e.closeFee, 0);
      const aggEntryPrice = windowEntries.reduce((acc, e) => acc + e.avgEntryPrice * e.qty, 0) / windowSumQty;
      const aggExitPrice = windowEntries.reduce((acc, e) => acc + e.avgExitPrice * e.qty, 0) / windowSumQty;
      const lastEntry = [...windowEntries].sort((a, b) => b.updatedTime - a.updatedTime)[0]!;

      console.log(
        `  [match] pnl=${fmtUsd(aggClosedPnl)} openFee=${aggOpenFee.toFixed(4)} closeFee=${aggCloseFee.toFixed(4)} bybitQty=${windowSumQty.toFixed(4)} (from ${windowEntries.length} fill(s))`
      );

      for (const trade of groupTrades) {
        const share = trade.qty / sumQty;
        const tradeRealizedPnl = aggClosedPnl * share;
        const tradeFeeOpen = aggOpenFee * share;
        const tradeFeeClose = aggCloseFee * share;

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
              entryFillPrice: aggEntryPrice,
              exitFillPrice: aggExitPrice,
              exitPrice: aggExitPrice,
              pnlSource: "BYBIT_REST_GROUPED",
              closingOrderId: trade.closingOrderId ?? lastEntry.orderId,
            },
          });
        }
      }

      matchedGroups++;
      matchedRows += groupTrades.length;
    }

    console.log();
  }

  console.log("=== Summary ===");
  console.log(`  Groups scanned: ${groups.size}`);
  console.log(`  Matched:        ${matchedGroups} (${matchedRows} rows updated)`);
  console.log(`  Ambiguous:      ${ambiguousGroups}`);
  console.log(`  Unmatched:      ${unmatchedGroups}`);
  if (dryRun) console.log("\n  (DRY RUN — no changes written)");

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
