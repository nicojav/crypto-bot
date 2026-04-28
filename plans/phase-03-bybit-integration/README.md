# Phase 3 — Bybit testnet integration (read-only first)

**Status:** Pending

## Goal

Prove you can talk to Bybit testnet before you place a single order.

## Tasks

1. Install `bybit-api`. Create `apps/bot/src/exchange/bybit.ts` with a typed client wrapper.
2. Configure with `testnet: true` and testnet API keys from `.env`.
3. Implement read-only methods first:
   - `getBalance()` — returns USDT equity and available.
   - `getPositions(symbol)` — returns current position size and entry.
   - `getInstrumentInfo(symbol)` — returns tick size, lot size, min qty (needed to place valid orders).
4. Write a small CLI script `scripts/check-bybit.ts` that prints balance, positions on BTCUSDT, and instrument info. Run it manually.
5. Add error handling: log and surface Bybit error codes clearly. Wrap all calls with retry-on-network-error (max 3 retries, exponential backoff) but **never** retry order placement automatically.
6. Set up NTP on your dev machine, or use Bybit's `getServerTime()` to detect drift and warn at startup if your clock is off by more than 2s.

## Checkpoint

The CLI script prints your testnet USDT balance (5,000 USDT default), zero positions, and BTCUSDT lot size. If you fund the testnet wallet from Bybit's faucet, the next run shows the new balance.

## Notes
