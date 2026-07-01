#!/usr/bin/env tsx
/**
 * One-time history repair script for the Jun 25 PnL / equity-chart spike.
 *
 * Fixes two classes of bad data produced before the calcQty / snapshot guards:
 *
 * 1. BAD BALANCE SNAPSHOTS  — rows where equityUsd is non-finite, negative, zero,
 *    or is a clear outlier spike (> 10× or < 0.1× of the median of nearby rows).
 *    These rows are DELETED so the equity chart no longer shows a phantom $215k jump.
 *
 * 2. BAD TRADE ROWS  — trades where qty is non-finite, or where |pnlUsd| /
 *    |realizedPnlUsd| is implausibly large (> 2 × maxPositionUsd × maxLeverage).
 *    Their pnlUsd / realizedPnlUsd / pnlSource are NULL-ed out so they no longer
 *    feed into the summary or trades table until backfillRealizedPnlGrouped can
 *    re-derive correct values from Bybit.
 *
 * Usage:
 *   npm run repair:history -- --dry-run       # print what would change, no writes
 *   npm run repair:history                     # apply fixes
 *   npm run repair:history -- --from 2026-06-01  # limit to date range
 *   npm run repair:history -- --to   2026-06-26
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

function argAfter(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}
const fromArg = process.argv.find((a) => a.startsWith("--from="))?.slice(7) ?? argAfter("--from");
const toArg   = process.argv.find((a) => a.startsWith("--to="))?.slice(5)   ?? argAfter("--to");

// Spike detection: a snapshot is an outlier when its equityUsd is more than
// this factor above/below the local median (previous 5 valid snapshots).
const SPIKE_RATIO = 5;

// PnL cap: a trade PnL is implausible when |pnl| > PNL_LEVERAGE_FACTOR × bot's
// effective max notional (maxPositionUsd × maxLeverage). We use a conservative 3×
// to leave room for legitimate high-leverage profits without false-positives.
const PNL_LEVERAGE_FACTOR = 3;

process.env.DATABASE_URL = `file:${absoluteDbPath}`;

async function main() {
  if (!existsSync(absoluteDbPath)) {
    console.error(`[error] Database file not found: ${absoluteDbPath}`);
    console.error(`        Check DATABASE_URL in ${envPath}`);
    process.exit(1);
  }

  console.log(`\n=== repairHistory ${dryRun ? "(DRY RUN)" : "(LIVE)"} ===`);
  console.log(`  DATABASE_URL: ${absoluteDbPath}`);
  if (fromArg) console.log(`  from: ${fromArg}`);
  if (toArg)   console.log(`  to:   ${toArg}\n`);

  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../generated/prisma/client.js");
  const adapter = new PrismaBetterSqlite3({ url: `file:${absoluteDbPath}` });
  const prisma = new PrismaClient({ adapter });

  // ── 1. Bad balance snapshots ───────────────────────────────────────────────

  console.log("── Balance snapshots ──────────────────────────────────────────");

  const snapWhere = {
    ...(fromArg || toArg
      ? { takenAt: { ...(fromArg ? { gte: new Date(fromArg) } : {}), ...(toArg ? { lte: new Date(toArg) } : {}) } }
      : {}),
  };

  const allSnaps = await prisma.balanceSnapshot.findMany({
    where: snapWhere,
    orderBy: { takenAt: "asc" },
    select: { id: true, takenAt: true, equityUsd: true, availableUsd: true },
  });

  console.log(`  Total snapshots in window: ${allSnaps.length}`);

  const badSnapIds: number[] = [];

  for (let i = 0; i < allSnaps.length; i++) {
    const snap = allSnaps[i]!;

    // Non-finite or negative equity
    if (!Number.isFinite(snap.equityUsd) || snap.equityUsd < 0) {
      console.log(`  [BAD] snapshot #${snap.id} @ ${snap.takenAt.toISOString()} equity=${snap.equityUsd} — non-finite/negative`);
      badSnapIds.push(snap.id);
      continue;
    }

    // Spike detection: compare to median of up to 5 preceding valid values
    const window = allSnaps
      .slice(Math.max(0, i - 5), i)
      .map((s) => s.equityUsd)
      .filter((v) => Number.isFinite(v) && v > 0);

    if (window.length >= 2) {
      const sorted = [...window].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      const ratio = snap.equityUsd / median;
      if (ratio > SPIKE_RATIO || ratio < 1 / SPIKE_RATIO) {
        console.log(
          `  [SPIKE] snapshot #${snap.id} @ ${snap.takenAt.toISOString()} equity=${snap.equityUsd.toFixed(2)} vs median=${median.toFixed(2)} (ratio=${ratio.toFixed(2)})`
        );
        badSnapIds.push(snap.id);
      }
    }
  }

  console.log(`\n  Bad snapshots to delete: ${badSnapIds.length}`);
  if (badSnapIds.length > 0) {
    if (!dryRun) {
      const deleted = await prisma.balanceSnapshot.deleteMany({ where: { id: { in: badSnapIds } } });
      console.log(`  Deleted: ${deleted.count} snapshot(s)`);
    } else {
      console.log(`  (dry-run — no deletes)`);
    }
  }

  // ── 2. Bad trade rows ──────────────────────────────────────────────────────

  console.log("\n── Trade rows ──────────────────────────────────────────────────");

  const tradeWhere = {
    ...(fromArg || toArg
      ? { openedAt: { ...(fromArg ? { gte: new Date(fromArg) } : {}), ...(toArg ? { lte: new Date(toArg) } : {}) } }
      : {}),
  };

  const trades = await prisma.trade.findMany({
    where: tradeWhere,
    include: { bot: { select: { maxPositionUsd: true, maxLeverage: true } } },
  });

  console.log(`  Total trades in window: ${trades.length}`);

  let fixedCount = 0;

  for (const trade of trades) {
    const maxNotional = trade.bot.maxPositionUsd * trade.bot.maxLeverage;
    const pnl = trade.realizedPnlUsd ?? trade.pnlUsd;

    const qtyBad = !Number.isFinite(trade.qty) || trade.qty <= 0;
    const pnlBad = pnl !== null && (!Number.isFinite(pnl) || Math.abs(pnl) > maxNotional * PNL_LEVERAGE_FACTOR);

    if (qtyBad || pnlBad) {
      console.log(
        `  [BAD] trade #${trade.id} ${trade.symbol} ${trade.side} qty=${trade.qty} pnl=${pnl} pnlSource=${trade.pnlSource} status=${trade.status}` +
        `${qtyBad ? " [INF/BAD QTY]" : ""}${pnlBad ? " [INFLATED PNL]" : ""}`
      );
      fixedCount++;
      if (!dryRun) {
        await prisma.trade.update({
          where: { id: trade.id },
          data: {
            // Null-out bad PnL so the trade shows as unaccounted (needs backfill).
            // Keep qty as-is — changing it retroactively could break reconciliation.
            pnlUsd: pnlBad ? null : undefined,
            realizedPnlUsd: pnlBad ? null : undefined,
            // Clear pnlSource so it doesn't claim to be authoritative
            pnlSource: pnlBad ? null : undefined,
          },
        });
      }
    }
  }

  console.log(`\n  Bad/inflated trade rows patched: ${fixedCount}`);
  if (dryRun && fixedCount > 0) console.log(`  (dry-run — no updates)`);

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log("\n=== Done ===");
  console.log(`  Snapshots deleted: ${dryRun ? 0 : badSnapIds.length} (found ${badSnapIds.length})`);
  console.log(`  Trade rows fixed:  ${dryRun ? 0 : fixedCount} (found ${fixedCount})`);
  if (fixedCount > 0) {
    console.log(
      `\n  Next step: re-run backfill:pnl-grouped to restore authoritative PnL\n` +
      `  for the patched trade rows (they are now unaccounted).\n`
    );
  }

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
