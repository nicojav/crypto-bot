# Phase 7 — React dashboard

**Status:** Pending

## Goal

A focused single-page UI to monitor and control your bots.

## Tasks

1. In `apps/dashboard`: use `@tanstack/react-query` for server state and a tiny WebSocket hook for live updates.
2. Build pages/views (single-user, one page with sections — no routing complexity needed):
   - **Header**: total equity (live), today's PnL, big red "KILL ALL BOTS" button.
   - **Bots list**: each bot as a card showing name, symbol, on/off toggle, dry-run toggle, current position (side, size, unrealized PnL), edit button for risk limits.
   - **Equity curve**: line chart of `BalanceSnapshot` over selectable timeframe (24h, 7d, 30d, all). Use `recharts`.
   - **Recent signals**: table of last 50 signals with status pills (executed/rejected/duplicate).
   - **Recent trades**: table with entry/exit/PnL, color-coded.
3. Toggling a bot calls `PATCH /api/bots/:id` and optimistically updates UI. Show a toast on error and revert.
4. Kill switch requires a confirm dialog ("Type DISABLE to confirm").
5. WebSocket events invalidate the relevant react-query cache keys so the UI auto-refreshes.

## Checkpoint

With the bot running on testnet, open the dashboard. Toggle a bot off — webhooks for it now get rejected. Trigger a trade via TradingView's webhook tester — see the trade appear live without refreshing.

## Notes
