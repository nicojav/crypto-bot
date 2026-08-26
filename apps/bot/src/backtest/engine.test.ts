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

  it("subtracts the open-position fee from equity while a position is held, not just at close", () => {
    // A 3rd flat bar keeps the position open past bar 1 — with only 2 bars, bar 1 would be the
    // last one and trigger the window-end auto-flatten (and its own closing fee), confounding
    // the thing this test is actually checking.
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100), candle(2, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }];
    const config: EngineConfig = { ...baseConfig, feeBps: 10 }; // 0.1% — feeOpenUsd = 100 * 10 * 0.001 = 1.0

    const { equityCurve } = runBacktestEngine(candles, signals, config);

    // Flat price throughout — the only reason equity should move at all is the entry fee.
    expect(equityCurve[0]!.equity).toBe(9_999);
    expect(equityCurve[1]!.equity).toBe(9_999);
  });

  it("applies slippage to an SL fill that's touched without a gap", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 90, 95)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 50, slPct: 5 }];
    const config: EngineConfig = { ...baseConfig, slippageBps: 100 }; // 1%

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades[0]!.exitReason).toBe("sl");
    // Entry itself slips too: fillPrice = 100 * 1.01 = 101, so sl = 101 * 0.95 = 95.95 (not the
    // naive 100 * 0.95 = 95). Touched, not gapped (bar opened at 100) → 95.95 - 1% slippage.
    expect(trades[0]!.exitPrice).toBeCloseTo(94.9905, 6);
  });

  it("fills an SL at the bar's open when the bar gaps straight past the stop", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 80, 85, 75, 82)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 50, slPct: 5 }]; // sl = 95
    const config: EngineConfig = { ...baseConfig, slippageBps: 0 };

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades[0]!.exitReason).toBe("sl");
    // bar opened at 80, already below the 95 stop — real execution fills near the open, not 95.
    expect(trades[0]!.exitPrice).toBe(80);
  });

  it("liquidates a position once its loss breaches the maintenance-margin cushion", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 85, 90)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }]; // no sl/tp — only liquidation can close this
    const config: EngineConfig = { ...baseConfig, leverage: 10, maintenanceMarginRate: 0.005, slippageBps: 0 };

    const { trades } = runBacktestEngine(candles, signals, config);

    // liq = 100 * (1 - (1/10 - 0.005)) = 100 * 0.905 = 90.5, touched by bar1's low of 85
    expect(trades).toHaveLength(1);
    expect(trades[0]!.exitReason).toBe("liquidation");
    expect(trades[0]!.exitPrice).toBeCloseTo(90.5, 6);
  });

  it("liquidates ahead of a wider stop-loss that would otherwise also be touched on the same bar", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 80, 85)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 50, slPct: 15 }]; // sl = 85
    const config: EngineConfig = { ...baseConfig, leverage: 10, maintenanceMarginRate: 0.005, slippageBps: 0 };

    const { trades } = runBacktestEngine(candles, signals, config);

    // liq = 90.5 (see above), sl = 85 — bar1's low of 80 touches both, liquidation must win.
    expect(trades[0]!.exitReason).toBe("liquidation");
  });

  it("counts an intrabar wick against max drawdown even when every bar closes flat", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 50, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }]; // flattens at window end, back at 100

    const { equityCurve, maxDrawdownUsd, maxDrawdownPct } = runBacktestEngine(candles, signals, baseConfig);

    // Close-only tracking would see 10,000 -> 10,000 (flat) and report zero drawdown.
    expect(equityCurve.map((p) => p.equity)).toEqual([10_000, 10_000]);
    // The bar's low of 50 says otherwise: a 10-qty long entered at 100 was worth 9,500 mid-bar.
    expect(maxDrawdownUsd).toBe(500);
    expect(maxDrawdownPct).toBeCloseTo(5, 6);
  });

  it("accrues funding against an open long, reducing both live equity and the eventual trade PnL", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100), candle(2, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }]; // flattens at window end (bar 2)
    const config: EngineConfig = { ...baseConfig, fundingRates: [{ time: 1, rate: 0.0001 }] }; // settles exactly at bar 1's openTime

    const { trades, equityCurve } = runBacktestEngine(candles, signals, config);

    // notional = qty(10) * bar1.open(100) = 1,000; rate positive -> the long pays 1,000 * 0.0001 = 0.1
    expect(equityCurve[1]!.equity).toBeCloseTo(9_999.9, 6); // paid the instant it settles, not just at close
    expect(trades[0]!.fundingUsd).toBeCloseTo(0.1, 6);
    expect(trades[0]!.pnlUsd).toBeCloseTo(-0.1, 6); // flat price, zero fees — funding is the only cost
  });

  it("credits funding to an open short when the rate is positive (shorts receive)", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100), candle(2, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "short" }];
    const config: EngineConfig = { ...baseConfig, fundingRates: [{ time: 1, rate: 0.0001 }] };

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades[0]!.fundingUsd).toBeCloseTo(-0.1, 6); // negative = received
    expect(trades[0]!.pnlUsd).toBeCloseTo(0.1, 6);
  });

  it("accrues every funding settlement a wide bar spans, not just the first", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }];
    // Three settlements all land at-or-before bar 1's openTime (1) — a 1d/1w bar can span several.
    const config: EngineConfig = { ...baseConfig, fundingRates: [{ time: 1, rate: 0.0001 }, { time: 1, rate: 0.0001 }, { time: 1, rate: 0.0001 }] };

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades[0]!.fundingUsd).toBeCloseTo(0.3, 6);
  });

  it("does not accrue funding for a settlement that occurs while no position is open", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100), candle(2, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 1, time: 1, action: "long" }]; // opens on bar 1, after the settlement below
    const config: EngineConfig = { ...baseConfig, fundingRates: [{ time: 0, rate: 0.0001 }] };

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades[0]!.fundingUsd).toBe(0);
  });

  it("tracks MAE/MFE from the bar after entry, ignoring the entry bar's own range", () => {
    // bar0 (entry bar) has a huge range that must NOT count — the position wasn't open for it.
    const candles = [candle(0, 100, 500, 1, 100), candle(1, 100, 108, 95, 100), candle(2, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long" }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades[0]!.mfePct).toBeCloseTo(8, 6); // bar1 high 108 vs entry 100
    expect(trades[0]!.maePct).toBeCloseTo(-5, 6); // bar1 low 95 vs entry 100
  });

  it("counts the touch price on the exact bar a TP/SL exit happens, not just prior bars", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100), candle(2, 100, 100, 80, 90)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 50, slPct: 20 }]; // sl = 80

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades[0]!.exitReason).toBe("sl");
    // bar2's low of 80 is both the SL trigger AND the worst excursion — must be reflected in MAE
    // even though the position closes on this same bar.
    expect(trades[0]!.maePct).toBeCloseTo(-20, 6);
  });

  it("tracks MAE/MFE independently for a short position (favorable = price falling)", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 92, 105, 90, 100), candle(2, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "short" }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades[0]!.mfePct).toBeCloseTo(10, 6); // bar1 low 90 is favorable for a short (100 -> 90 = +10%)
    expect(trades[0]!.maePct).toBeCloseTo(-5, 6); // bar1 high 105 is adverse for a short (100 -> 105 = -5%)
  });
  // ── flat signal, time stop, and per-side fees ────────────────────────────────

  it("closes on a flat signal without opening anything new", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 112, 100, 110), candle(2, 110, 110, 110, 110)];
    const signals: SignalEvent[] = [
      { barIndex: 0, time: 0, action: "long" },
      { barIndex: 1, time: 1, action: "flat" },
    ];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    // Exactly one trade: the flat closed it, and crucially did not re-open in either direction —
    // a second trade here would mean "flat" was being treated as a reversal.
    expect(trades).toHaveLength(1);
    expect(trades[0]).toMatchObject({ side: "BUY", entryPrice: 100, exitPrice: 110, exitReason: "flat" });
  });

  it("treats a flat signal with no open position as a no-op", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 105, 95, 100)];
    // Strategies emit flat without knowing their own position state, so a flat landing on a bar
    // with nothing open has to be silently ignored rather than opening or throwing.
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "flat" }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades).toHaveLength(0);
  });

  it("force-closes at the time stop once maxBarsHeld bars have elapsed", () => {
    const candles = [
      candle(0, 100, 100, 100, 100),
      candle(1, 100, 101, 99, 100),
      candle(2, 100, 101, 99, 102),
      candle(3, 102, 103, 101, 103),
    ];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", maxBarsHeld: 2 }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.exitReason).toBe("timeStop");
    expect(trades[0]!.barsHeld).toBe(2);
    expect(trades[0]!.exitPrice).toBe(102); // bar 2's close — a time stop resolves at the close, not intrabar
  });

  it("lets a same-bar SL touch win over the time stop", () => {
    // Both could fire on bar 2. The SL was actually touched intrabar while the time stop only
    // resolves at the close, so the conservative (and realistic) outcome is the stop.
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 101, 99, 100), candle(2, 100, 101, 90, 100)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", tpPct: 50, slPct: 5, maxBarsHeld: 2 }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades[0]!.exitReason).toBe("sl");
    expect(trades[0]!.exitPrice).toBe(95);
  });

  it("applies a stop with no take-profit when the signal carries only an SL", () => {
    // Session VWAP reversion targets VWAP via a flat signal, so it emits a stop and no target.
    // Before per-side bracket resolution this produced NO bracket at all, silently unstopping it.
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 130, 94, 96)];
    const signals: SignalEvent[] = [{ barIndex: 0, time: 0, action: "long", slAtrMult: 1, atrAtSignal: 5 }];

    const { trades } = runBacktestEngine(candles, signals, baseConfig);

    expect(trades).toHaveLength(1);
    expect(trades[0]!.exitReason).toBe("sl");
    expect(trades[0]!.exitPrice).toBe(95);
  });

  it("charges entry and exit fees independently when per-side rates are set", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [
      { barIndex: 0, time: 0, action: "long" },
      { barIndex: 1, time: 1, action: "flat" },
    ];
    // Maker in (2bps), taker out (10bps), on a flat 100-price round trip of qty 10 (notional 1000).
    const config: EngineConfig = { ...baseConfig, feeBps: 99, entryFeeBps: 2, exitFeeBps: 10 };

    const { trades } = runBacktestEngine(candles, signals, config);

    // feeBps is fully overridden on both sides, so it must not leak into the total.
    expect(trades[0]!.feeUsd).toBeCloseTo(1000 * 0.0002 + 1000 * 0.001, 9);
  });

  it("falls back to feeBps on whichever side has no override", () => {
    const candles = [candle(0, 100, 100, 100, 100), candle(1, 100, 100, 100, 100)];
    const signals: SignalEvent[] = [
      { barIndex: 0, time: 0, action: "long" },
      { barIndex: 1, time: 1, action: "flat" },
    ];
    const config: EngineConfig = { ...baseConfig, feeBps: 10, entryFeeBps: 2 };

    const { trades } = runBacktestEngine(candles, signals, config);

    expect(trades[0]!.feeUsd).toBeCloseTo(1000 * 0.0002 + 1000 * 0.001, 9);
  });
});
