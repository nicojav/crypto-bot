# Phase 11 — Hardening before real money

**Status:** Pending

> **Do not skip this phase.** Run on testnet for at least 2–3 weeks before proceeding.

## Goal

Make the system safe enough to trust with real money. Every failure mode should have a known, tested response.

## Tasks

1. Audit every risk check. Add: max concurrent positions across all bots, max daily trade count, cooldown after N consecutive losses.
2. Add a "real money mode" gate: a separate env var `LIVE_TRADING=true` that must be set explicitly. Without it, the bot refuses to use mainnet keys even if they're configured.
3. Generate separate Bybit API keys for live with **withdrawal disabled** and IP-whitelisted to your VPS. Trading-only permissions.
4. Start live with a tiny account (a few hundred USDT) and `maxPositionUsd` capped low. Scale only after a month of stable behavior.
5. Document your runbook: how to kill switch, how to manually close positions, how to roll back a deploy.

## Checkpoint

You can answer "what happens if X breaks" for every component without thinking. If you can't, don't go live yet.

## Notes
