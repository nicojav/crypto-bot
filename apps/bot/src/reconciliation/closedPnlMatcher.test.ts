import { describe, it, expect } from "vitest";
import { matchClosedPnl } from "./closedPnlMatcher.js";
import type { ClosedPnLEntry } from "../exchange/bybit.js";

function entry(overrides: Partial<ClosedPnLEntry> = {}): ClosedPnLEntry {
  return {
    orderId: "ord-1",
    symbol: "SOLUSDT",
    side: "Sell",
    qty: 100,
    avgEntryPrice: 3.0,
    avgExitPrice: 3.5,
    closedPnl: 48.75,
    openFee: 0.15,
    closeFee: 0.1,
    createdTime: 1000,
    updatedTime: 2000,
    ...overrides,
  };
}

describe("matchClosedPnl", () => {
  it("returns a single-mode match when exactly one entry reconciles with the target qty", () => {
    const result = matchClosedPnl([entry({ qty: 100 })], 100);
    expect(result?.mode).toBe("single");
    expect(result?.qty).toBe(100);
    expect(result?.closedPnl).toBeCloseTo(48.75);
    expect(result?.entries).toHaveLength(1);
  });

  it("prefers the single reconciling entry over summing when an unrelated entry is also in the window", () => {
    const unrelated = entry({ orderId: "unrelated", qty: 24.3, closedPnl: -7.56 });
    const real = entry({ orderId: "real", qty: 30.9, closedPnl: -5.5019 });
    const result = matchClosedPnl([unrelated, real], 30.9);

    expect(result?.mode).toBe("single");
    expect(result?.entries).toEqual([real]);
    expect(result?.closedPnl).toBeCloseTo(-5.5019);
  });

  it("falls back to summing all entries when no single entry reconciles but the aggregate does", () => {
    const a = entry({ orderId: "a", qty: 60, closedPnl: 10 });
    const b = entry({ orderId: "b", qty: 40, closedPnl: 5 });
    const result = matchClosedPnl([a, b], 100);

    expect(result?.mode).toBe("aggregate");
    expect(result?.qty).toBeCloseTo(100);
    expect(result?.closedPnl).toBeCloseTo(15);
    expect(result?.entries).toHaveLength(2);
  });

  it("returns null when neither a single entry nor the aggregate reconciles", () => {
    const a = entry({ orderId: "a", qty: 60 });
    const b = entry({ orderId: "b", qty: 60 });
    const result = matchClosedPnl([a, b], 100);

    expect(result).toBeNull();
  });

  it("returns null for an empty entry list", () => {
    expect(matchClosedPnl([], 100)).toBeNull();
  });

  it("computes qty-weighted average entry/exit prices for an aggregate match", () => {
    const a = entry({ orderId: "a", qty: 60, avgEntryPrice: 80, avgExitPrice: 81 });
    const b = entry({ orderId: "b", qty: 40, avgEntryPrice: 82, avgExitPrice: 83 });
    const result = matchClosedPnl([a, b], 100);

    expect(result?.mode).toBe("aggregate");
    expect(result?.avgEntryPrice).toBeCloseTo((80 * 60 + 82 * 40) / 100);
    expect(result?.avgExitPrice).toBeCloseTo((81 * 60 + 83 * 40) / 100);
  });

  it("picks the most recent entry by updatedTime as lastEntry for an aggregate match", () => {
    const a = entry({ orderId: "a", qty: 60, updatedTime: 1000 });
    const b = entry({ orderId: "b", qty: 40, updatedTime: 5000 });
    const result = matchClosedPnl([a, b], 100);

    expect(result?.lastEntry.orderId).toBe("b");
  });
});
