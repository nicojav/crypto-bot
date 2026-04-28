# Phase 6 — Dashboard backend (REST API)

**Status:** Pending

## Goal

Expose what the React app needs to render.

## Tasks

1. Add these Fastify routes (all behind a simple bearer-token auth from env — you're the only user):
   - `GET /api/bots` — list all bots with current open position summary.
   - `GET /api/bots/:id` — bot detail + recent signals + recent trades.
   - `PATCH /api/bots/:id` — update `enabled`, `dryRun`, `maxPositionUsd`, `maxLeverage`.
   - `GET /api/trades?botId=&limit=&from=&to=` — paginated trade history.
   - `GET /api/equity?from=&to=` — balance snapshots for the equity curve.
   - `POST /api/kill-switch` — disables all bots in one call. Returns count disabled.
2. Add a WebSocket endpoint `/ws` that pushes events: `signal.received`, `trade.opened`, `trade.closed`, `balance.updated`. Dashboard subscribes for live updates.
3. Add CORS for your dashboard origin only.
4. Write API contract tests.

## Checkpoint

`curl` each endpoint with the bearer token and get correct data. Open the WebSocket with `wscat`, trigger a webhook, see the event arrive.

## Notes
