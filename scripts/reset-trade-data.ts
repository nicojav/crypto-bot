#!/usr/bin/env tsx
/**
 * Reset Signals and Trades for a clean strategy-testing slate.
 * Calls the bot's HTTP endpoint — no DB access needed, works from anywhere.
 * Preserves Bot configs.
 *
 * Requires in apps/bot/.env.production:
 *   BOT_URL=https://your-service.up.railway.app
 *   API_TOKEN=your-token
 *
 * Usage:
 *   npm run reset-trade-data                       # dry-run (shows counts)
 *   npm run reset-trade-data -- --confirm          # delete trades + signals
 *   npm run reset-trade-data -- --confirm --full   # delete everything incl. snapshots + funding
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
  const full    = process.argv.includes("--full");
  const params  = new URLSearchParams();
  if (confirm) params.set("confirm", "true");
  if (full)    params.set("full", "true");
  const url = `${botUrl}/api/reset-trade-data?${params.toString()}`;

  console.log("=== Reset Trade Data ===");
  console.log(`Target: ${botUrl}`);
  console.log(`Mode:   ${confirm ? "CONFIRM — will delete" : "DRY RUN — no changes"}`);
  console.log(`Scope:  ${full ? "FULL (trades + signals + snapshots + funding)" : "trades + signals only"}`);
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

  const data = await res.json() as { dryRun: boolean; trades: number; signals: number; snapshots: number; fundingEvents: number };

  const label = data.dryRun ? "Would delete:" : "Deleted:";
  console.log(label);
  console.log(`  Trades:        ${data.trades}`);
  console.log(`  Signals:       ${data.signals}`);
  if (data.snapshots > 0 || full) console.log(`  Snapshots:     ${data.snapshots}`);
  if (data.fundingEvents > 0 || full) console.log(`  FundingEvents: ${data.fundingEvents}`);
  console.log();
  if (data.dryRun) {
    console.log(`Re-run with --confirm${full ? " --full" : ""} to delete.`);
  } else {
    console.log("Done. Clean slate.");
  }
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
