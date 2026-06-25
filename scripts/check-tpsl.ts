#!/usr/bin/env tsx
import dotenv from "dotenv";
import { resolve } from "path";
import { RestClientV5 } from "bybit-api";

dotenv.config({ path: resolve(__dirname, "../apps/bot/.env") });

const SYMBOL = process.argv[2] ?? "XRPUSDT";

async function main() {
  const c = new RestClientV5({
    key: process.env.BYBIT_API_KEY,
    secret: process.env.BYBIT_API_SECRET,
    testnet: process.env.BYBIT_TESTNET === "true",
  });

  const pos = await c.getPositionInfo({ category: "linear", symbol: SYMBOL });
  console.log(`\n=== Position TP/SL (${SYMBOL}) ===`);
  for (const p of pos.result.list) {
    console.log(`  side=${p.side} size=${p.size} tp=${p.takeProfit || "(empty)"} sl=${p.stopLoss || "(empty)"}`);
  }

  const ord = await c.getHistoricOrders({ category: "linear", symbol: SYMBOL, limit: 5 });
  console.log(`\n=== Last 5 orders (${SYMBOL}) ===`);
  for (const o of ord.result.list) {
    console.log(`  ${o.orderId.slice(0, 8)} ${o.side} cumExec=${o.cumExecQty}/${o.qty} status=${o.orderStatus} tp=${o.takeProfit || "(empty)"} sl=${o.stopLoss || "(empty)"}`);
  }
}

main().catch((err) => {
  console.error("[error]", err.message);
  process.exit(1);
});
