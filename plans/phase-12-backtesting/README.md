# Phase 12 — In-app backtesting tool

**Status:** Planned

## Goal

Backtest strategies inside crypto-bot instead of on TradingView, whose subscription tier
caps the usable date range. Reproduce the TradingView Strategy Tester experience: equity vs.
Buy & Hold, a trade list, trade analysis, and a candlestick chart with entry/exit markers —
over a user-selectable window (default last 5 years) and a timeframe selector
(5m / 15m / 4h / 1d / 1w).

## Context & key decisions

Backtesting is greenfield here. The bot is webhook-driven — the real strategy logic lives in
TradingView Pine Script (`strategies/*.pine`), and the bot has **no candle data, no
indicators, and no historical price storage**. It only handles execution/accounting against
Bybit. Candle acquisition, indicator math, and a simulation engine must all be built.

Decisions:
1. **Parameterized Pine mirrors** — re-implement the existing Pine strategy families as
   TypeScript modules driven by a params form. No Pine runtime (an interpreter is out of
   scope). Promoting a winning config to live = copying the tuned numbers into the existing
   `.pine` inputs — same logic, no code translation, tight backtest↔live parity.
2. **lightweight-charts** (TradingView's OSS lib) for the candlestick + markers view. First
   non-recharts chart lib in the dashboard.
3. **SQLite candle cache + selectable window** — download Bybit klines once per
   symbol+timeframe, reuse across runs.

**Parity principle:** the most useful backtest matches *our bot's* execution, not
TradingView's. The bot already diverges from the Pine backtest (fills at mark price on the
bar-close alert; re-anchors TP/SL to mark price at fill). So the engine reuses the bot's own
`calcQty` / `roundToTick` (exported from `apps/bot/src/processor/signalProcessor.ts`) and the
`price*(1±pct/100)` TP/SL math.

## Tasks

### Backend — `apps/bot` (invoke `fastify-best-practices`)

1. **Candle cache.** New Prisma `Candle` model + migration: `symbol, timeframe, openTime(Int
   ms), open, high, low, close, volume`, `@@unique([symbol, timeframe, openTime])`. Add a
   `getKline` wrapper to `src/exchange/bybit.ts` (wraps `RestClientV5.getKline`,
   `category:"linear"`, paginated 1000/call; map `5m→"5"`, `15m→"15"`, `4h→"240"`, `1d→"D"`,
   `1w→"W"`). `src/backtest/candleStore.ts::ensureCandles(symbol, timeframe, from, to)`
   downloads only missing sub-ranges, upserts, returns the slice (idempotent — reruns hit
   the DB, not Bybit).
2. **Indicators** — `src/backtest/indicators.ts`: `ema` (SMA-seeded), `rsi` (Wilder RMA),
   `atr` (Wilder), `crossover`/`crossunder`, matched to Pine semantics exactly (parity).
3. **Strategy registry** — `src/backtest/strategies/`, one module per Pine family mirroring
   `strategies/*.pine` 1:1: `emaCross`, `emaCrossTpSl` (ATR TP/SL; defaults
   `fast20/slow50/atr14/sl1.5/tp3`), `emaRsiPctTpSl` (EMA+RSI + %TP/SL; defaults
   `fast9/slow21/rsi14/rsiMaxLong60/rsiMinShort40/tp1.5/sl0.75`). Each exports param metadata
   `{name, default, min, max, step}[]` and `run(candles, params) → SignalEvent[]`. Registry
   keyed by id; schemas exposed over the API so the form is data-driven.
4. **Engine** — `src/backtest/engine.ts`: pure, deterministic, single open position at a time
   (matches the bot — no pyramiding). Reuses `calcQty` / `roundToTick`; reversal on opposite
   signal; intrabar TP/SL touch via `high`/`low` (SL-first when ambiguous). Config:
   `initialCapital` (default 10 000), `maxPositionUsd`/`positionPct`, `leverage`, `feeBps`
   (~5.5 = Bybit taker), `slippageBps`, `fillModel`. **Fill model** is the parity knob:
   `"signalClose"` (default — fill at signal bar close, closest to the live bot) vs
   `"nextOpen"` (TradingView-tester parity). Outputs `BacktestTrade[]`, per-bar `equityCurve`,
   `buyHoldCurve`.
