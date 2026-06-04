# Deployment infrastructure: staging environment, safer deploys, no-prod maintenance scripts

**Status:** Planned — not yet implemented. Prompted by the PnL backfill incident (2026-06-04) where a one-off data-repair script had to be executed inside the production Railway container because no staging environment exists.

## Context

The PnL backfill incident exposed a structural gap in our deployment model. To recover `null`-PnL rows we had to execute `npm run backfill:pnl` directly inside the **production** Railway container — the only environment that exists, holding the only DB the bot writes to. That is a category of problem, not a one-off: any future schema migration, data repair, or risky behavior change has the same shape — there is nowhere safe to rehearse it.

Adjacent tech debt already on the books compounds this: every Railway redeploy currently kills the bot mid-request, no webhook buffer absorbs the gap, graceful shutdown is unverified, and a SQLite-on-Volume topology fundamentally blocks any second instance from attaching. The bot is operationally fragile *and* operationally untestable.

We want to fix both at once — a real staging environment removes the "I have to test in prod" pressure today, and the deployment-safety work (graceful shutdown, webhook buffer, eventually Postgres + blue/green) removes the deploy-window data-loss risk before this ever touches live funds. The plan is phased so each step delivers value standalone and the early phases are cheap enough to land in a single week.

Current state (verified):

- Single Railway project, one service per app (`apps/bot`, `apps/dashboard`), both deployed from `main` via nixpacks.
- `apps/bot/railway.toml`: `NIXPACKS` builder, `npm run migrate:deploy` then `node apps/bot/dist/index.js`, `/health` healthcheck, `restartPolicyType = "ON_FAILURE"`. No graceful-shutdown handling at the app level.
- SQLite at `file:/data/prod.db` on a Railway Volume — single-attach, mutex on the underlying file, **cannot run two instances at once**.
- No CI. No automatic tests on PRs. No staging. No deploy approval gate.
- Backfill script lives at `apps/bot/src/scripts/backfillRealizedPnl.ts` and is invoked via `npm run backfill:pnl` inside the prod container. There is no `--confirm-production` guard.

## Goals

1. **No more scripts on production without staging validation** — a staging env exists, scripts run there first, prod runs require explicit confirmation.
2. **Branch-based deploys with a CI gate** — `develop` → staging, `main` → prod, both gated on tests + typecheck + lint.
3. **Zero data loss across a deploy** — webhook buffer + verified graceful shutdown so the deploy window doesn't drop TradingView signals or strand mid-flight orders.
4. **Path to true blue/green** — migrate off SQLite-on-Volume to a backing store that allows two instances (managed Postgres), then enable Railway's rolling/blue-green deploys.

Each phase is independently shippable. Stop at any phase if value plateaus.

## Phased approach

### Phase A — Staging environment on Railway (1–2 days)

Smallest change that fixes the immediate "scripts on prod" pain.

1. In the existing Railway project, add a second **Environment** (Railway has first-class environments: `production`, `staging`). Each environment gets its own service instances, variables, and Volume.
2. Clone the `bot` and `dashboard` services into `staging`. Same `railway.toml` files. Separate Volume per env (`/data` is per-env automatically).
3. Variables in `staging`:
   - `BYBIT_TESTNET=true`, fresh testnet API keys (never share keys between envs).
   - `DATABASE_URL=file:/data/staging.db`.
   - Distinct `WEBHOOK_SECRET` and `API_TOKEN`.
   - `LOG_LEVEL=debug`.
4. Public URL: `bot-staging.up.railway.app` (Railway generates per-env).
5. Document staging URLs and credentials in `plans/phase-09-deployment/RAILWAY.md` under a new "Staging" section.

**Outcome:** there is a place to run `backfill:pnl --dry-run` against a non-prod DB before touching production.

### Phase B — Branch-based deploy + GitHub Actions CI (1–2 days)

1. Add a `develop` branch as the integration line. Convention: feature branches → PR into `develop` → auto-deploy to staging on merge. PR `develop` → `main` to promote to prod.
2. Railway → each service → **Settings → Source → Branch**: bot+dashboard in `staging` env watch `develop`; bot+dashboard in `production` env watch `main`.
3. New file `.github/workflows/ci.yml`:
   - Trigger on `pull_request` and `push` to `develop`/`main`.
   - Steps: `npm ci` → `npm run lint` → `npm run build --workspaces` → `npm test --workspace apps/bot` → `tsc --noEmit` for the dashboard.
   - Required check on `main` (branch protection).
