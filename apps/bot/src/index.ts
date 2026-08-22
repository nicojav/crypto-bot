import { buildApp } from "./app.js";
import { prisma } from "./db.js";
import { env } from "./env.js";
import { BybitClient } from "./exchange/bybit.js";
import { EventBus } from "./eventBus.js";
import { Notifier } from "./notifications/notifier.js";
import { SignalProcessor } from "./processor/signalProcessor.js";
import { Reconciler } from "./reconciliation/reconciler.js";
import { attachWebSocketServer } from "./ws.js";
import { healOrphanedRuns } from "./backtest/optimizationRunner.js";
import { StorageMonitor } from "./storage/storageMonitor.js";
import { resolveDbFilePath } from "./storage/dbStats.js";

const bus = new EventBus();
const bybit = new BybitClient();
const processor = new SignalProcessor(prisma, bybit, bus);
const reconciler = new Reconciler(prisma, bybit, bus);
const notifier = new Notifier(bus, prisma);
const storageMonitor = new StorageMonitor(
  prisma,
  bus,
  resolveDbFilePath(env.DATABASE_URL),
  env.DB_VOLUME_SIZE_BYTES,
  env.DB_CRITICAL_THRESHOLD_PCT,
);

const app = buildApp(prisma, { level: env.LOG_LEVEL }, processor, bybit);

app.addHook("onReady", async () => {
  reconciler.start().catch((err: unknown) => app.log.error({ err }, "reconciler failed to start"));
  notifier.start();
  storageMonitor.start();
  healOrphanedRuns(prisma)
    .then((count) => { if (count > 0) app.log.warn({ count }, "marked orphaned optimization runs as interrupted"); })
    .catch((err: unknown) => app.log.error({ err }, "failed to heal orphaned optimization runs"));
});

app.addHook("onClose", async () => {
  reconciler.stop();
  notifier.stop();
  storageMonitor.stop();
});

app.listen({ port: env.PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  attachWebSocketServer(app.server, bus);
  app.log.info(`ready on :${env.PORT}`);
});

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT",  () => void shutdown("SIGINT"));
