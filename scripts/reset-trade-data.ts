#!/usr/bin/env tsx
/**
 * Reset Signals and Trades for a clean strategy-testing slate.
 * Preserves Bot configs and BalanceSnapshots.
 *
 * Local (from apps/bot/):
 *   npm run reset-trade-data              # dry-run
 *   npm run reset-trade-data -- --confirm # actually delete
 *
 * Railway shell:
 *   cd apps/bot && npm run reset-trade-data -- --confirm
 */
import dotenv from "dotenv";
import { resolve } from "path";

// Local dev: load bot's .env. On Railway: env is already in process.env (no-op).
dotenv.config({ path: resolve(__dirname, "../apps/bot/.env") });

async function main() {
  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../apps/bot/src/generated/prisma/client.js");

  const databaseUrl = process.env.DATABASE_URL ?? "file:./dev.db";
  const adapter = new PrismaBetterSqlite3({ url: databaseUrl });
  const prisma = new PrismaClient({ adapter });

  const confirm = process.argv.includes("--confirm");

  const [trades, signals, bots, balances] = await Promise.all([
    prisma.trade.count(),
    prisma.signal.count(),
    prisma.bot.count(),
    prisma.balanceSnapshot.count(),
  ]);

  console.log("=== Reset Trade Data ===");
  console.log(`Database: ${databaseUrl}`);
  console.log();
  console.log("Current row counts:");
  console.log(`  Trades:           ${trades}  (will be deleted)`);
  console.log(`  Signals:          ${signals}  (will be deleted)`);
  console.log(`  Bots:             ${bots}  (preserved)`);
  console.log(`  BalanceSnapshots: ${balances}  (preserved)`);
  console.log();

  if (!confirm) {
    console.log("DRY RUN — re-run with --confirm to delete.");
    await prisma.$disconnect();
    return;
  }

  // Trade has FK to Signal; delete trades first.
  const [deletedTrades, deletedSignals] = await prisma.$transaction([
    prisma.trade.deleteMany({}),
    prisma.signal.deleteMany({}),
  ]);

  console.log(`Deleted ${deletedTrades.count} trade(s).`);
  console.log(`Deleted ${deletedSignals.count} signal(s).`);
  console.log("Done.");

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
