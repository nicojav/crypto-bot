# Phase 09 — Railway deployment

> **See also**: [`README.md`](README.md) for the original self-managed VPS path (Hetzner + Caddy + systemd + litestream). Railway is the faster route for testnet; the VPS plan is the right option if you want full control in production.

## What Railway gives you (vs the VPS plan)

| VPS plan | Railway |
|---|---|
| Manual Caddy / Let's Encrypt setup | HTTPS out of the box |
| systemd / pm2 | Managed container restarts |
| SQLite on local disk + litestream | SQLite on a persistent Volume |
| Manual SSH deploys | git push → auto deploy |
| ~$5/mo Hetzner CX22 | Starter ~$5/mo (or free Hobby tier) |

---

## Architecture

```
Railway project
├── bot service        → apps/bot  (Fastify, port $PORT)
│   └── Volume /data   → prod.db lives here
└── dashboard service  → apps/dashboard  (Vite preview, port $PORT)
```

Both services share the same Railway project. The bot receives TradingView webhooks at its public Railway URL. The dashboard calls the bot's REST / WebSocket API.

---

## Step-by-step setup

> Both services come from the **same GitHub repo** but use **separate per-service `railway.toml` files** (`apps/bot/railway.toml` and `apps/dashboard/railway.toml`). You point each Railway service at its own file via **Settings → Config-as-code Path** — this is what keeps the bot's `prisma migrate deploy` from accidentally running against the dashboard.

### 1. Create the Railway project

1. Sign in at [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**.
2. Select this repo. Railway creates one service automatically — this becomes the **bot** service.

---

### 2. Bot service

Configure the auto-created service:

1. Rename it to `bot` (Settings → Service Name).
2. **Settings → Config-as-code Path** → set `apps/bot/railway.toml`.  
   *(This is what tells Railway to use the bot-specific config — build command, migrate step, `/health` healthcheck — instead of guessing from the repo root.)*
3. **Volumes** → **Add Volume** → Mount path: `/data`, size: 1 GB.
4. **Variables** → add all env vars:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `file:/data/prod.db` |
| `WEBHOOK_SECRET` | *(generate: `openssl rand -hex 32`)* |
| `API_TOKEN` | *(generate: `openssl rand -hex 32`)* |
| `BYBIT_API_KEY` | testnet API key from bybit testnet console |
| `BYBIT_API_SECRET` | testnet API secret |
| `BYBIT_TESTNET` | `true` |
| `DASHBOARD_ORIGIN` | `http://localhost:5173` *(placeholder — update after step 3)* |
| `LOG_LEVEL` | `info` |

> **Do not set `PORT`** — Railway injects it automatically. The bot already reads it at `apps/bot/src/env.ts:15`.

5. **Settings → Networking → Generate Domain** to get a public HTTPS URL.
6. Trigger a deploy. Once green, note the URL (e.g. `https://bot-production.up.railway.app`).

---

### 3. Dashboard service

1. Project canvas → **+ New** → **GitHub Repo** → same `crypto-bot` repo.
2. Rename to `dashboard` (Settings → Service Name).
3. **Settings → Config-as-code Path** → set `apps/dashboard/railway.toml`.  
   *(Dashboard config: builds the Vite SPA, starts `vite preview`, healthchecks `/`.)*
4. **Variables** → add:

| Variable | Value |
|---|---|
| `VITE_API_URL` | `https://<bot>.up.railway.app` (bot service URL from step 2) |

5. **Settings → Networking → Generate Domain** to get the dashboard's public URL.
6. Trigger a deploy.

**Wire CORS**: go back to the bot service → **Variables** → update `DASHBOARD_ORIGIN` to `https://<dashboard>.up.railway.app`.

---

### 4. TradingView alert setup

Use the strategy from `strategies/ema-cross.pine`. When creating the TradingView alert:

- **Webhook URL**: `https://<bot>.up.railway.app/webhook/<botId>`  
  *(get `botId` from the dashboard or `GET /api/bots`)*
- **Message** (paste exactly, replace `YOUR_SECRET`):

```json
{
  "secret": "YOUR_WEBHOOK_SECRET",
  "webhookId": "{{ticker}}-{{interval}}-{{time}}-{{strategy.order.action}}",
  "action": "{{strategy.order.action}}",
  "symbol": "{{ticker}}",
  "price": {{close}}
}
```

TradingView fills `{{strategy.order.action}}` with `"buy"` or `"sell"`. The bot normalises to uppercase automatically (`apps/bot/src/routes/webhook.ts`).

---

## Verification checklist

```bash
# 1. Bot healthcheck
curl https://<bot>.up.railway.app/health
# → {"status":"ok"}

# 2. Smoke-test webhook (replace values)
curl -X POST https://<bot>.up.railway.app/webhook/1 \
  -H 'Content-Type: application/json' \
  -d '{
    "secret":"YOUR_WEBHOOK_SECRET",
    "webhookId":"smoke-1",
    "action":"buy",
    "symbol":"BTCUSDT",
    "price":50000
  }'
# → {"status":"ACCEPTED"}

# 3. Confirm signal persisted
curl -H 'Authorization: Bearer YOUR_API_TOKEN' \
  https://<bot>.up.railway.app/api/signals
# → array with the smoke signal

# 4. Redeploy bot, re-run step 3
# → signal row still present (proves Volume is wired)
```

Then open the dashboard URL → bots list loads → WebSocket connects (check DevTools → Network → WS).

---

## Known limitations / tech debt

See `memory/project_deployment_tech_debt.md` for the full list. Short version:

- **Redeploy = ~30–60s downtime** (SQLite Volume is single-attach). Workaround: pause TradingView alerts before deploying, re-enable after. Risk is low on ≥1H strategies.
- **TradingView does not retry failed webhooks** — a signal fired during a deploy window is dropped.
- This is testnet only (`BYBIT_TESTNET=true`). Do not flip to live until the tech-debt items are addressed.

## Rollback

Railway keeps prior deployments. In the Railway dashboard → **Deployments** → click any previous build → **Rollback**. Takes ~30s.