4. Optional follow-up: add a `deploy-staging-smoke.yml` that runs after staging deploys — hits `/health`, `/api/equity/summary`, and asserts a 200.

**Outcome:** no broken code reaches even staging without tests passing; promotion to prod is a deliberate PR, not a `git push`.

### Phase C — Maintenance script policy (half day)

Convert `apps/bot/src/scripts/backfillRealizedPnl.ts` (and any future script) to follow one rule: **production runs require an explicit flag.**

1. Add a small helper `apps/bot/src/scripts/_lib/requireConfirm.ts`:
   ```ts
   export function requireConfirm(label: string): void {
     const isProd = process.env.RAILWAY_ENVIRONMENT_NAME === "production"
       || process.env.NODE_ENV === "production"
       || process.env.DATABASE_URL?.includes("prod");
     if (!isProd) return;
     if (!process.argv.includes("--confirm-production")) {
       console.error(`Refusing to run "${label}" on production without --confirm-production`);
       process.exit(2);
     }
   }
   ```
2. Call `requireConfirm("backfill:pnl")` at the top of `main()` in `backfillRealizedPnl.ts`.
3. Add a short doc `plans/phase-09-deployment/SCRIPTS.md` listing the canonical pattern: dry-run on staging → review output → run on staging without dry-run → if happy, run on prod with `--confirm-production`.
4. Tag the script logs with the env name (`RAILWAY_ENVIRONMENT_NAME`) so we can grep history later.

**Outcome:** a future you (or future me) cannot mass-mutate prod by reflex.

### Phase D — Verified graceful shutdown + webhook buffer (2–3 days)

These are the two pieces that close the deploy-window data-loss gap. They unblock blue/green later but are valuable on their own — even a non-blue/green Railway redeploy currently SIGKILLs the bot.

1. **Graceful shutdown in the bot.**
   - Wire `SIGTERM` → `app.close()` → flush reconciler timers → close Prisma → close Bybit WS → process exit. Fastify already supports this via `app.addHook("onClose", ...)`. Add hooks in `apps/bot/src/index.ts` for the reconciler interval and the Bybit WS subscriptions.
   - Set Railway `terminationGracePeriodSeconds` (via `railway.toml` `[deploy] gracefulShutdownTimeout` or service settings) to 30s so the bot has time to finish a close-position round-trip.
   - Test by sending SIGTERM locally and asserting no in-flight Prisma transaction is interrupted (mid-update logs cleanly, no `PRISMA_*_CLOSED` errors).

2. **Webhook buffer.** TradingView fires-and-forgets — if the bot is mid-deploy and the receive socket isn't open, the signal is **gone**. Buffer in front of the bot:
   - Cheapest option: **Cloudflare Worker** in front of `bot.up.railway.app/webhook`. Worker writes the request body + headers to Cloudflare Queues (or KV with TTL), then forwards immediately. On forward failure, Queue retries with exponential backoff for ~15 minutes.
   - Idempotency is already handled in the bot — `webhookId` has a `UNIQUE` constraint, so duplicate replays are no-ops.
   - Alternative: skip Cloudflare, point TradingView at a second Railway service (`webhook-buffer`) that just writes to a Postgres-backed queue table. Heavier infra but stays inside Railway. Recommend Cloudflare Worker — lower ops, sub-ms latency.

**Outcome:** every deploy (or restart) is signal-safe. This is the load-bearing prerequisite for ever putting real money on this bot.

### Phase E — Postgres migration (3–5 days, prerequisite for Phase F)

Required for true blue/green (two instances, neither blocked on the SQLite mutex) and for any "scale to more bots" future.

1. Add Railway Postgres plugin in both `staging` and `production` envs. Each env gets its own `DATABASE_URL` injected automatically.
2. Update `apps/bot/prisma/schema.prisma` `datasource` from `sqlite` to `postgresql`. Drop the `@prisma/adapter-better-sqlite3` dependency from `apps/bot/package.json`.
3. Generate a fresh baseline migration: `prisma migrate dev --name init_postgres` in a clean working copy.
4. **Data migration** (one-time): write a `migrateSqliteToPostgres.ts` script that reads the existing `/data/prod.db` via better-sqlite3 and bulk-inserts into Postgres. Run on staging end-to-end before touching prod.
5. Cut over prod: maintenance window, stop bot, snapshot SQLite, run migration script, point bot at Postgres, smoke-test, resume. Keep SQLite file as backup for one week.
6. Audit every `prisma.$transaction([...])` call — Postgres has stricter serialization semantics than SQLite; some sequences that work locally may need `Serializable` isolation explicitly.

