import type { PrismaClient } from "../generated/prisma/client.js";
import type { FundingRateEntry } from "../exchange/bybit.js";
import type { FundingRatePoint } from "./engine.js";

// Minimal interface — BybitClient satisfies this structurally (mirrors CandleSource in candleStore.ts).
export interface FundingSource {
  getFundingHistory(symbol: string, startMs: number, endMs: number): Promise<FundingRateEntry[]>;
}

/**
 * Ensures the [fromMs, toMs] window is cached in the FundingRate table for symbol, downloading
 * only what's missing, then returns the full requested slice in engine-ready shape.
 *
 * Same edge-only gap detection as candleStore.ts's ensureCandles, and the same caveat: a
 * mid-range gap (e.g. from an exchange outage) isn't detected. Unlike candles, funding has no
 * fixed interval to step by (Bybit: "each symbol has a different funding interval"), so a gap's
 * boundary is just 1ms before/after the nearest cached entry rather than `existing ± intervalMs`.
 */
export async function ensureFundingRates(
  db: PrismaClient,
  bybit: FundingSource,
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<FundingRatePoint[]> {
  const [existingMin, existingMax] = await Promise.all([
    db.fundingRate.findFirst({ where: { symbol }, orderBy: { fundingTime: "asc" } }),
    db.fundingRate.findFirst({ where: { symbol }, orderBy: { fundingTime: "desc" } }),
  ]);

  const gaps: Array<{ start: number; end: number }> = [];
  if (!existingMin || !existingMax) {
    gaps.push({ start: fromMs, end: toMs });
  } else {
    if (fromMs < existingMin.fundingTime) {
      gaps.push({ start: fromMs, end: Math.min(existingMin.fundingTime - 1, toMs) });
    }
    if (toMs > existingMax.fundingTime) {
      gaps.push({ start: Math.max(existingMax.fundingTime + 1, fromMs), end: toMs });
    }
  }

  for (const gap of gaps) {
    if (gap.start > gap.end) continue;
    const entries = await bybit.getFundingHistory(symbol, gap.start, gap.end);
    if (entries.length === 0) continue;

    // Prisma's createMany `skipDuplicates` option isn't supported on SQLite — and without it, a
    // single conflicting row fails the *whole* batch (SQLite has no partial-insert semantics
    // here), which would silently drop otherwise-new rows too. Filter out anything already
    // cached before inserting instead, so an overlapping fetch (the source returning a
    // settlement at/near the requested boundary again) can't lose data either way.
    const existing = await db.fundingRate.findMany({
      where: { symbol, fundingTime: { in: entries.map((e) => e.fundingTime) } },
      select: { fundingTime: true },
    });
    const existingTimes = new Set(existing.map((r) => r.fundingTime));
    const toInsert = entries.filter((e) => !existingTimes.has(e.fundingTime));
    if (toInsert.length === 0) continue;

    await db.fundingRate.createMany({
      data: toInsert.map((e) => ({ symbol, fundingTime: e.fundingTime, fundingRate: e.fundingRate })),
    });
  }

  const rows = await db.fundingRate.findMany({
    where: { symbol, fundingTime: { gte: fromMs, lte: toMs } },
    orderBy: { fundingTime: "asc" },
  });

  return rows.map((r) => ({ time: r.fundingTime, rate: r.fundingRate }));
}
