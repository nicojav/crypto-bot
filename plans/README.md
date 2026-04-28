# Crypto Trading Bot — Build Plan

A TradingView → Webhook → Bybit Futures trading bot with a React dashboard, built phase by phase. Each phase ends in a testable checkpoint before the next begins.

**Stack:** Node.js + TypeScript + Fastify · SQLite + Prisma · React + Vite + TailwindCSS · `bybit-api` SDK · VPS deployment

---

## Phase Status

| # | Folder | Title | Status |
|---|--------|-------|--------|
| 0 | [phase-00-setup](phase-00-setup/) | Project setup & repo scaffolding | ✅ Complete |
| 1 | [phase-01-database](phase-01-database/) | Database schema & Prisma setup | Pending |
| 2 | [phase-02-webhook](phase-02-webhook/) | Webhook receiver | Pending |
| 3 | [phase-03-bybit-integration](phase-03-bybit-integration/) | Bybit testnet integration | Pending |
| 4 | [phase-04-execution](phase-04-execution/) | Order execution & signal processor | Pending |
| 5 | [phase-05-reconciliation](phase-05-reconciliation/) | Position & balance reconciliation | Pending |
| 6 | [phase-06-api](phase-06-api/) | Dashboard backend (REST API) | Pending |
| 7 | [phase-07-dashboard](phase-07-dashboard/) | React dashboard | Pending |
| 8 | [phase-08-tradingview](phase-08-tradingview/) | TradingView strategy & alert wiring | Pending |
| 9 | [phase-09-deployment](phase-09-deployment/) | Deployment | Pending |
| 10 | [phase-10-observability](phase-10-observability/) | Observability & alerts | Pending |
| 11 | [phase-11-hardening](phase-11-hardening/) | Hardening before real money | Pending |

---

## How to run a phase with Claude Code

- Hand Claude **one phase at a time**. Open the phase folder's `README.md` and say:
  > "We're working on Phase N of the plan. Here's the current repo state: `[tree output]`. Implement [specific task]."
- **Run the checkpoint yourself** before marking a phase complete and moving on. Don't trust that it works because it compiled.
- Log every non-obvious tradeoff in the phase's **Notes** section. Future-you will thank present-you.
- Update the status table above and the phase `README.md` when a phase completes.

---

## Estimated time

Solo, evenings/weekends: phases 0–7 in roughly 2–3 weeks of focused work. Phases 8–10 in another week. Phase 11 is ongoing.
