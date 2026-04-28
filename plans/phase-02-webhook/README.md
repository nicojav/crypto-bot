# Phase 2 — Webhook receiver

**Status:** Pending

## Goal

A hardened HTTP endpoint that accepts TradingView alerts, validates them, dedupes them, and stores them. No exchange calls in this phase.

## Tasks

1. In `apps/bot`, set up Fastify with a `POST /webhook/:botId` route.
2. Define the expected JSON payload with `zod`:
   ```
   { secret: string, webhookId: string, action: "BUY"|"SELL"|"CLOSE", symbol: string, price?: number, meta?: object }
   ```
3. Validate the `secret` against an env var using a constant-time compare (`crypto.timingSafeEqual`). Reject with 401 if it doesn't match. Do NOT log the secret.
4. Look up the bot by `botId`. Reject if not found or `enabled = false`.
5. Dedupe: try to insert the `Signal` row with `webhookId` as a unique constraint. On conflict, mark as `DUPLICATE` and return 200 (don't return an error — TradingView will retry).
6. Otherwise insert as `PENDING` and return 202 Accepted.
7. Add structured logging with `pino`. Every request gets a request ID.
8. Add a `/health` endpoint returning 200.
9. Write integration tests using `vitest` + Fastify's `inject()`: valid signal, bad secret, duplicate webhookId, disabled bot, malformed payload.

## Checkpoint

`curl` with a valid payload returns 202 and creates a `Signal` row. Replaying the same `curl` returns 200 with `DUPLICATE`. Bad secret returns 401. All tests green.

## Notes
