# Phase 10 — Observability & alerts

**Status:** Done

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

- `Notifier` in `src/notifications/notifier.ts` — subscribes to the EventBus and sends Telegram messages via the Bot API (no extra npm dep, uses `fetch`). Disabled automatically if `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID` are not set.
- Notifications covered: trade opened, trade closed (with PnL), signal rejected, kill switch active, daily loss limit hit, WS reconnect after ≥30s downtime.
- Daily summary fires at `DAILY_SUMMARY_HOUR_UTC` (default 08:00 UTC): trade count, win rate, PnL, current equity.
- Bot crash alert (task 1, last bullet): handled by systemd `OnFailure=` — add a one-shot service that sends a Telegram message. Not code; configure on the VPS.
- UptimeRobot (task 3): point a free monitor at `GET /health` every 5 minutes. The endpoint already exists and returns `{"status":"ok"}`.
