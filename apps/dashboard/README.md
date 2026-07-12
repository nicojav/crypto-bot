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

    BotCard & EquityBreakdown & EquityChart & OpenPositions & SignalsTable & TradesTable & TP & DP & BC -->|"react-query"| CLIENT["api/client.ts<br/>(REST)"]
    APP -->|"live updates"| WSHOOK["hooks/useWebSocket.ts"]

    CLIENT -->|"GET/POST /api/*"| BOT["apps/bot REST API"]
    WSHOOK -->|"WebSocket"| BOT
```

## Data flow

- **REST reads/writes** — every component that displays or mutates server state goes through `api/client.ts` (typed fetch wrappers) via React Query, hitting `apps/bot`'s `/api/*` routes (trades, equity, positions, signals, bots, reconcile).
- **Live updates** — `hooks/useWebSocket.ts` holds a single WebSocket connection (mounted once, in `App.tsx`) to `apps/bot`'s `ws.ts` server, receiving the same events the backend's internal `EventBus` publishes (`trade.opened`, `trade.closed`, `signal.received`, `balance.updated`, etc.) and invalidating the relevant React Query caches so the UI updates without polling.
- **Routing** — `App.tsx` renders `Header` + `KillSwitchDialog` globally, and switches between `DashboardPage` (`/`), `TradesPage` (`/trades`), and `BotConfigPage` (`/bots/:id`) via `react-router-dom`.
- **Trades page** — `TradesPage` (`/trades`, reached via the header nav or the "View all →" link on the dashboard's `TradesTable`) filters trades by bot/date server-side (`/api/trades` params) and by symbol/side/status/source/search client-side, with column sorting, a filter-aware summary bar, expandable per-trade detail, and CSV export. `tradeBadges.tsx` holds the `pnlSource` badge + formatters shared with `TradesTable`.
