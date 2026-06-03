#!/usr/bin/env tsx
/**
 * Backfill realizedPnlUsd for CLOSED trades that have null PnL by matching them
 * against Bybit's closedPnL REST endpoint (covers the last 7 days).
 *
 * Usage:
 *   npm run backfill:pnl -- --dry-run          # print matches without writing
 *   npm run backfill:pnl -- --include-non-null  # also overwrite EXEC_FALLBACK estimates
 *   npm run backfill:pnl -- --symbol XRPUSDT   # limit to one symbol
 *   npm run backfill:pnl                         # write changes
 */
import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { existsSync } from "fs";

// ── Load .env and resolve DATABASE_URL to an absolute path ──────────────────────
// __dirname here is apps/bot/src/scripts/ — .env is two levels up at apps/bot/.env

const envPath = resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

const rawDbUrl = process.env.DATABASE_URL ?? "file:./dev.db";
const absoluteDbPath = rawDbUrl.startsWith("file:/")
  ? rawDbUrl.slice("file:".length)
  : resolve(dirname(envPath), rawDbUrl.slice("file:".length));

// ── CLI flags ────────────────────────────────────────────────────────────────────

const dryRun = process.argv.includes("--dry-run");
const includeNonNull = process.argv.includes("--include-non-null");
const symbolArg = (() => {
  const idx = process.argv.indexOf("--symbol");
  return idx !== -1 ? process.argv[idx + 1] : undefined;
})();

function fmtUsd(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(4) + " USD";
}

// ── Main ─────────────────────────────────────────────────────────────────────────

async function main() {
  if (!existsSync(absoluteDbPath)) {
    console.error(`[error] Database file not found: ${absoluteDbPath}`);
    console.error(`        Check DATABASE_URL in ${envPath}`);
    process.exit(1);
  }

  // Import Prisma adapters directly — never touch db.js (which re-runs dotenv/config
  // and can clobber the absolute path before better-sqlite3 opens the file).
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../generated/prisma/client.js");
  const { BybitClient } = await import("../exchange/bybit.js");

  const adapter = new PrismaBetterSqlite3({ url: `file:${absoluteDbPath}` });
  const prisma = new PrismaClient({ adapter });
  const bybit = new BybitClient();

  console.log("=== Backfill Realized PnL ===");
  console.log(`DB:   ${absoluteDbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  if (includeNonNull) console.log("Including trades that already have a non-null local PnL estimate");
  if (symbolArg) console.log(`Symbol filter: ${symbolArg}`);
  console.log();

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  const where = {
    status: "CLOSED",
    closedAt: { gte: sevenDaysAgo },
    ...(symbolArg ? { symbol: symbolArg } : {}),
    ...(includeNonNull ? {} : { realizedPnlUsd: null, pnlUsd: null }),
  };

  const trades = await prisma.trade.findMany({ where, orderBy: { closedAt: "asc" } });

  if (trades.length === 0) {
    console.log("No candidate trades found.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${trades.length} candidate trade(s)\n`);

  const bySymbol = new Map<string, typeof trades>();
  for (const t of trades) {
    const list = bySymbol.get(t.symbol) ?? [];
    list.push(t);
    bySymbol.set(t.symbol, list);
  }

  let matched = 0;
  let ambiguous = 0;
  let unmatched = 0;
  let overwritten = 0;

  for (const [symbol, symbolTrades] of bySymbol) {
    const oldest = Math.min(...symbolTrades.map((t) => (t.closedAt ?? t.openedAt).getTime()));
    const newest = Math.max(...symbolTrades.map((t) => (t.closedAt ?? t.openedAt).getTime()));
    const startTime = oldest - 60 * 60 * 1000;
    const endTime = newest + 60 * 60 * 1000;

    let closedPnlEntries: Awaited<ReturnType<typeof bybit.getClosedPnL>>;
    try {
      closedPnlEntries = await bybit.getClosedPnL({ symbol, startTime, endTime });
    } catch (err) {
      console.error(`[${symbol}] getClosedPnL failed:`, (err as Error).message);
      unmatched += symbolTrades.length;
      continue;
    }

    for (const trade of symbolTrades) {
      const tradeCloseMs = (trade.closedAt ?? trade.openedAt).getTime();
      const sideFilter = trade.side === "BUY" ? "Buy" : "Sell";

      const candidates = closedPnlEntries.filter(
        (e) =>
          e.side === sideFilter &&
          Math.abs(e.qty - trade.qty) / Math.max(e.qty, trade.qty) < 0.005 &&
          e.updatedTime >= trade.openedAt.getTime() - 5 * 60 * 1000 &&
          e.updatedTime <= tradeCloseMs + 15 * 60 * 1000
      );

      if (candidates.length === 0) {
        console.log(`  [no match]  trade #${trade.id} ${symbol} ${trade.side} qty=${trade.qty} closedAt=${trade.closedAt?.toISOString() ?? "?"}`);
        unmatched++;
      } else if (candidates.length > 1) {
        console.log(`  [ambiguous] trade #${trade.id} ${symbol} ${trade.side} qty=${trade.qty} — ${candidates.length} candidates`);
        ambiguous++;
      } else {
        const entry = candidates[0]!;
        const hadExistingPnl = trade.realizedPnlUsd !== null || trade.pnlUsd !== null;
        console.log(
          `  [match]     trade #${trade.id} ${symbol} ${trade.side} qty=${trade.qty}` +
          ` pnl=${fmtUsd(entry.closedPnl)} openFee=${entry.openFee.toFixed(4)} closeFee=${entry.closeFee.toFixed(4)}` +
          (hadExistingPnl ? ` (was: ${fmtUsd(trade.realizedPnlUsd ?? trade.pnlUsd ?? 0)})` : "")
        );

        if (!dryRun) {
          await prisma.trade.update({
            where: { id: trade.id },
            data: {
              realizedPnlUsd: entry.closedPnl,
              pnlUsd: entry.closedPnl,
              feeCloseUsd: entry.closeFee,
              feeOpenUsd: entry.openFee,
              entryFillPrice: entry.avgEntryPrice,
              exitFillPrice: entry.avgExitPrice,
              exitPrice: entry.avgExitPrice,
              pnlSource: "BYBIT_REST",
              closingOrderId: trade.closingOrderId ?? entry.orderId,
            },
          });
        }

        matched++;
        if (hadExistingPnl) overwritten++;
      }
    }
  }

  console.log();
  console.log("=== Summary ===");
  console.log(`  Scanned:    ${trades.length}`);
  console.log(`  Matched:    ${matched}${overwritten > 0 ? ` (${overwritten} overwrote existing estimate)` : ""}`);
  console.log(`  Ambiguous:  ${ambiguous}`);
  console.log(`  Unmatched:  ${unmatched}`);
  if (dryRun) console.log("\n  (DRY RUN — no changes written)");

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
