import { describe, it, expect } from "vitest";
import {
  SESSION_ANCHORS,
  anchorMinutes,
  isWithinUtcHours,
  minutesSinceSessionOpen,
  sessionIds,
  utcMinuteOfDay,
} from "./sessions.js";
import type { Candle } from "./types.js";

const HOUR = 3_600_000;
const at = (iso: string): Candle => ({ openTime: Date.parse(iso), open: 1, high: 1, low: 1, close: 1, volume: 1 });

describe("anchorMinutes", () => {
  it("maps the anchor enum indices to their UTC offsets", () => {
    expect(anchorMinutes(0)).toBe(0); // daily 00:00
    expect(anchorMinutes(1)).toBe(8 * 60); // EU open
    expect(anchorMinutes(2)).toBe(13 * 60 + 30); // US open
  });

  it("clamps out-of-range indices rather than returning undefined", () => {
    // Params arrive as arbitrary numbers from the optimizer's sampler, so a stale or
    // out-of-range index must degrade to a valid anchor instead of producing NaN offsets.
    expect(anchorMinutes(-5)).toBe(SESSION_ANCHORS[0]!.minutesUtc);
    expect(anchorMinutes(99)).toBe(SESSION_ANCHORS[SESSION_ANCHORS.length - 1]!.minutesUtc);
  });
});

describe("utcMinuteOfDay", () => {
  it("reads the UTC wall clock, not the host timezone", () => {
    expect(utcMinuteOfDay(Date.parse("2026-03-02T13:30:00Z"))).toBe(13 * 60 + 30);
    expect(utcMinuteOfDay(Date.parse("2026-03-02T00:00:00Z"))).toBe(0);
  });
});

describe("sessionIds", () => {
  it("gives every bar of one UTC day the same id under the daily anchor", () => {
    const candles = [at("2026-03-02T00:00:00Z"), at("2026-03-02T12:00:00Z"), at("2026-03-02T23:55:00Z")];
    const ids = sessionIds(candles, 0);
    expect(new Set(ids).size).toBe(1);
  });

  it("starts a new session exactly at the anchor, not at UTC midnight", () => {
    // Under the US-open anchor (13:30), the 13:25 bar still belongs to the previous session.
    const candles = [at("2026-03-02T13:25:00Z"), at("2026-03-02T13:30:00Z"), at("2026-03-02T18:00:00Z")];
    const ids = sessionIds(candles, 2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[1]).toBe(ids[2]);
  });

  it("stays correct across a gap in the candle history", () => {
    // Derived from wall-clock time rather than bar counts, so a missing day doesn't shift every
    // subsequent session boundary.
    const candles = [at("2026-03-02T01:00:00Z"), at("2026-03-05T01:00:00Z")];
    const ids = sessionIds(candles, 0);
    expect(ids[1]! - ids[0]!).toBe(3);
  });

  it("increments by exactly one per 24h", () => {
    const base = Date.parse("2026-03-02T09:00:00Z");
    const candles: Candle[] = [0, 24, 48].map((h) => ({ openTime: base + h * HOUR, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
    const ids = sessionIds(candles, 1);
    expect(ids).toEqual([ids[0]!, ids[0]! + 1, ids[0]! + 2]);
  });
});

describe("minutesSinceSessionOpen", () => {
  it("counts forward from the anchor", () => {
    expect(minutesSinceSessionOpen(Date.parse("2026-03-02T14:00:00Z"), 2)).toBe(30);
  });

  it("wraps rather than going negative before the anchor", () => {
    // 08:00 under the 13:30 anchor is late in the *previous* session, i.e. 18h30m in.
    expect(minutesSinceSessionOpen(Date.parse("2026-03-02T08:00:00Z"), 2)).toBe(18 * 60 + 30);
  });
});

describe("isWithinUtcHours", () => {
  const t = (iso: string) => Date.parse(iso);

  it("accepts hours inside a normal window and rejects the ends", () => {
    expect(isWithinUtcHours(t("2026-03-02T13:00:00Z"), 13, 21)).toBe(true);
    expect(isWithinUtcHours(t("2026-03-02T20:59:00Z"), 13, 21)).toBe(true);
    expect(isWithinUtcHours(t("2026-03-02T21:00:00Z"), 13, 21)).toBe(false); // end is exclusive
    expect(isWithinUtcHours(t("2026-03-02T12:59:00Z"), 13, 21)).toBe(false);
  });

  it("handles a window that wraps midnight", () => {
    // The Asian session straddles 00:00 UTC, so wrapping is the normal case here.
    expect(isWithinUtcHours(t("2026-03-02T23:00:00Z"), 22, 4)).toBe(true);
    expect(isWithinUtcHours(t("2026-03-02T02:00:00Z"), 22, 4)).toBe(true);
    expect(isWithinUtcHours(t("2026-03-02T12:00:00Z"), 22, 4)).toBe(false);
  });

  it("treats an empty window as always-on rather than never", () => {
    // A degenerate window should not silently disable a strategy for the whole backtest.
    expect(isWithinUtcHours(t("2026-03-02T05:00:00Z"), 9, 9)).toBe(true);
  });
});
