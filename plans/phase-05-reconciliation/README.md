# Phase 5 — Position & balance reconciliation

**Status:** Pending

## Goal

Keep the local DB in sync with what's actually on the exchange. This is what makes the dashboard truthful.

## Tasks

1. Connect to Bybit's WebSocket private streams: position updates, order updates, wallet updates.
2. On every position update event, find the matching `Trade` row by `exchangeOrderId` or symbol+bot, update `exitPrice`, `pnlUsd`, `status`, `closedAt` when it closes.
3. Every 60s, write a `BalanceSnapshot` row. (Used for the equity curve.)
4. Add a startup reconciliation: on boot, fetch all current positions from REST and compare with `OPEN` trades in the DB. Flag mismatches in logs — these are bugs to investigate before they cost real money.
5. Handle WebSocket reconnects gracefully (auto-reconnect with backoff, re-subscribe, and run a REST reconciliation after reconnect).

## Checkpoint

Open a position via webhook, manually close it from the Bybit testnet UI. Within seconds your DB shows the trade as `CLOSED` with the right PnL. Restart the bot — startup logs show "0 mismatches".

## Notes
