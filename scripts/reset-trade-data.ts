#!/usr/bin/env tsx
/**
 * Reset Signals and Trades for a clean strategy-testing slate.
 * Calls the bot's HTTP endpoint — no DB access needed, works from anywhere.
 * Preserves Bot configs and BalanceSnapshots.
 *
 * Requires in apps/bot/.env:
 *   BOT_URL=https://your-service.up.railway.app
 *   API_TOKEN=your-token
 *
 * Usage:
 *   npm run reset-trade-data              # dry-run (shows counts)
 *   npm run reset-trade-data -- --confirm # actually delete
 */
import dotenv from "dotenv";
import { resolve } from "path";

// Production vars (BOT_URL + API_TOKEN for the deployed service)
dotenv.config({ path: resolve(__dirname, "../apps/bot/.env.production") });

async function main() {
  const botUrl = process.env.BOT_URL?.replace(/\/$/, "");
  const apiToken = process.env.API_TOKEN;

  if (!botUrl) {
    console.error("Missing BOT_URL in apps/bot/.env (e.g. https://your-service.up.railway.app)");
    process.exit(1);
  }
  if (!apiToken) {
    console.error("Missing API_TOKEN in apps/bot/.env");
    process.exit(1);
  }

  const confirm = process.argv.includes("--confirm");
  const url = `${botUrl}/api/reset-trade-data${confirm ? "?confirm=true" : ""}`;

  console.log("=== Reset Trade Data ===");
  console.log(`Target: ${botUrl}`);
  console.log(`Mode:   ${confirm ? "CONFIRM — will delete" : "DRY RUN — no changes"}`);
  console.log();

  const res = await fetch(url, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!res.ok) {
    const body = await res.text();
    console.error(`HTTP ${res.status}: ${body}`);
    process.exit(1);
  }

  const data = await res.json() as { dryRun: boolean; trades: number; signals: number };

  if (data.dryRun) {
    console.log(`Would delete:`);
    console.log(`  Trades:  ${data.trades}`);
    console.log(`  Signals: ${data.signals}`);
    console.log();
    console.log("Re-run with --confirm to delete.");
  } else {
    console.log(`Deleted:`);
    console.log(`  Trades:  ${data.trades}`);
    console.log(`  Signals: ${data.signals}`);
    console.log();
    console.log("Done. Clean slate.");
  }
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
