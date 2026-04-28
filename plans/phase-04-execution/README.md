# Phase 4 — Order execution & signal processor

**Status:** Pending

## Goal

Wire signals to actual (testnet) orders, with risk checks and a dry-run mode.

## Tasks

1. Add a signal-processing worker in the same Node process:
   - Simple: a `setInterval` polling the `Signal` table for `PENDING` rows every 500ms.
   - Better: an in-memory queue (`p-queue`) the webhook handler pushes to after insert.
   Start simple; you can swap later.
2. The processor pulls a pending signal and:
   - Loads the bot config.
   - Runs **risk checks**: max position size in USD, max leverage, kill-switch flag, daily loss limit (sum of today's closed trade PnL — reject if below threshold).
   - If `bot.dryRun = true`: logs the intended order, marks signal as `EXECUTED` with a synthetic `Trade` row tagged dry-run. Stops here.
   - Otherwise sets leverage on Bybit, then places the order.
3. Implement order placement methods on the Bybit wrapper:
   - `setLeverage(symbol, leverage)` — idempotent, ignore "leverage not modified" errors.
   - `placeMarketOrder({ symbol, side, qty, reduceOnly })` — returns exchange order ID.
   - For `BUY`/`SELL` actions: open a position. For `CLOSE`: place a `reduceOnly` market order in the opposite direction sized to the current position.
4. Quantity calculation: convert `maxPositionUsd` into contract qty using current mark price + lot size rounding. Never exceed `maxPositionUsd`.
5. On success, update `Signal` to `EXECUTED` and create a `Trade` row with `OPEN` status.
6. On failure, update `Signal` to `REJECTED` with the error message. Do not retry automatically.
7. Tests: mock the Bybit client and verify the processor handles a BUY signal, a CLOSE signal with no open position (should reject cleanly), and a signal that exceeds risk limits.

## Checkpoint

Send a `BUY` webhook with `dryRun=true` — see the intended order in logs and DB, no exchange call. Flip `dryRun=false`, send again — see a real testnet order in your Bybit testnet UI. Send `CLOSE` — position goes to zero.

## Notes
