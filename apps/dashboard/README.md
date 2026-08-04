# apps/dashboard

React + Vite frontend: live P&L, trade history, signal/position monitoring, and bot configuration for the `apps/bot` backend.

See the [root README](../../README.md) for the system-wide diagram and setup instructions. This doc covers the dashboard's internal structure.

## Architecture

```mermaid
graph TB
    APP["App.tsx<br/>(routes + header + kill-switch)"]
    APP --> DP["pages/DashboardPage.tsx"]
    APP --> TP["pages/TradesPage.tsx<br/>(filter/sort/export)"]
    APP --> BC["pages/BotConfigPage.tsx"]
    APP --> BTP["pages/BacktestPage.tsx<br/>(config + tabs)"]

    DP --> BotCard["components/BotCard.tsx"]
    DP --> EquityBreakdown["components/EquityBreakdown.tsx"]
    DP --> EquityChart["components/EquityChart.tsx"]
    DP --> OpenPositions["components/OpenPositions.tsx"]
    DP --> SignalsTable["components/SignalsTable.tsx"]
    DP --> TradesTable["components/TradesTable.tsx"]
    TradesTable -->|"View all →"| TP
    TP --> Badges["components/tradeBadges.tsx<br/>(shared badges/formatters)"]
    TradesTable --> Badges
    TP --> UISelect["components/ui/Select.tsx"]
    DP --> CreateBotDialog["components/CreateBotDialog.tsx"]
    BC --> EditBotDialog["components/EditBotDialog.tsx"]
    APP --> KillSwitchDialog["components/KillSwitchDialog.tsx"]

    BTP --> BTConfig["components/backtest/BacktestConfig.tsx"]
    BTConfig --> BTOptimize["components/backtest/BacktestOptimizePanel.tsx<br/>(manual param sweep, 1-3 params)"]
    BTP --> BTFinder["components/backtest/StrategyFinderPanel.tsx<br/>(auto search: strategy x symbol x timeframe,<br/>polls a background run, IS/OOS + overfit flag)"]
    BTFinder -.->|"Load into backtest"| BTConfig
    BTP --> BTStats["components/backtest/BacktestKeyStats.tsx"]
    BTP --> BTEquity["components/backtest/BacktestEquityChart.tsx"]
    BTP --> BTTrades["components/backtest/BacktestTradesTable.tsx"]
    BTP --> BTAnalysis["components/backtest/BacktestAnalysis.tsx"]
    BTP --> BTChart["components/backtest/BacktestChart.tsx<br/>(lightweight-charts candles + markers)"]
    BTTrades --> Badges

    BotCard & EquityBreakdown & EquityChart & OpenPositions & SignalsTable & TradesTable & TP & DP & BC & BTConfig & BTOptimize & BTFinder & BTP & BTChart -->|"react-query"| CLIENT["api/client.ts<br/>(REST)"]
    APP -->|"live updates"| WSHOOK["hooks/useWebSocket.ts"]

    CLIENT -->|"GET/POST /api/*"| BOT["apps/bot REST API"]
    WSHOOK -->|"WebSocket"| BOT
```

## Data flow

- **REST reads/writes** — every component that displays or mutates server state goes through `api/client.ts` (typed fetch wrappers) via React Query, hitting `apps/bot`'s `/api/*` routes (trades, equity, positions, signals, bots, reconcile).
- **Live updates** — `hooks/useWebSocket.ts` holds a single WebSocket connection (mounted once, in `App.tsx`) to `apps/bot`'s `ws.ts` server, receiving the same events the backend's internal `EventBus` publishes (`trade.opened`, `trade.closed`, `signal.received`, `balance.updated`, etc.) and invalidating the relevant React Query caches so the UI updates without polling.
- **Routing** — `App.tsx` renders `Header` + `KillSwitchDialog` globally, and switches between `DashboardPage` (`/`), `TradesPage` (`/trades`), and `BotConfigPage` (`/bots/:id`) via `react-router-dom`.
- **Trades page** — `TradesPage` (`/trades`, reached via the header nav or the "View all →" link on the dashboard's `TradesTable`) filters trades by bot/date server-side (`/api/trades` params) and by symbol/side/status/source/search client-side, with column sorting, a filter-aware summary bar, expandable per-trade detail, and CSV export. `tradeBadges.tsx` holds the `pnlSource` badge + formatters shared with `TradesTable`.
- **Backtest page** — `BacktestPage` (`/backtest`) has two modes behind a segmented toggle. **Single backtest** is a data-driven config form (`BacktestConfig`, populated from `/api/backtest/strategies`) that runs a strategy via `POST /api/backtest/run` and renders the result across four tabs: key stats + equity-vs-Buy&Hold curve (`BacktestEquityChart`, cloning `EquityChart`'s recharts pattern), a sortable/exportable trade list (`BacktestTradesTable`, reusing `tradeBadges.tsx`), returns/win-rate analysis (`BacktestAnalysis`), and a candlestick chart with entry/exit markers (`BacktestChart`, the dashboard's only non-recharts chart — uses `lightweight-charts`, lazy-fetching windowed OHLC from `/api/backtest/candles`); it also has an inline manual param sweep (`BacktestOptimizePanel`, 1-3 params, ranked by raw PnL%) via `POST /api/backtest/optimize`. **Strategy Finder** (`StrategyFinderPanel`) is the automated counterpart: pick symbols/timeframes/strategies, start a background search via `POST /api/backtest/optimize/auto`, and poll `GET /api/backtest/optimize/auto/:runId` (React Query `refetchInterval`, active only while the run's `status` is `"running"`) for progress and a results table ranked by out-of-sample score, with in-sample-vs-OOS columns and an overfit flag per row. Its "Load" action hands the chosen strategy/params/symbol/timeframe to `BacktestConfig` (a `prefill` prop keyed by an incrementing token, applied by adjusting state during render rather than via an effect) and switches back to the Single backtest tab.
