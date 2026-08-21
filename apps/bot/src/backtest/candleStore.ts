import type { PrismaClient } from "../generated/prisma/client.js";
import type { Kline, TimeframeId } from "../exchange/bybit.js";
import { TIMEFRAME_MS } from "../exchange/bybit.js";
import type { Candle } from "./types.js";

// Minimal interface — BybitClient satisfies this structurally (mirrors the Exchange
// pattern in processor/signalProcessor.ts, keeps this module testable without a real client).
export interface CandleSource {
  getKline(symbol: string, timeframe: TimeframeId, startMs: number, endMs: number): Promise<Kline[]>;
}

/**
 * Inserts klines for symbol+timeframe, skipping any (symbol, timeframe, openTime) already
 * cached. Prisma's createMany `skipDuplicates` isn't supported on SQLite, and without it a
 * single conflicting row fails the *whole* batch (SQLite has no partial-insert semantics here),
 * silently dropping otherwise-new rows too — so duplicates are filtered out beforehand instead.
 * Needed both for a plain overlapping re-fetch and for the mid-range gap repair below, where the
 * repaired range's boundary candle can coincide with one already on disk.
 */
async function insertCandlesSkippingDuplicates(
  db: PrismaClient,
  symbol: string,
  timeframe: TimeframeId,
  klines: readonly Kline[],
): Promise<void> {
  if (klines.length === 0) return;
  const existing = await db.candle.findMany({
    where: { symbol, timeframe, openTime: { in: klines.map((k) => k.openTime) } },
    select: { openTime: true },
  });
  const existingTimes = new Set(existing.map((r) => r.openTime));
  const toInsert = klines.filter((k) => !existingTimes.has(k.openTime));
  if (toInsert.length === 0) return;
  await db.candle.createMany({
    data: toInsert.map((k) => ({ symbol, timeframe, ...k })),
  });
}

/**
 * Ensures the [fromMs, toMs] window is cached in the Candle table for symbol+timeframe,
 * downloading only what's missing, then returns the full requested slice.
 *
 * Coverage is tracked two ways: the min/max cached openTime catches gaps at the *edges* of the
 * requested window (extending an already-cached range backward/forward — the common case, since
 * this tool grows the cached window over time), and a second pass scans the now-edge-filled rows
 * for any consecutive pair further apart than one interval — a hole punched in the *middle* of an
 * already-cached range (e.g. a Bybit outage mid-fetch on a prior call). Left undetected, a
 * mid-range gap silently shifts every subsequent bar index for anything reading this range
 * (indicator warm-up, trade entry bars, everything) with no error or warning anywhere.
 */
export async function ensureCandles(
  db: PrismaClient,
  bybit: CandleSource,
  symbol: string,
  timeframe: TimeframeId,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const intervalMs = TIMEFRAME_MS[timeframe];

  const [existingMin, existingMax] = await Promise.all([
    db.candle.findFirst({ where: { symbol, timeframe }, orderBy: { openTime: "asc" } }),
    db.candle.findFirst({ where: { symbol, timeframe }, orderBy: { openTime: "desc" } }),
  ]);

  const edgeGaps: Array<{ start: number; end: number }> = [];
  if (!existingMin || !existingMax) {
    edgeGaps.push({ start: fromMs, end: toMs });
  } else {
    if (fromMs < existingMin.openTime) {
      edgeGaps.push({ start: fromMs, end: Math.min(existingMin.openTime - intervalMs, toMs) });
    }
    if (toMs > existingMax.openTime) {
      edgeGaps.push({ start: Math.max(existingMax.openTime + intervalMs, fromMs), end: toMs });
    }
  }

  for (const gap of edgeGaps) {
    if (gap.start > gap.end) continue;
    const klines = await bybit.getKline(symbol, timeframe, gap.start, gap.end);
    await insertCandlesSkippingDuplicates(db, symbol, timeframe, klines);
  }

  let rows = await db.candle.findMany({
    where: { symbol, timeframe, openTime: { gte: fromMs, lte: toMs } },
    orderBy: { openTime: "asc" },
  });

  const midGaps: Array<{ start: number; end: number }> = [];
  for (let i = 0; i + 1 < rows.length; i++) {
    const delta = rows[i + 1]!.openTime - rows[i]!.openTime;
    if (delta > intervalMs) {
      midGaps.push({ start: rows[i]!.openTime + intervalMs, end: rows[i + 1]!.openTime - intervalMs });
    }
  }

  if (midGaps.length > 0) {
    for (const gap of midGaps) {
      const klines = await bybit.getKline(symbol, timeframe, gap.start, gap.end);
      await insertCandlesSkippingDuplicates(db, symbol, timeframe, klines);
    }
    // Only re-read when a repair actually happened — the common case (no mid-range gap) costs
    // nothing beyond the single read every call already did.
    rows = await db.candle.findMany({
      where: { symbol, timeframe, openTime: { gte: fromMs, lte: toMs } },
      orderBy: { openTime: "asc" },
    });
  }

  return rows.map((r) => ({
    openTime: r.openTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}
