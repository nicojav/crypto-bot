# Phase 0 — Project setup & repo scaffolding

**Status:** ✅ Complete

## Goal

A clean monorepo structure with TypeScript, linting, and env handling working end to end.

## Tasks

1. Initialize a monorepo with two packages: `apps/bot` (backend) and `apps/dashboard` (React frontend). Use npm workspaces.
2. Set up TypeScript on both with strict mode (`"strict": true`, `"noUncheckedIndexedAccess": true`).
3. Add ESLint + Prettier with a shared config.
4. Create `.env.example` files documenting every variable the system will need (Bybit testnet keys, webhook secret, DB path, port, log level). Use `dotenv` and validate at startup with `zod`.
5. Add a `README.md` with run instructions and npm scripts: `dev`, `build`, `test`, `lint`.
6. Initialize git, add a sensible `.gitignore` (especially `.env`, `*.db`, `node_modules`, `dist`).

## Checkpoint

`npm run dev` starts both apps. Bot logs "ready on :3000", dashboard loads a blank page on :5173. Pushing without `.env` to git fails or is impossible.

## What was built

Shipped in commit `f3444a2`, pushed to `https://github.com/nicojav/crypto-bot`.

- **npm workspaces** — `apps/bot`, `apps/dashboard`, `packages/eslint-config`
- **TypeScript** — strict + `noUncheckedIndexedAccess` on both apps; separate `tsconfig.json` per app
- **ESLint + Prettier** — shared config at `packages/eslint-config/index.js`, consumed via `.eslintrc.cjs` in each app
- **Fastify bot** — `apps/bot/src/index.ts`, health endpoint at `GET /health`, logs "ready on :3000"
- **Zod env validation** — `apps/bot/src/env.ts`; exits cleanly on missing/invalid vars
- **React + Vite + Tailwind** — `apps/dashboard/` skeleton renders a blank page on :5173
- **`.env.example`** — both apps; documents 7 variables (`BYBIT_API_KEY`, `BYBIT_API_SECRET`, `BYBIT_TESTNET`, `WEBHOOK_SECRET`, `DATABASE_URL`, `PORT`, `LOG_LEVEL`)
- **`.gitignore`** — blocks `.env`, `*.db`, `node_modules`, `dist` at root
- **`README.md`** — setup steps + npm scripts table

## Notes
