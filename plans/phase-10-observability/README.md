# Phase 10 — Observability & alerts

**Status:** Pending

## Goal

Know when things are broken before you lose money.

## Tasks

1. Add a Telegram or Discord bot for notifications. Send a message on:
   - Trade opened / closed (with PnL).
   - Signal rejected (with reason).
   - Kill switch activated.
   - Daily loss limit hit.
   - WebSocket disconnected for >30s.
   - Bot process crashed (catch via systemd `OnFailure=`).
2. Add a daily summary message at a fixed time: total trades, win rate, PnL, current equity.
3. Add an uptime check (UptimeRobot free tier) hitting `/health` every 5 minutes. Alert on downtime.

## Checkpoint

Trigger each notification scenario manually and confirm you get pinged.

## Notes
