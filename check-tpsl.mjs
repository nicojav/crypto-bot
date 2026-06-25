import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { RestClientV5 } from "bybit-api";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "apps/bot/.env") });

const c = new RestClientV5({
  key: process.env.BYBIT_API_KEY,
  secret: process.env.BYBIT_API_SECRET,
  testnet: process.env.BYBIT_TESTNET === "true",
});

const pos = await c.getPositionInfo({ category: "linear", symbol: "XRPUSDT" });
console.log("\n=== Position TP/SL ===");
for (const p of pos.result.list) {
  console.log(`  side=${p.side} size=${p.size} tp=${p.takeProfit || "(empty)"} sl=${p.stopLoss || "(empty)"}`);
}

const ord = await c.getHistoricOrders({ category: "linear", symbol: "XRPUSDT", limit: 5 });
console.log("\n=== Last 5 orders ===");
for (const o of ord.result.list) {
  console.log(`  ${o.orderId.slice(0, 8)} ${o.side} cumExec=${o.cumExecQty}/${o.qty} status=${o.orderStatus} tp=${o.takeProfit || "(empty)"} sl=${o.stopLoss || "(empty)"}`);
}