5. **Stats** — `src/backtest/stats.ts`: Total PnL (abs+%), max drawdown (abs+%), profitable-
   trades %, profit factor, avg PnL, avg bars, largest profit/loss, avg win/loss, returns
   histogram, winners/losers/breakevens.
6. **API** — `src/backtest/backtestRoutes.ts` (Fastify plugin, Bearer-auth like `api.ts`),
   registered in `src/app.ts`:
   - `GET /api/backtest/strategies` → registry metadata + param schemas.
   - `POST /api/backtest/run` → `{strategyId, params, symbol, timeframe, from, to,
     initialCapital, leverage, feeBps, slippageBps, fillModel}` → `ensureCandles` → strategy →
     engine → stats. Returns `{stats, trades, equityCurve(downsampled), buyHoldCurve,
     markers}` — **no raw candles** (5min/5y ≈ 525k rows is too large inline).
   - `GET /api/backtest/candles` → windowed, point-capped OHLC for the chart; lazy-loaded on
     pan/zoom.

### Frontend — `apps/dashboard` (invoke `frontend-design`, `vercel-react-best-practices`, `dataviz`)

7. Route `/backtest` in `App.tsx` → `pages/BacktestPage.tsx` + `Header.tsx` nav link; reuse
   `bg-card / border-border / data-label` Tailwind tokens.
8. `BacktestConfig` — data-driven form from `/api/backtest/strategies` (strategy `ui/Select`,
   dynamic `ui/Field` params, symbol, timeframe, from/to pickers default last 5y, capital,
   leverage, fees, fill model); "Run" → react-query mutation.
9. `BacktestKeyStats` (stat tiles — image #1 top). `BacktestEquityChart` — clone
   `components/EquityChart.tsx` (recharts), strategy PnL vs Buy & Hold (image #1).
10. `BacktestTradesTable` — reuse `components/tradeBadges.tsx` (`fmtUsd/fmtQty/fmtTime`) +
    `TradesPage` patterns (sortable, expandable, CSV) (image #2). `BacktestAnalysis` — avg
    stats + returns histogram (BarChart) + winners/losers donut (PieChart) (image #3).
11. `BacktestChart` — **lightweight-charts** candlestick + EMA overlays + ▲long/▼short/✕exit
    markers, lazy-loading `/api/backtest/candles` (image #5). Add `client.ts` wrappers +
    response types (following the existing hand-duplicated type convention — no shared pkg).

### Docs — update all three Mermaid diagrams (repo CLAUDE.md convention)

12. root `README.md` (Bybit kline-read edge + candle-store node), `apps/bot/README.md`
    (`backtest/` engine, `candleStore`, `Candle` table, `backtestRoutes`), `apps/dashboard/
    README.md` (`BacktestPage` subtree).

## Checkpoint

1. `npm run dev`, open `/backtest`. Run EMA Cross TP/SL on `XRPUSDT`, `1d`, last 5y → Key
   Stats, equity-vs-B&H curve, trade list, analysis, and candlestick-with-markers all render
   and are internally consistent (equity end = Total PnL; winners+losers = total trades).
2. Rerun same config → instant (candles from cache, no refetch).
3. `5m` over a shorter window → candle endpoint stays responsive (windowed/capped).
4. `npm test -w apps/bot` — new suites green (`indicators`, `engine`, `stats`, `candleStore`).
5. Run `security-review` on the diff.

## Notes

- Single-position model mirrors the bot; no pyramiding/scaling.
- Intrabar TP+SL ambiguity resolved SL-first (conservative).
- Fees/slippage are *modeled* (Bybit-authoritative fees/funding only exist for live trades),
  so results approximate but internally consistent and configurable.
- Reused pure functions: `calcQty`, `roundToTick` (`apps/bot/src/processor/signalProcessor.ts`);
  PnL formula `(exit−entry)*qty*(side==="BUY"?1:−1)` (replicated from private `pnlForTrade`).
- No shared types package exists (bot↔dashboard types are hand-duplicated); a `packages/shared`
  is a tempting cleanup but out of scope for this phase.
