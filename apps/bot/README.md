# apps/bot

Fastify backend: receives TradingView webhook alerts, executes orders on Bybit, tracks positions/trades in SQLite, and reconciles state against the exchange.

See the [root README](../../README.md) for the system-wide diagram and setup instructions. This doc covers the bot's internal structure.

## Architecture

```mermaid
graph TB
    TV["TradingView"] -->|"POST /webhook/:botId"| WH["routes/webhook.ts"]
    WH -->|creates PENDING| SIGNAL[("Signal")]

    SIGNAL --> SP["processor/signalProcessor.ts<br/>(polls every 500ms)"]
    SP -->|placeMarketOrder / getOrderFill| BYBIT_REST["Bybit REST API<br/>(account-scoped, testnet-aware)"]
    SP -->|creates/updates| TRADE[("Trade")]
    SP -. "publishes signal/trade events" .-> BUS

    REC["reconciliation/reconciler.ts"] -->|"WS: position/order/execution/wallet"| BYBIT_WS["Bybit WebSocket"]
    REC -->|"getClosedPnL / getExecutionList / getPositions"| BYBIT_REST
    REC -->|closes/hydrates| TRADE
    REC --> PNLB["reconciliation/pnlBackfill.ts<br/>(periodic retry, 5min)"]
    PNLB --> MATCHER["reconciliation/closedPnlMatcher.ts<br/>(pure matching logic)"]
    REC --> MATCHER
    REC -->|balance snapshots, 60s| SNAP[("BalanceSnapshot")]
    REC -. "publishes trade/balance events" .-> BUS
    REC --> RLOG["reconciliation/reconciliationLog.ts"]
    PNLB --> RLOG
    RLOG -->|"audit trail (dropped fills, qty drift,<br/>phantom promotions)"| REVENT[("ReconciliationEvent")]

    API["routes/api.ts"] -->|reads| TRADE
    API -->|reads| SNAP
    API -->|reads/writes| BOT[("Bot")]

    BUS["eventBus.ts<br/>(EventEmitter)"] --> WSS["ws.ts<br/>(WS server)"]

    DASH["apps/dashboard"] -->|REST| API
    DASH -->|WebSocket| WSS

    CLI["scripts/backfillRealizedPnlGrouped.ts<br/>(manual CLI)"] --> PNLB
    DIAG["scripts/dumpClosedPnl.ts<br/>(read-only diagnostic)"] --> BYBIT_REST
    DIAG2["scripts/dumpReconciliationEvents.ts<br/>(read-only diagnostic)"] --> REVENT

    BTAPI["backtest/backtestRoutes.ts<br/>(GET strategies, POST run, POST optimize,<br/>POST/GET optimize/auto(+cancel/delete),<br/>GET candles, POST :id/pine)"] -->|ensureCandles| CSTORE["backtest/candleStore.ts"]
    CSTORE -->|"getKline (missing ranges only)"| BYBIT_MAINNET["Bybit REST API<br/>(mainnet, public — always real prices,<br/>independent of BYBIT_TESTNET)"]
    CSTORE -->|upsert/read| CANDLE[("Candle")]
    BTAPI -->|"strategy.run(candles, params)"| STRAT["backtest/strategies/*.ts<br/>(Pine-mirrored presets, composable<br/>customMaCross, bbMeanReversion scalper)"]
    STRAT -->|toPine| PINEGEN["backtest/strategies/pineExport.ts"]
    BTAPI -->|runOneBacktest, sweep combos| OPT["backtest/optimizer.ts<br/>(param-sweep + shared run helper)"]
    OPT -->|runBacktestEngine| ENGINE["backtest/engine.ts<br/>(reuses calcQty/roundToTick)"]
    ENGINE --> STATS["backtest/stats.ts"]

    BTAPI -->|"detached, single-job lock"| RUNNER["backtest/optimizationRunner.ts<br/>(Strategy Finder background job:<br/>iterates strategy x symbol x timeframe,<br/>yields to the event loop between backtests)"]
    RUNNER -->|ensureCandles| CSTORE
    RUNNER -->|searchCell| SEARCH["backtest/search.ts<br/>(coarse grid → refine,<br/>in-sample/out-of-sample split + overfit flag)"]
    SEARCH -->|runOneBacktest| OPT
    SEARCH -->|scoreResult| SCORING["backtest/scoring.ts<br/>(Sharpe/Calmar + risk-adjusted<br/>composite score, not raw PnL)"]
    RUNNER -->|"progress + bounded top-N results"| OPTRUN[("OptimizationRun")]
    DASH -->|REST| BTAPI
```

## Signal → Trade lifecycle

