import type { FastifyPluginAsync } from "fastify";

import type { PrismaClient } from "../generated/prisma/client.js";
import type { TimeframeId } from "../exchange/bybit.js";
import { env } from "../env.js";
import { getStorageStats, countPrunableRows, pruneOldRows, resolveDbFilePath } from "./dbStats.js";

const TIMEFRAMES = ["5m", "15m", "4h", "1d", "1w"] as const;

const tableStatsSchema = {
  type: "object",
  properties: {
    rowCount: { type: "integer" },
    oldest: { type: ["integer", "null"] },
    newest: { type: ["integer", "null"] },
  },
  required: ["rowCount", "oldest", "newest"],
} as const;

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
} as const;

interface PruneQuery {
  confirm?: string;
  olderThanDays: number;
  symbol?: string;
  timeframe?: (typeof TIMEFRAMES)[number];
}

/**
 * Storage visibility + manual prune for the backtest candle/funding-rate cache — the only tables
 * on the shared 1 GB SQLite volume that grow unbounded (see storage/storageMonitor.ts for the
 * periodic critical-threshold alert). Same plugin-scoped auth/error-handling shape as
 * backtest/backtestRoutes.ts.
 */
export const storagePlugin: FastifyPluginAsync<{ db: PrismaClient }> = async (fastify, { db }) => {
  fastify.setErrorHandler((err, _req, reply) => {
    if (err.validation) {
      return reply.status(400).send({ error: "Validation error", details: err.validation });
    }
    const status = err.statusCode ?? 500;
    return reply.status(status).send({ error: err.message ?? "Internal error" });
  });

  fastify.addHook("onRequest", async (req, reply) => {
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.API_TOKEN) {
      return reply.status(401).send({ error: "Unauthorized" });
    }
  });

  // GET /api/storage/stats
  fastify.get("/api/storage/stats", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            dbSizeBytes: { type: "integer" },
            volumeSizeBytes: { type: "integer" },
            percentUsed: { type: "number" },
            criticalThresholdPct: { type: "number" },
            candles: tableStatsSchema,
            fundingRates: tableStatsSchema,
          },
          required: ["dbSizeBytes", "volumeSizeBytes", "percentUsed", "criticalThresholdPct", "candles", "fundingRates"],
        },
      },
    },
  }, async () => {
    const dbFilePath = resolveDbFilePath(env.DATABASE_URL);
    return getStorageStats(db, dbFilePath, env.DB_VOLUME_SIZE_BYTES, env.DB_CRITICAL_THRESHOLD_PCT);
  });

  // DELETE /api/storage/candles?olderThanDays=N[&symbol=...][&timeframe=...][&confirm=true]
  // Omit confirm=true for a dry-run (returns counts only, deletes nothing) — same shape as the
  // existing DELETE /api/reset-trade-data. Prunes both Candle and FundingRate older than the
  // cutoff (funding has no timeframe dimension, so `timeframe` only narrows candle deletion).
  fastify.delete<{ Querystring: PruneQuery }>("/api/storage/candles", {
    schema: {
      querystring: {
        type: "object",
        required: ["olderThanDays"],
        properties: {
          confirm: { type: "string" },
          olderThanDays: { type: "integer", exclusiveMinimum: 0 },
          symbol: { type: "string", minLength: 1 },
          timeframe: { type: "string", enum: TIMEFRAMES },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
            candles: { type: "integer" },
            fundingRates: { type: "integer" },
          },
          required: ["dryRun", "candles", "fundingRates"],
        },
        400: errorSchema,
      },
    },
  }, async (req) => {
    const cutoffMs = Date.now() - req.query.olderThanDays * 24 * 60 * 60 * 1000;
    const scope = { symbol: req.query.symbol, timeframe: req.query.timeframe as TimeframeId | undefined };

    if (req.query.confirm !== "true") {
      const counts = await countPrunableRows(db, cutoffMs, scope);
      return { dryRun: true, ...counts };
    }

    const deleted = await pruneOldRows(db, cutoffMs, scope);
    return { dryRun: false, ...deleted };
  });
};
