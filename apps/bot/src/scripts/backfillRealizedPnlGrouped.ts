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
 * PnL/fees proportionally by each row's qty share. The matching/grouping/update logic
 * itself lives in ../reconciliation/pnlBackfill.ts (shared with the reconciler's
 * periodic retry — see reconciliation/reconciler.ts runPnlBackfill) — this script is a
 * thin CLI wrapper around it.
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
import { backfillClosedPnl, type PnlBackfillReporter } from "../reconciliation/pnlBackfill.js";

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

function makeCliReporter(): PnlBackfillReporter {
  return {
    onStart(candidateCount, groupCount) {
      if (candidateCount === 0) {
        console.log("No EXEC_FALLBACK or null-source CLOSED trades found.");
        return;
      }
      console.log(`Found ${candidateCount} candidate trade(s) — grouping by (symbol, side, closedAt minute)...\n`);
      console.log(`Formed ${groupCount} group(s):\n`);
    },
    onGroupStart(symbol, side, groupTrades, sumQty) {
      console.log(`  Group: ${symbol} ${side} rows=${groupTrades.length} sumQty=${sumQty.toFixed(4)}`);
      groupTrades.forEach((t) =>
        console.log(`    trade #${t.id} qty=${t.qty} opened=${t.openedAt.toISOString()} closed=${(t.closedAt ?? t.openedAt).toISOString()}`)
      );
    },
    onGroupOutcome(outcome) {
      switch (outcome.kind) {
        case "matched": {
          const { match, distribution } = outcome;
          console.log(
            `  [match ${match.mode}] pnl=${fmtUsd(match.closedPnl)} openFee=${match.openFee.toFixed(4)} closeFee=${match.closeFee.toFixed(4)} bybitQty=${match.qty.toFixed(4)} (from ${match.entries.length} fill(s), orderId(s)=${match.entries.map((e) => e.orderId).join(",")})`
          );
          for (const { trade, share, pnl, feeOpen, feeClose } of distribution) {
            console.log(
              `    → trade #${trade.id} qty=${trade.qty} share=${(share * 100).toFixed(1)}%` +
              ` pnl=${fmtUsd(pnl)} feeOpen=${feeOpen.toFixed(4)} feeClose=${feeClose.toFixed(4)}`
            );
          }
          break;
        }
        case "qtyFix": {
          const { trade, entry, applied } = outcome;
          const diff = entry.qty - trade.qty;
          console.log(
            `  [qty-fix ${applied ? "applying" : "available, rerun with --allow-qty-fix"}] ` +
            `trade #${trade.id} DB qty=${trade.qty} → Bybit qty=${entry.qty} (diff ${diff >= 0 ? "+" : ""}${diff.toFixed(4)}) ` +
            `orderId=${entry.orderId} pnl=${fmtUsd(entry.closedPnl)}`
          );
          break;
        }
        case "ambiguous": {
          const windowSumQty = outcome.windowEntries.reduce((acc, e) => acc + e.qty, 0);
          console.log(`  [ambiguous] ${outcome.windowEntries.length} Bybit entries found but sumQty=${windowSumQty.toFixed(4)} != expected=${outcome.sumQty.toFixed(4)}`);
          break;
        }
        case "unmatched":
          console.log(`  [no match] sumQty=${outcome.sumQty.toFixed(4)} — no Bybit entry matched`);
          break;
        case "error":
          console.error(`  [error] getClosedPnL failed: ${outcome.error.message}`);
          break;
      }
      console.log();
    },
  };
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

  const result = await backfillClosedPnl(prisma, bybit, {
    since: sevenDaysAgo,
    symbol: symbolArg,
    dryRun,
    allowQtyFix,
    reporter: makeCliReporter(),
  });

  if (result.candidatesScanned > 0) {
    console.log("=== Summary ===");
    console.log(`  Groups scanned:    ${result.groupsScanned}`);
    console.log(`  Matched:           ${result.matchedGroups} (${result.matchedRows} rows updated)`);
    console.log(`  Qty-fixed:         ${result.qtyFixed}`);
    console.log(`  Qty-fix available: ${result.qtyFixAvailable}${result.qtyFixAvailable > 0 && !allowQtyFix ? " (rerun with --allow-qty-fix to apply)" : ""}`);
    console.log(`  Ambiguous:         ${result.ambiguousGroups}`);
    console.log(`  Unmatched:         ${result.unmatchedGroups}`);
    if (dryRun) console.log("\n  (DRY RUN — no changes written)");
  }

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
