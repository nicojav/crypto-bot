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
 * Ensures the [fromMs, toMs] window is cached in the Candle table for symbol+timeframe,
 * downloading only what's missing, then returns the full requested slice.
 *
 * Coverage is tracked by the min/max cached openTime — we only detect gaps at the edges
 * of the requested window (extending an already-cached range backward/forward), not gaps
 * in the middle of an existing range (e.g. from an exchange outage). That's the common case
 * for this tool (grow the cached window over time) and keeps the cache logic simple; a
 * mid-range gap would need a manual re-fetch of that sub-range.
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

  const gaps: Array<{ start: number; end: number }> = [];
  if (!existingMin || !existingMax) {
    gaps.push({ start: fromMs, end: toMs });
  } else {
    if (fromMs < existingMin.openTime) {
      gaps.push({ start: fromMs, end: Math.min(existingMin.openTime - intervalMs, toMs) });
    }
    if (toMs > existingMax.openTime) {
      gaps.push({ start: Math.max(existingMax.openTime + intervalMs, fromMs), end: toMs });
    }
  }

  for (const gap of gaps) {
    if (gap.start > gap.end) continue;
    const klines = await bybit.getKline(symbol, timeframe, gap.start, gap.end);
    if (klines.length === 0) continue;
    await db.candle.createMany({
      data: klines.map((k) => ({ symbol, timeframe, ...k })),
    });
  }

  const rows = await db.candle.findMany({
    where: { symbol, timeframe, openTime: { gte: fromMs, lte: toMs } },
    orderBy: { openTime: "asc" },
  });

  return rows.map((r) => ({
    openTime: r.openTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}
