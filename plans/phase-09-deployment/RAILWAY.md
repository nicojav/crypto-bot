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
└── dashboard service  → apps/dashboard  (server/index.js — static host + auth'd REST/WS proxy, port $PORT)
```

Both services share the same Railway project. The bot receives TradingView webhooks at its public Railway URL. The dashboard's own server proxies to the bot's REST / WebSocket API — the browser never talks to the bot directly, and never sees its API token (see `apps/dashboard/README.md`'s Data flow section).

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

5. **Settings → Source → Watch Paths** → add these lines so the bot only redeploys when its own code changes (not on every monorepo push):
   ```
   apps/bot/**
   packages/**
   package.json
   package-lock.json
   ```
6. **Settings → Networking → Generate Domain** to get a public HTTPS URL.
7. Trigger a deploy. Once green, note the URL (e.g. `https://bot-production.up.railway.app`).

---

### 3. Dashboard service

1. Project canvas → **+ New** → **GitHub Repo** → same `crypto-bot` repo.
2. Rename to `dashboard` (Settings → Service Name).
3. **Settings → Config-as-code Path** → set `apps/dashboard/railway.toml`.  
   *(Dashboard config: builds the Vite SPA, starts `apps/dashboard/server/index.js` — a small Node
   server that replaces plain static hosting; see `apps/dashboard/README.md`'s Data flow section.
   It gates every request behind a password login, serves the built SPA, and proxies `/api/*` and
   the WebSocket to the bot with the real `API_TOKEN` injected server-side, so that token never
   ships in the browser bundle. Healthchecks `/health`, not `/` — `/` 302s to `/login` when
   logged out, which would otherwise look like a failed healthcheck.)*
4. **Variables** → add:

| Variable | Value |
|---|---|
| `BOT_URL` | `https://<bot>.up.railway.app` (bot service URL from step 2) — used server-side by the proxy |
| `API_TOKEN` | **same value** as the bot service's `API_TOKEN` — the proxy authenticates to the bot with it |
| `DASHBOARD_PASSWORD` | a password only you know — this is what gates the dashboard's login page |
| `VITE_WEBHOOK_BASE_URL` | `https://<bot>.up.railway.app` (same as `BOT_URL`) — baked into the built bundle so each bot's webhook-URL display/copy button shows the bot's real public address; safe to expose (it's not a secret, just the webhook endpoint TradingView needs) |

   Do **not** set `VITE_API_URL` or `VITE_API_TOKEN` here — those are dev-only (direct
   browser-to-bot, no proxy); leaving them unset in a production build is what makes the React
   app default to same-origin requests through the proxy above instead.
5. **Settings → Source → Watch Paths** → add these lines so the dashboard only redeploys when its own code changes:
   ```
   apps/dashboard/**
   packages/**
   package.json
   package-lock.json
   ```
6. **Settings → Networking → Generate Domain** to get the dashboard's public URL.
7. Trigger a deploy.

**Wire CORS**: go back to the bot service → **Variables** → update `DASHBOARD_ORIGIN` to `https://<dashboard>.up.railway.app`.
*(This now only matters for direct browser calls — e.g. local dev, or hitting the bot's own URL
directly — since production dashboard traffic to the bot is server-to-server through the proxy,
not a cross-origin browser request.)*

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

Then open the dashboard URL → log in with `DASHBOARD_PASSWORD` → bots list loads → WebSocket connects (check DevTools → Network → WS, request URL should be same-origin, not the bot's URL).

---

## Admin operations

### Local scripts setup

Scripts that target the deployed bot (e.g. `reset-trade-data`) read from `apps/bot/.env.production`. Create it once — it's gitignored:

```bash
# Get the production API token
railway run --service service-exchange-bot -- printenv API_TOKEN

# Create the file
cat > apps/bot/.env.production << EOF
BOT_URL=https://your-service.up.railway.app
API_TOKEN=<paste token here>
EOF
```

### Reset trades and signals

Use this when you want a clean slate for strategy testing (e.g. after fixing a bug, before a new backtest period). Preserves bot configs and balance history.

```bash
# Dry-run — shows counts, deletes nothing
npm run reset-trade-data --workspace apps/bot

# Wipe all trades and signals
npm run reset-trade-data --workspace apps/bot -- --confirm
```

Or directly via curl:

```bash
# Dry-run
curl -X DELETE https://<bot>.up.railway.app/api/reset-trade-data \
  -H "Authorization: Bearer YOUR_API_TOKEN"

# Wipe
curl -X DELETE "https://<bot>.up.railway.app/api/reset-trade-data?confirm=true" \
  -H "Authorization: Bearer YOUR_API_TOKEN"
```

Response: `{"dryRun":false,"trades":70,"signals":189}`

---

## Known limitations / tech debt

See `memory/project_deployment_tech_debt.md` for the full list. Short version:

- **Redeploy = ~30–60s downtime** (SQLite Volume is single-attach). Workaround: pause TradingView alerts before deploying, re-enable after. Risk is low on ≥1H strategies.
- **TradingView does not retry failed webhooks** — a signal fired during a deploy window is dropped.
- This is testnet only (`BYBIT_TESTNET=true`). Do not flip to live until the tech-debt items are addressed.

## Rollback

Railway keeps prior deployments. In the Railway dashboard → **Deployments** → click any previous build → **Rollback**. Takes ~30s.
