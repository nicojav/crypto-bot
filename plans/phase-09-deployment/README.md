# Phase 9 — Deployment

**Status:** Pending

## Goal

Bot runs 24/7 on a server, not your laptop.

## Tasks

1. Provision a small VPS (Hetzner CX22 or DO basic droplet, ~$5/mo). Ubuntu LTS.
2. Install Node via `nvm`, set up a non-root user, configure UFW firewall (only 22, 80, 443 open).
3. Set up Caddy or Nginx as a reverse proxy with automatic HTTPS via Let's Encrypt. TradingView requires HTTPS for webhooks.
4. Run the bot under `systemd` (or `pm2`) with auto-restart on crash and on reboot.
5. Build the React dashboard to static files; Caddy serves it on the same domain under `/`.
6. Set up log rotation. Pipe pino logs to a file or a service like Better Stack (free tier is enough for one bot).
7. Configure NTP (`timedatectl set-ntp true`).
8. Back up the SQLite DB nightly to S3 / Backblaze B2 with a cron + `litestream` (continuous replication is even better).

## Checkpoint

TradingView webhooks hit your production domain. Bot survives `sudo reboot`. You can SSH in, tail logs, and the dashboard loads over HTTPS.

## Notes
