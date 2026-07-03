#!/usr/bin/env tsx
/**
 * Read-only diagnostic: dumps raw Bybit getClosedPnL entries for a symbol/time range
 * side-by-side with our own CLOSED Trade rows in that range, so a human can manually
 * reconcile them without the grouping/matching heuristics in backfillRealizedPnlGrouped.ts.
 *
 * No DB writes. No Bybit orders. GET-only against Bybit's closed-pnl endpoint.
 *
 * Usage:
 *   npm run dump:closed-pnl -- --symbol SOLUSDT --from 2026-07-02T00:00:00Z --to 2026-07-03T16:00:00Z
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

function argVal(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const symbol = argVal("--symbol");
const fromArg = argVal("--from");
const toArg = argVal("--to");

if (!symbol || !fromArg || !toArg) {
  console.error("Usage: dump:closed-pnl -- --symbol SOLUSDT --from <ISO> --to <ISO>");
  process.exit(2);
}

const startTime = new Date(fromArg).getTime();
const endTime = new Date(toArg).getTime();

async function main() {
  if (!existsSync(absoluteDbPath)) {
    console.error(`[error] Database file not found: ${absoluteDbPath}`);
    process.exit(1);
  }

  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../generated/prisma/client.js");
  const { BybitClient } = await import("../exchange/bybit.js");

  const adapter = new PrismaBetterSqlite3({ url: `file:${absoluteDbPath}` });
  const prisma = new PrismaClient({ adapter });
  const bybit = new BybitClient();

  console.log("=== Raw closedPnl dump (read-only) ===");
  console.log(`Symbol: ${symbol}`);
  console.log(`Range:  ${fromArg} -> ${toArg}`);
  console.log();

  const entries = await bybit.getClosedPnL({ symbol, startTime, endTime });
  console.log(`Bybit getClosedPnL entries: ${entries.length}\n`);
  for (const e of [...entries].sort((a, b) => a.updatedTime - b.updatedTime)) {
    console.log(
      `  orderId=${e.orderId} side=${e.side} qty=${e.qty} entry=${e.avgEntryPrice} exit=${e.avgExitPrice} ` +
      `pnl=${e.closedPnl.toFixed(4)} openFee=${e.openFee.toFixed(4)} closeFee=${e.closeFee.toFixed(4)} ` +
      `updatedTime=${new Date(e.updatedTime).toISOString()}`
    );
  }

  console.log();
  const trades = await prisma.trade.findMany({
    where: {
      symbol,
      status: "CLOSED",
      closedAt: { gte: new Date(startTime), lte: new Date(endTime) },
    },
    orderBy: { closedAt: "asc" },
  });
  console.log(`DB CLOSED trades in range: ${trades.length}\n`);
  for (const t of trades) {
    console.log(
      `  #${t.id} side=${t.side} qty=${t.qty} entryPrice=${t.entryPrice} pnlSource=${t.pnlSource} ` +
      `opened=${t.openedAt.toISOString()} closed=${(t.closedAt ?? t.openedAt).toISOString()}`
    );
  }

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
