import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { BybitClient } from "./exchange/bybit.js";
import { SignalProcessor } from "./processor/signalProcessor.js";
import { Reconciler } from "./reconciliation/reconciler.js";

const bybit = new BybitClient();
const processor = new SignalProcessor(prisma, bybit);
const reconciler = new Reconciler(prisma, bybit);

const app = buildApp(prisma, { level: env.LOG_LEVEL }, processor);

app.addHook("onReady", async () => {
  reconciler.start().catch((err: unknown) => app.log.error({ err }, "reconciler failed to start"));
});

app.addHook("onClose", async () => {
  reconciler.stop();
});

app.listen({ port: env.PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`ready on :${env.PORT}`);
});
