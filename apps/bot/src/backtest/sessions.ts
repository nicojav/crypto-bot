import type { Candle } from "./types.js";

const MS_PER_MINUTE = 60_000;
const MINUTES_PER_DAY = 24 * 60;

/**
 * UTC session anchors — the three points in the crypto day where volume and volatility reliably
 * cluster, and therefore the only ones worth anchoring an intraday strategy to.
 *
 * Crypto has no exchange open, but it inherits the schedule of the people trading it: 00:00 is
 * the daily settlement/funding boundary most desks and dashboards reset on, 08:00 is the European
 * cash open, and 13:30 is the US equity open (and the slot most US macro prints land in). A 5m
 * strategy that ignores this is fitting a stationary model to a very non-stationary process.
 *
 * Order is load-bearing: strategies expose the anchor as an enum param whose numeric value is an
 * index into this array (see StrategyParamDef.options), so appending is safe but reordering
 * silently reinterprets every stored config.
 */
export const SESSION_ANCHORS: { label: string; minutesUtc: number }[] = [
  { label: "Daily 00:00 UTC", minutesUtc: 0 },
  { label: "EU open 08:00 UTC", minutesUtc: 8 * 60 },
  { label: "US open 13:30 UTC", minutesUtc: 13 * 60 + 30 },
];

export const SESSION_ANCHOR_LABELS = SESSION_ANCHORS.map((a) => a.label);

/** Resolves an enum param index to its anchor offset in minutes past UTC midnight, clamped to a valid entry. */
export function anchorMinutes(anchorIndex: number): number {
  const idx = Math.max(0, Math.min(SESSION_ANCHORS.length - 1, Math.round(anchorIndex)));
  return SESSION_ANCHORS[idx]!.minutesUtc;
}

/** Minutes past UTC midnight for a bar's open time. */
export function utcMinuteOfDay(openTime: number): number {
  const d = new Date(openTime);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

/**
 * Assigns each candle the index of the session it belongs to, where a session runs from one
 * anchor to the next occurrence of that anchor 24h later. Returned as a plain ascending integer
 * per bar, so "is this the first bar of a new session" is just `ids[i] !== ids[i - 1]` — no
 * per-strategy calendar arithmetic, and no dependence on the candle timeframe.
 *
 * Derived from wall-clock time rather than bar counts, so it stays correct across gaps in the
 * candle history (a missing hour doesn't shift every subsequent session).
 */
export function sessionIds(candles: readonly Candle[], anchorIndex: number): number[] {
  const offsetMinutes = anchorMinutes(anchorIndex);
  const offsetMs = offsetMinutes * MS_PER_MINUTE;
  const dayMs = MINUTES_PER_DAY * MS_PER_MINUTE;
  return candles.map((c) => Math.floor((c.openTime - offsetMs) / dayMs));
}

/** Whole minutes elapsed since the current session's anchor. Always in [0, 1440). */
export function minutesSinceSessionOpen(openTime: number, anchorIndex: number): number {
  const diff = utcMinuteOfDay(openTime) - anchorMinutes(anchorIndex);
  return ((diff % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/**
 * Whether a bar falls inside an intraday UTC hour window. Handles windows that wrap midnight
 * (start 22, end 4) by testing the union of the two spans rather than a single range — the Asian
 * session straddles midnight UTC, so the wrapping case is the normal case, not an edge case.
 *
 * Both bounds are hours in [0, 24); `startHour === endHour` means "always", not "never" — an
 * empty window would silently disable a strategy rather than fail visibly.
 */
export function isWithinUtcHours(openTime: number, startHour: number, endHour: number): boolean {
  const start = Math.max(0, Math.min(23, Math.round(startHour)));
  const end = Math.max(0, Math.min(23, Math.round(endHour)));
  if (start === end) return true;
  const hour = new Date(openTime).getUTCHours();
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}
