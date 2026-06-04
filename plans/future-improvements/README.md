# Future Improvements Backlog

Items requested during development, deferred for after testnet validation.

---

## Deployment infrastructure (staging, CI, blue/green)

**Status:** Planned — see [`DEPLOYMENT_INFRASTRUCTURE.md`](DEPLOYMENT_INFRASTRUCTURE.md)

**Requested:** Prompted by the PnL backfill incident — maintenance scripts had to run on production because no staging exists. Phased plan covers: Railway staging env, branch-based deploys + GitHub Actions CI, `--confirm-production` flag for scripts, graceful shutdown + Cloudflare webhook buffer, Postgres migration, and Railway rolling/blue-green deploys. Phases A–C are this-week wins; D–F are required before live funds.

---

## Live unrealized PnL for open trades

**Status:** Pending

**Requested:** Show real-time floating P&L for open positions in the dashboard trades table. Currently open trades show `—` in the PnL column — `pnlUsd` is only populated when the reconciler closes the trade.

**Approach: Option A — Periodic REST polling (recommended)**

Every 60 seconds the reconciler already runs a balance snapshot. Extend it to also update `unrealizedPnlUsd` for each open trade by querying Bybit's position endpoint.

Files to touch:
- `apps/bot/prisma/schema.prisma` — add `unrealizedPnlUsd Float?` to `Trade` model
- `apps/bot/src/reconciliation/reconciler.ts` — query `getPositions` for open trade symbols in the snapshot loop, update `unrealizedPnlUsd`
- `apps/bot/src/routes/api.ts` — include `unrealizedPnlUsd` in trade response schema
- `apps/dashboard/src/api/client.ts` — add `unrealizedPnlUsd: number | null` to `Trade` type
- `apps/dashboard/src/components/TradesTable.tsx` — show `unrealizedPnlUsd` in green/red for open trades instead of `—`

Migration required:
```bash
npm run --workspace apps/bot prisma migrate dev --name add_unrealized_pnl
```

**Approach: Option B — Live WebSocket push (real-time)**

The reconciler already subscribes to Bybit's private `position` WebSocket topic. On each position update, publish a `pnl.updated` event to the event bus → dashboard WebSocket handler invalidates the trades query.

Requires a new event type in `eventBus.ts` and a new handler in `useWebSocket.ts`. More real-time than Option A but more moving parts.

**Recommendation:** Start with Option A — 60s latency is fine for a personal bot and the implementation is straightforward.
