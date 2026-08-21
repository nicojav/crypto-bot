import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { TimeframeId } from "../exchange/bybit.js";

// apps/bot's own root — this file lives at src/storage/dbStats.ts, so two levels up. This
// project compiles to CommonJS (tsconfig.json), so __dirname (not import.meta) is the right tool
// here — same as scripts/repairHistory.ts's equivalent resolution.
const packageRoot = resolve(__dirname, "../..");

/**
 * Resolves a Prisma `DATABASE_URL` (e.g. "file:/data/prod.db" or "file:./dev.db") to an absolute
 * filesystem path, for stat'ing the file directly. Mirrors the resolution logic already used by
 * scripts/repairHistory.ts: an absolute `file:/...` URL is used as-is; a relative one is resolved
 * against apps/bot's own package root (matching where `npm run dev -w apps/bot` / the built
 * `dist/index.js` actually run from), not `process.cwd()`, which can vary by how the process was
 * launched.
 */
export function resolveDbFilePath(databaseUrl: string): string {
  const raw = databaseUrl.startsWith("file:") ? databaseUrl.slice("file:".length) : databaseUrl;
  return raw.startsWith("/") ? raw : resolve(packageRoot, raw);
}

export interface TableStats {
  rowCount: number;
  /** ms epoch of the earliest cached row, or null when the table is empty. */
  oldest: number | null;
  /** ms epoch of the most recent cached row, or null when the table is empty. */
  newest: number | null;
}

export interface StorageStats {
  dbSizeBytes: number;
  volumeSizeBytes: number;
  /** dbSizeBytes / volumeSizeBytes * 100 — computed here once so the periodic monitor and the
   * dashboard banner compare against the exact same number instead of each re-deriving it. */
  percentUsed: number;
  criticalThresholdPct: number;
  candles: TableStats;
  fundingRates: TableStats;
}

/**
 * Reports total DB file size against the configured volume ceiling, plus row counts and date
 * coverage for the two tables that actually grow unbounded (Candle, FundingRate — every new
 * symbol/timeframe/date-range backtested adds more rows, with nothing pruning it otherwise). Live
 * trading tables (Trade, Signal, BalanceSnapshot, ...) aren't broken out here: they grow far more
 * slowly and predictably, and aren't what a "free up space" action would target.
 */
export async function getStorageStats(
  db: PrismaClient,
  dbFilePath: string,
  volumeSizeBytes: number,
  criticalThresholdPct: number,
): Promise<StorageStats> {
  const { size: dbSizeBytes } = statSync(dbFilePath);

  const [candleCount, candleAgg, fundingCount, fundingAgg] = await Promise.all([
    db.candle.count(),
    db.candle.aggregate({ _min: { openTime: true }, _max: { openTime: true } }),
    db.fundingRate.count(),
    db.fundingRate.aggregate({ _min: { fundingTime: true }, _max: { fundingTime: true } }),
  ]);

  return {
    dbSizeBytes,
    volumeSizeBytes,
    percentUsed: (dbSizeBytes / volumeSizeBytes) * 100,
    criticalThresholdPct,
    candles: { rowCount: candleCount, oldest: candleAgg._min.openTime, newest: candleAgg._max.openTime },
    fundingRates: { rowCount: fundingCount, oldest: fundingAgg._min.fundingTime, newest: fundingAgg._max.fundingTime },
  };
}

export interface PruneScope {
  symbol?: string;
  timeframe?: TimeframeId;
}

export interface PruneCounts {
  candles: number;
  fundingRates: number;
}

/** Counts how many rows a prune would delete, without deleting anything — the dry-run half of the
 * preview-then-confirm flow in storageRoutes.ts. */
export async function countPrunableRows(db: PrismaClient, cutoffMs: number, scope: PruneScope = {}): Promise<PruneCounts> {
  const [candles, fundingRates] = await Promise.all([
    db.candle.count({ where: { openTime: { lt: cutoffMs }, ...(scope.symbol ? { symbol: scope.symbol } : {}), ...(scope.timeframe ? { timeframe: scope.timeframe } : {}) } }),
    db.fundingRate.count({ where: { fundingTime: { lt: cutoffMs }, ...(scope.symbol ? { symbol: scope.symbol } : {}) } }),
  ]);
  return { candles, fundingRates };
}

/** Actually deletes rows older than `cutoffMs`, optionally scoped to one symbol/timeframe. Funding
 * rates have no timeframe dimension (see fundingStore.ts), so `scope.timeframe` only narrows the
 * candle deletion. */
export async function pruneOldRows(db: PrismaClient, cutoffMs: number, scope: PruneScope = {}): Promise<PruneCounts> {
  const [candles, fundingRates] = await Promise.all([
    db.candle.deleteMany({ where: { openTime: { lt: cutoffMs }, ...(scope.symbol ? { symbol: scope.symbol } : {}), ...(scope.timeframe ? { timeframe: scope.timeframe } : {}) } }),
    db.fundingRate.deleteMany({ where: { fundingTime: { lt: cutoffMs }, ...(scope.symbol ? { symbol: scope.symbol } : {}) } }),
  ]);
  return { candles: candles.count, fundingRates: fundingRates.count };
}
