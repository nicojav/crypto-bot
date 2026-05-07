import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { SignalProcessor } from "./processor/signalProcessor.js";
import { webhookPlugin } from "./routes/webhook.js";
import { apiPlugin } from "./routes/api.js";
import { env } from "./env.js";

export function buildApp(
  db: PrismaClient,
  logger: boolean | Record<string, unknown> = false,
  processor?: SignalProcessor,
) {
  const app = Fastify({
    logger,
    genReqId: () => randomUUID(),
    ajv: {
      customOptions: {
        removeAdditional: false, // reject unknown fields rather than silently stripping them
        useDefaults: true,
        coerceTypes: "array",
      },
    },
  });

  app.addHook("onRequest", async (req, reply) => {
    reply.header("Access-Control-Allow-Origin", env.DASHBOARD_ORIGIN);
    reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    if (req.method === "OPTIONS") {
      return reply.status(204).send();
    }
  });

  if (processor) {
    app.addHook("onReady", async () => { processor.start(); });
    app.addHook("onClose", async () => { processor.stop(); });
  }

  app.get("/health", async () => ({ status: "ok" }));
  app.register(webhookPlugin, { db });
  app.register(apiPlugin, { db });

  return app;
}