1. **Webhook** (`routes/webhook.ts`) validates a TradingView alert against the bot's `webhookId`/symbol and stores it as a `Signal` row with `status: PENDING`.
2. **SignalProcessor** (`processor/signalProcessor.ts`) polls for the oldest `PENDING` signal every 500ms. For an entry, it places a market order via `exchange/bybit.ts`, creates a `Trade` row immediately (before any enrichment call, so a placed order is never orphaned), then best-effort corrects `qty`/`entryPrice` from `getOrderFill` (which waits for a terminal order status before returning — see `bybit.ts`). For an opposite-side signal, it first places a reduce-only close order and marks the existing trade(s) `CLOSING`.
3. **Reconciler** (`reconciliation/reconciler.ts`) subscribes to Bybit's private WebSocket (`position`/`order`/`execution`/`wallet` topics):
   - An `order` fill event either hydrates an opening trade's real fill price/qty, or (if `reduceOnly`) closes the matching trade(s) with Bybit's authoritative `closedPnl`. If the fill can't find a matching `OPEN`/`CLOSING` trade (e.g. it was already closed), the fill is dropped and logged as a `FILL_DROPPED` reconciliation event.
   - A `position` size-0 event sweeps any remaining `OPEN`/`CLOSING` trades for that symbol via `closeRemainingOpenTrades` — tries `getClosedPnL` first (via the shared `closedPnlMatcher`), then `getExecutionList` as a local-formula fallback (`pnlSource: EXEC_FALLBACK`). It never decides `PHANTOM` itself (Bybit's data can lag a just-closed position by minutes, so an immediate decision risks zeroing out a real trade) — see the periodic sweep below.
   - A periodic sweep (every 60s, `runReconciliation`) checks live Bybit positions against `OPEN`/`CLOSING` trades for mismatches.
   - A separate periodic sweep (every 5min, `runPnlBackfill` → `pnlBackfill.ts`) retries `EXEC_FALLBACK`/null-source trades closed in the last 48h — closing the gap left by the one-shot live attempt above. A single-row trade held under 5s with still no Bybit evidence after a 15-minute grace period is promoted to `PHANTOM` here, once we're confident it's not just indexing lag.
   - Notable anomalies (dropped fills, qty drift, phantom promotions, unmatched lookups) are persisted to `ReconciliationEvent` via `reconciliation/reconciliationLog.ts`, since console logs don't survive Railway's log retention window — query them with `npm run dump:reconciliation-events`.
4. **Dashboard** reads trade/equity/position state via `routes/api.ts` (REST) and receives live updates over `ws.ts`'s WebSocket server, fed by the internal `eventBus.ts`.

## Strategy Finder (auto strategy/param search)

Brute-forcing every parameter combination for a strategy is infeasible (one strategy can have
enough numeric params at fine steps to produce billions of combos), and ranking by raw
in-sample profit reliably surfaces curve-fit configs that don't hold up live. `POST
/api/backtest/optimize/auto` starts a detached background job (`backtest/optimizationRunner.ts`)
instead of running inline in the request:

1. It iterates the requested `strategyIds x symbols x timeframes` matrix; each cell fetches
   candles via `ensureCandles` (cached after the first run) and calls `search.ts`'s
   `searchCell`.
2. `searchCell` builds a bounded **coarse grid** honoring each param's schema (enum params
   expand to their few discrete values; a `showIf`-gated param only varies in branches where
   its gate holds), scores every combo with `scoring.ts`'s risk-adjusted `scoreResult`
   (Sharpe/Calmar/profit-factor, not raw PnL%), then **refines** a finer grid around the best
   regions.
3. Candles are split into in-sample/out-of-sample chunks up front — the search only ever
   optimizes on the in-sample slice, then re-runs each finalist on the untouched
   out-of-sample slice and flags it `overfitFlag: true` if the OOS score collapses relative
   to IS. This is what makes a result defensible enough to trade, not just a good backtest.
4. Progress and a bounded top-N ranked result set are persisted to `OptimizationRun` as the
   run progresses, so `GET /api/backtest/optimize/auto/:runId` can be polled mid-run. A
   module-level single-job lock (this process also runs live trading) rejects a second run
   while one is active; `searchCell` yields to the event loop every few backtests so
   `SignalProcessor`/`Reconciler` keep ticking.
5. If the process dies mid-run (crash, deploy, a dev-mode file-watcher restart), the row is
   orphaned at `status: "running"` forever — no live process's in-memory lock ever points at
   it again, so nothing marks it done. `healOrphanedRuns` sweeps every stuck `"running"` row
   to `"error"` once at startup (`index.ts`'s `onReady` hook); `POST .../cancel` also
   self-heals a specific orphaned row on demand (skips the in-memory lock check when no live
   process owns that id), so cancel always gives the user a way out rather than requiring
   another restart. `DELETE /api/backtest/optimize/auto/:runId` removes a finished run from
   history (409s if it's still the active run — cancel it first).

## Manual scripts

| Script | Purpose |
|---|---|
| `npm run backfill:pnl-grouped -- --dry-run` | Re-run the PnL matcher against historical `EXEC_FALLBACK`/null trades; `--allow-qty-fix` also corrects a mismatched `qty` (see script header for details) |
| `npm run dump:closed-pnl -- --symbol X --from ISO --to ISO` | Read-only: print raw Bybit `getClosedPnL` entries next to matching DB trades, for manual reconciliation |
| `npm run dump:reconciliation-events -- --type X --symbol Y` | Read-only: print persisted anomaly events (dropped fills, qty drift, phantom promotions) — the audit trail that survives after logs are gone |
| `npm run repair:history` | Clean up bad balance snapshots and inflated PnL rows |
| `npm run mark-phantoms` | Mark trades with no corresponding Bybit record as `PHANTOM` |
| `npm run check-bybit` | Verify Bybit API connectivity, balance, and positions |
| `npm run reset-trade-data` | Wipe trades/signals on the deployed bot (see root README) |
