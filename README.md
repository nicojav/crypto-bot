# crypto-bot

TradingView → Webhook → Bybit Futures trading bot with a React dashboard.

**Stack:** Node.js + TypeScript + Fastify · SQLite + Prisma · React + Vite + TailwindCSS · bybit-api SDK

## Structure

```
apps/
  bot/          Fastify backend — webhook receiver, order execution, position tracking
  dashboard/    React frontend — live P&L, trade history, position monitor
packages/
  eslint-config Shared ESLint rules
```

## Prerequisites

- Node.js ≥ 20
- npm ≥ 10 (workspaces support)

## Setup

```bash
# 1. Install all dependencies
npm install

# 2. Copy and fill in env files
cp apps/bot/.env.example apps/bot/.env
cp apps/dashboard/.env.example apps/dashboard/.env

# 3. Start both apps in dev mode
npm run dev
```

The bot starts on **http://localhost:3000** and the dashboard on **http://localhost:5173**.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start both apps with hot-reload |
| `npm run build` | Compile both apps for production |
| `npm run lint` | Run ESLint across both apps |
| `npm run test` | Run bot unit tests (Vitest) |
| `npm run format` | Auto-format with Prettier |

## Bot modes

Each bot row in the database has a `dryRun` flag that controls how signals are executed:

| Mode | `dryRun` | `BYBIT_TESTNET` | What happens |
|------|----------|-----------------|--------------|
| **Dry-run** | `true` | any | Signal processed, fake trade recorded in DB, **no order sent to Bybit** |
| **Testnet** | `false` | `true` | Real order placed on Bybit **testnet** (fake money, real API) |
| **Live** | `false` | `false` | Real order placed on Bybit **live** (real money) |

**Recommended progression:**
1. Start with `dryRun: true` — verify the full TradingView → webhook → dashboard pipeline works
2. Switch to `dryRun: false` + `BYBIT_TESTNET=true` — watch real testnet orders appear in your Bybit account
3. Only set `BYBIT_TESTNET=false` when you're confident everything is working correctly

## Environment variables

See `apps/bot/.env.example` and `apps/dashboard/.env.example` for full documentation of every variable.
