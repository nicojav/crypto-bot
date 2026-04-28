# Phase 1 — Database schema & Prisma setup

**Status:** Pending

## Goal

A typed, migrated SQLite database that both apps can read.

## Tasks

1. Add Prisma to `apps/bot`. Initialize with SQLite provider.
2. Define the schema:
   - `Bot`: `id`, `name`, `symbol` (e.g. BTCUSDT), `enabled` (bool), `dryRun` (bool), `maxLeverage`, `maxPositionUsd`, `createdAt`.
   - `Signal`: `id`, `botId`, `webhookId` (unique, for dedupe), `action` (BUY/SELL/CLOSE), `payload` (JSON), `receivedAt`, `processedAt`, `status` (PENDING/EXECUTED/REJECTED/DUPLICATE), `rejectionReason`.
   - `Trade`: `id`, `botId`, `signalId`, `exchangeOrderId`, `symbol`, `side`, `qty`, `entryPrice`, `exitPrice` (nullable), `pnlUsd` (nullable), `status` (OPEN/CLOSED), `openedAt`, `closedAt`.
   - `BalanceSnapshot`: `id`, `equityUsd`, `availableUsd`, `takenAt`. (For PnL charting later.)
3. Generate the Prisma client. Run an initial migration.
4. Write a small `seed.ts` that creates one test bot row so the dashboard has something to render.

## Checkpoint

`npx prisma studio` shows all tables. `seed` runs cleanly. Prisma client is importable from a TS file with full autocomplete.

## Notes
