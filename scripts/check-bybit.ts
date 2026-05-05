#!/usr/bin/env tsx
import dotenv from "dotenv";
import { resolve } from "path";

// Load bot's .env BEFORE importing any module that reads process.env via env.ts.
// Dynamic import below ensures env.ts is required after dotenv.config() runs.
dotenv.config({ path: resolve(__dirname, "../apps/bot/.env") });

const SYMBOL = "BTCUSDT";

async function main() {
  const { BybitClient } = await import("../apps/bot/src/exchange/bybit.js");
  const bybit = new BybitClient();

  console.log("=== Bybit Testnet Check ===\n");

  await bybit.checkClockDrift();
  console.log();

  const balance = await bybit.getBalance("USDT");
  console.log("Balance (USDT):");
  console.log(`  Equity:    ${balance.equity.toFixed(2)} USDT`);
  console.log(`  Available: ${balance.available.toFixed(2)} USDT`);
  console.log();

  const positions = await bybit.getPositions(SYMBOL);
  console.log(`Positions (${SYMBOL}):`);
  if (positions.length === 0 || positions.every((p) => p.size === 0)) {
    console.log("  No open positions");
  } else {
    for (const p of positions) {
      if (p.size === 0) continue;
      console.log(`  ${p.side} ${p.size} @ ${p.entryPrice} | PnL: ${p.unrealisedPnl.toFixed(4)} USDT`);
    }
  }
  console.log();

  const info = await bybit.getInstrumentInfo(SYMBOL);
  console.log(`Instrument Info (${SYMBOL}):`);
  console.log(`  Tick Size: ${info.tickSize}`);
  console.log(`  Lot Size:  ${info.lotSize}`);
  console.log(`  Min Qty:   ${info.minQty}`);
  console.log(`  Max Qty:   ${info.maxQty}`);
}

main().catch((err) => {
  console.error("[error]", err.message);
  process.exit(1);
});
