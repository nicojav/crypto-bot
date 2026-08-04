import { describe, it, expect } from "vitest";
import { runBacktestEngine, type EngineConfig } from "./engine.js";
import type { Candle } from "./types.js";
import type { SignalEvent } from "./strategies/types.js";

const baseConfig: EngineConfig = {
  initialCapital: 10_000,
  maxPositionUsd: 1_000,
  leverage: 1,
  feeBps: 0,
  slippageBps: 0,
  fillModel: "signalClose",
  lotSize: 0.001,
  tickSize: 0.01,
};

function candle(openTime: number, open: number, high: number, low: number, close: number): Candle {
  return { openTime, open, high, low, close, volume: 1 };
}

describe("runBacktestEngine", () => {
  it("opens on the signal bar's close and exits on TP touch", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 115, 99, 105)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 10, slPct: 5 }];

    const { trades, equityCurve } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: "BUY", entryPrice: 100, exitPrice: 110, qty: 10, pnlUsd: 100, pnlPct: 10, exitReason: "tp" });
    expect(equityCurve[0]!.equity).toBe(10_000);
    expect(equityCurve[1]!.equity).toBe(10_100);
  });

  it("resolves SL first when a single bar could touch both TP and SL", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 120, 90, 105)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 10, slPct: 5 }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.exitReason).toBe("sl");
    expect(trades[0]!.exitPrice).toBe(95);
  });

  it("closes on reversal and force-closes at the window end (no bracket when the signal has none)", () => {
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 105, 100, 105),
      candle(2, 100, 90, 90, 90),
      candle(3, 90, 95, 90, 95),
    ];
    const signals: SignalEvent[] = [
      { barIndex: 0, time: 0, action: "long" },
      { barIndex: 2, time: 2, action: "short" },
    ];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades).toHaveLength(2);
    expect(trades[0]).toMatchObject({ side: "BUY", entryPrice: 100, exitPrice: 90, pnlUsd: -100, exitReason: "reversal", barsHeld: 2 });
    expect(trades[1]).toMatchObject({ side: "SELL", entryPrice: 90, exitPrice: 95, exitReason: "windowEnd", barsHeld: 1 });
    expect(trades[1]!.pnlUsd).toBeCloseTo(-55.6, 1);
  });

  it("deducts taker fees from realized PnL on both entry and exit", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 200, 200, 200)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 50, slPct: 50 }];
    const config: EngineConfig = { ...baseConfig, feeBps: 10 }; // 0.1%

    const { trades } = runBacktestEngine(candles, signals, config);

    // entry 100 x qty 10 -> fee 1.0; exit at TP=150 x qty 10 -> fee 1.5; gross 500 - 2.5 fees
    expect(trades[0]!.feeUsd).toBeCloseTo(2.5, 6);
    expect(trades[0]!.pnlUsd).toBeCloseTo(497.5, 6);
  });

  it("fills at the next bar's open under the nextOpen fill model", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 108, 120, 107, 115), candle(2, 115, 115, 115, 115)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }];
    const config: EngineConfig = { ...baseConfig, fillModel: "nextOpen" };

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.entryPrice).toBe(108); // bar 1's open, not bar 0's close
    expect(trades[0]!.entryTime).toBe(1);
  });

  it("skips a signal that can't afford the minimum lot size", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }];
    const config: EngineConfig = { ...baseConfig, maxPositionUsd: 0.001 }; // far too small to afford one lot

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades).toHaveLength(0);
  });
});
