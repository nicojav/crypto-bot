import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/prisma/client.js";
import { webhookPlugin } from "./routes/webhook.js";

export function buildApp(
  db: PrismaClient,
  logger: boolean | Record<string, unknown> = false
) {
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
  });

  app.get("/health", async () => ({ status: "ok" }));
  app.register(webhookPlugin, { db });

  return app;
}
