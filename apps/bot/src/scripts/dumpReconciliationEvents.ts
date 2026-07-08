#!/usr/bin/env tsx
/**
 * Read-only diagnostic: prints ReconciliationEvent rows (dropped fills, qty drift
 * detected/fixed, phantom promotions, unmatched closedPnl lookups). This table exists
 * because console logs are ephemeral — Railway's log retention doesn't reach back far
 * enough to investigate an anomaly reported days later (confirmed while investigating
 * recurring qty drift on 2026-07-08: `railway logs --since ...` returned nothing for
 * events 2-5 days old). Every anomaly worth investigating later gets persisted here via
 * reconciliation/reconciliationLog.ts, in addition to its console.warn/log.
 *
 * No writes — read-only.
 *
 * Usage:
 *   npm run dump:reconciliation-events                                  # last 7 days, all types
 *   npm run dump:reconciliation-events -- --type QTY_DRIFT_FIXED
 *   npm run dump:reconciliation-events -- --symbol SOLUSDT --since 2026-07-01T00:00:00Z
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

const typeArg = argVal("--type");
const symbolArg = argVal("--symbol");
const sinceArg = argVal("--since");
const since = sinceArg ? new Date(sinceArg) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

async function main() {
  if (!existsSync(absoluteDbPath)) {
    console.error(`[error] Database file not found: ${absoluteDbPath}`);
    process.exit(1);
  }

  const { PrismaBetterSqlite3 } = await import("@prisma/adapter-better-sqlite3");
  const { PrismaClient } = await import("../generated/prisma/client.js");

  const adapter = new PrismaBetterSqlite3({ url: `file:${absoluteDbPath}` });
  const prisma = new PrismaClient({ adapter });

  console.log("=== Reconciliation events (read-only) ===");
  console.log(`Since:  ${since.toISOString()}`);
  if (typeArg) console.log(`Type:   ${typeArg}`);
  if (symbolArg) console.log(`Symbol: ${symbolArg}`);
  console.log();

  const events = await prisma.reconciliationEvent.findMany({
    where: {
      createdAt: { gte: since },
      ...(typeArg ? { type: typeArg } : {}),
      ...(symbolArg ? { symbol: symbolArg } : {}),
    },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${events.length} event(s):\n`);
  for (const e of events) {
    console.log(
      `  [${e.createdAt.toISOString()}] ${e.type}` +
      (e.symbol ? ` symbol=${e.symbol}` : "") +
      (e.tradeId !== null ? ` trade=#${e.tradeId}` : "")
    );
    console.log(`    ${e.message}`);
    if (e.detailsJson) console.log(`    details: ${e.detailsJson}`);
  }

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