**Outcome:** the deploy mutex is gone. Two bot instances can now talk to the same DB.

### Phase F — Blue/green (or rolling) deploys (1 day, once Phase E lands)

1. With Postgres backing, set Railway `[deploy] strategy = "ROLLING"` in `apps/bot/railway.toml`. Railway brings up the new instance, waits for `/health` 200, drains the old one. Bybit WS reconnects on the new instance; TradingView routes through the webhook buffer; mid-flight orders finish on the old instance during drain.
2. Add a `/ready` endpoint distinct from `/health`: `/ready` returns 200 only when the Bybit WS is connected AND the reconciler has run at least once AND no migration is in flight. Point Railway's healthcheck at `/ready`.
3. Verify: trigger a deploy while a position is open. Confirm the old instance handles the in-flight close before exiting; confirm the new instance picks up the next reconciliation cycle; confirm no duplicate orders are sent.

**Outcome:** zero-downtime deploys, zero signal loss, end-to-end safe.

## Critical files

- `apps/bot/railway.toml` — add `gracefulShutdownTimeout`, later `strategy = "ROLLING"`.
- `apps/bot/src/index.ts` — register `onClose` hooks for reconciler + Bybit WS; add SIGTERM handler.
- `apps/bot/src/scripts/_lib/requireConfirm.ts` — NEW, shared safety check for all scripts.
- `apps/bot/src/scripts/backfillRealizedPnl.ts` — call `requireConfirm` at the top of `main`.
- `apps/bot/prisma/schema.prisma` — datasource swap in Phase E.
- `apps/bot/package.json` — drop better-sqlite3, add Postgres if needed (Prisma's native pg driver requires no extra adapter).
- `.github/workflows/ci.yml` — NEW, runs lint + build + tests on every PR.
- `plans/phase-09-deployment/RAILWAY.md` — extend with staging section.
- `plans/phase-09-deployment/SCRIPTS.md` — NEW, canonical maintenance-script runbook.
- `infra/cloudflare-worker/webhook-buffer/` — NEW, in Phase D.

## Verification per phase

- **A**: `curl https://bot-staging.up.railway.app/health` returns 200; staging DB has its own writes that don't appear in prod.
- **B**: open a PR with a deliberately failing test; CI blocks merge. Merge a green PR to `develop`; observe staging redeploy. Promote to `main`; observe prod redeploy.
- **C**: run `npm run backfill:pnl` against prod without `--confirm-production`; it must exit 2 and not touch the DB. Same command with `--confirm-production` must run normally.
- **D**: `kill -SIGTERM <bot-pid>` locally; logs show clean shutdown of reconciler + WS within the timeout. Trigger a redeploy while sending a webhook every second; assert every `webhookId` ends up in the DB exactly once.
- **E**: post-cutover, `/api/equity/summary` for the last 30 days matches the pre-cutover values to the cent. Run the reconciler test suite against Postgres in CI.
- **F**: open a position, trigger a deploy, observe: old instance handles the close, new instance takes over the next reconciliation tick, `pnlSource` distribution unchanged.

## Reuse / patterns

- `webhookId` unique constraint already makes the webhook path idempotent — Phase D piggybacks on that, no schema change.
- `apps/bot/src/reconciliation/reconciler.ts` already detects "exchange has position but local DB doesn't" — that's the recovery path after any deploy-window gap, and it already exists. Phase D + F just make the gap shorter.
- `RAILWAY_ENVIRONMENT_NAME` is injected automatically by Railway — Phase C and the logging tags rely on it, no app config needed.

## Suggested sequencing

| Phase | Effort | Blocked by | Ship by |
|---|---|---|---|
| A — Staging env | 1–2 d | nothing | this week |
| B — CI + branch deploys | 1–2 d | A | this week |
| C — Script confirm flag | 0.5 d | A | this week |
| D — Graceful shutdown + webhook buffer | 2–3 d | A | next sprint |
| E — Postgres migration | 3–5 d | D landed in staging | before live funds |
| F — Blue/green | 1 d | E | before live funds |

Phases A–C are essentially "stop hurting ourselves this week." D is the load-bearing safety work. E+F are the proper long-term answer and should land before any non-testnet capital touches the system.
