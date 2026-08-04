import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { BybitClient } from "./exchange/bybit.js";
import type { SignalProcessor } from "./processor/signalProcessor.js";
import { webhookPlugin } from "./routes/webhook.js";
import { apiPlugin } from "./routes/api.js";
import { backtestPlugin } from "./backtest/backtestRoutes.js";
import { env } from "./env.js";

export function buildApp(
  db: PrismaClient,
  logger: boolean | Record<string, unknown> = false,
  processor?: SignalProcessor,
  bybit?: BybitClient,
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

  const allowedOrigins = new Set(env.DASHBOARD_ORIGIN.split(",").map((o) => o.trim()));

  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin ?? "";
    const allowed = allowedOrigins.has(origin) ? origin : env.DASHBOARD_ORIGIN.split(",")[0]!.trim();
    reply.header("Access-Control-Allow-Origin", allowed);
    reply.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    reply.header("Access-Control-Allow-Headers", "Content-Type,Authorization");
    reply.header("Vary", "Origin");
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
  app.register(apiPlugin, { db, bybit });
  app.register(backtestPlugin, { db, bybit });

  return app;
}
