import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { SignalProcessor } from "./processor/signalProcessor.js";
import { webhookPlugin } from "./routes/webhook.js";

export function buildApp(
  db: PrismaClient,
  logger: boolean | Record<string, unknown> = false,
  processor?: SignalProcessor,
) {
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
  });

  if (processor) {
    app.addHook("onReady", async () => { processor.start(); });
    app.addHook("onClose", async () => { processor.stop(); });
  }

  app.get("/health", async () => ({ status: "ok" }));
  app.register(webhookPlugin, { db });

  return app;
}
