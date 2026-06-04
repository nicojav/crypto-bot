#!/usr/bin/env tsx
/**
 * Mark CLOSED trades that have null PnL and were opened+closed within 5 seconds
 * as PHANTOM (pnlUsd=0, realizedPnlUsd=0, pnlSource="PHANTOM").
 *
 * These are local-only records the bot created for positions that never had a
 * matching execution on Bybit. Counting them as 0 PnL is correct — the wallet
 * did not move for these trades.
 *
 * Usage:
 *   npm run mark-phantoms -- --dry-run       # print matches without writing
 *   npm run mark-phantoms -- --symbol XRP    # limit to one symbol
 *   npm run mark-phantoms                     # write changes
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

// Guard against accidental production runs
const isProd = process.env.RAILWAY_ENVIRONMENT_NAME === "production"
  || process.env.DATABASE_URL?.includes("prod");
if (isProd && !dryRun && !process.argv.includes("--confirm-production")) {
  console.error('Refusing to run mark-phantoms on production without --confirm-production');
  process.exit(2);
}

const PHANTOM_AGE_MS = 5_000;

async function main() {
  if (!existsSync(absoluteDbPath)) {
    console.error(`[error] Database file not found: ${absoluteDbPath}`);
    console.error(`        Check DATABASE_URL in ${envPath}`);
    process.exit(1);
  }

  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../generated/prisma/client.js");

  const adapter = new PrismaBetterSqlite3({ url: `file:${absoluteDbPath}` });
  const prisma = new PrismaClient({ adapter });

  console.log("=== Mark Phantom Trades ===");
  console.log(`DB:   ${absoluteDbPath}`);
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "LIVE"}`);
  if (symbolArg) console.log(`Symbol filter: ${symbolArg}`);
  console.log();

  const candidates = await prisma.trade.findMany({
    where: {
      status: "CLOSED",
      realizedPnlUsd: null,
      pnlUsd: null,
      ...(symbolArg ? { symbol: symbolArg } : {}),
    },
    orderBy: { closedAt: "asc" },
  });

  if (candidates.length === 0) {
    console.log("No null-PnL CLOSED trades found.");
    await prisma.$disconnect();
    return;
  }

  let phantoms = 0;
  let skipped = 0;

  for (const trade of candidates) {
    const openedMs = trade.openedAt.getTime();
    const closedMs = (trade.closedAt ?? trade.openedAt).getTime();
    const ageMs = closedMs - openedMs;

    if (ageMs >= PHANTOM_AGE_MS) {
      skipped++;
      continue;
    }

    console.log(
      `  [phantom]  trade #${trade.id} ${trade.symbol} ${trade.side} qty=${trade.qty}` +
      ` opened=${trade.openedAt.toISOString()} closed=${(trade.closedAt ?? trade.openedAt).toISOString()} age=${ageMs}ms`
    );

    if (!dryRun) {
      await prisma.trade.update({
        where: { id: trade.id },
        data: { pnlUsd: 0, realizedPnlUsd: 0, pnlSource: "PHANTOM" },
      });
    }

    phantoms++;
  }

  console.log();
  console.log("=== Summary ===");
  console.log(`  Scanned:  ${candidates.length}`);
  console.log(`  Phantoms: ${phantoms}`);
  console.log(`  Skipped:  ${skipped} (age ≥ ${PHANTOM_AGE_MS}ms — not phantom)`);
  if (dryRun) console.log("\n  (DRY RUN — no changes written)");

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
