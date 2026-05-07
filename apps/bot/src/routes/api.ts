import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../env.js";

// ── Shared schemas ────────────────────────────────────────────────────────────

const idParam = {
  type: "object",
  properties: { id: { type: "integer", minimum: 1 } },
  required: ["id"],
} as const;

const botListItem = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    symbol: { type: "string" },
    enabled: { type: "boolean" },
    dryRun: { type: "boolean" },
    maxPositionUsd: { type: "number" },
    maxLeverage: { type: "integer" },
    dailyLossLimitUsd: { type: "number" },
    createdAt: { type: "string" },
    openTradeCount: { type: "integer" },
  },
} as const;

const botDetail = {
  type: "object",
  properties: {
    id: { type: "integer" },
    name: { type: "string" },
    symbol: { type: "string" },
    enabled: { type: "boolean" },
    dryRun: { type: "boolean" },
    maxPositionUsd: { type: "number" },
    maxLeverage: { type: "integer" },
    dailyLossLimitUsd: { type: "number" },
    createdAt: { type: "string" },
    signals: { type: "array", items: { type: "object", additionalProperties: true } },
    trades: { type: "array", items: { type: "object", additionalProperties: true } },
  },
} as const;

const tradeItem = {
  type: "object",
  properties: {
    id: { type: "integer" },
    botId: { type: "integer" },
    signalId: { type: "integer" },
    exchangeOrderId: { type: "string" },
    symbol: { type: "string" },
    side: { type: "string" },
    qty: { type: "number" },
    entryPrice: { type: "number" },
    exitPrice: { type: ["number", "null"] },
    pnlUsd: { type: ["number", "null"] },
    status: { type: "string" },
    openedAt: { type: "string" },
    closedAt: { type: ["string", "null"] },
  },
} as const;

const equityItem = {
  type: "object",
  properties: {
    id: { type: "integer" },
    equityUsd: { type: "number" },
    availableUsd: { type: "number" },
    takenAt: { type: "string" },
  },
} as const;

const errorSchema = {
  type: "object",
  properties: {
    error: { type: "string" },
  },
} as const;

// ── Typed param/query shapes ──────────────────────────────────────────────────

interface IdParams { id: number }

interface PatchBotBody {
  enabled?: boolean;
  dryRun?: boolean;
  maxPositionUsd?: number;
  maxLeverage?: number;
}

interface TradesQuery {
  botId?: number;
  limit: number;
  from?: string;
  to?: string;
}

interface EquityQuery {
  from?: string;
  to?: string;
}

// ── Plugin ────────────────────────────────────────────────────────────────────

function isPrismaNotFound(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "P2025"
  );
}

export const apiPlugin: FastifyPluginAsync<{ db: PrismaClient }> = async (fastify, { db }) => {
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

  // GET /api/bots
  fastify.get("/api/bots", {
    schema: {
      response: { 200: { type: "array", items: botListItem } },
    },
  }, async () => {
    const bots = await db.bot.findMany({
      include: { _count: { select: { trades: { where: { status: "OPEN" } } } } },
      orderBy: { id: "asc" },
    });
    return bots.map((b) => ({
      id: b.id,
      name: b.name,
      symbol: b.symbol,
      enabled: b.enabled,
      dryRun: b.dryRun,
      maxPositionUsd: b.maxPositionUsd,
      maxLeverage: b.maxLeverage,
      dailyLossLimitUsd: b.dailyLossLimitUsd,
      createdAt: b.createdAt.toISOString(),
      openTradeCount: b._count.trades,
    }));
  });

  // GET /api/bots/:id
  fastify.get<{ Params: IdParams }>("/api/bots/:id", {
    schema: {
      params: idParam,
      response: { 200: botDetail, 404: errorSchema },
    },
  }, async (req, reply) => {
    const bot = await db.bot.findUnique({
      where: { id: req.params.id },
      include: {
        signals: { orderBy: { receivedAt: "desc" }, take: 20 },
        trades: { orderBy: { openedAt: "desc" }, take: 20 },
      },
    });
    if (!bot) return reply.status(404).send({ error: "Not found" });
    return {
      ...bot,
      createdAt: bot.createdAt.toISOString(),
      signals: bot.signals.map((s) => ({ ...s, receivedAt: s.receivedAt.toISOString(), processedAt: s.processedAt?.toISOString() ?? null })),
      trades: bot.trades.map((t) => ({ ...t, openedAt: t.openedAt.toISOString(), closedAt: t.closedAt?.toISOString() ?? null })),
    };
  });

  // PATCH /api/bots/:id
  fastify.patch<{ Params: IdParams; Body: PatchBotBody }>("/api/bots/:id", {
    schema: {
      params: idParam,
      body: {
        type: "object",
        properties: {
          enabled: { type: "boolean" },
          dryRun: { type: "boolean" },
          maxPositionUsd: { type: "number", exclusiveMinimum: 0 },
          maxLeverage: { type: "integer", minimum: 1 },
        },
        additionalProperties: false,
        minProperties: 1,
      },
      response: { 200: botDetail, 404: errorSchema },
    },
  }, async (req, reply) => {
    try {
      const bot = await db.bot.update({ where: { id: req.params.id }, data: req.body });
      return { ...bot, createdAt: bot.createdAt.toISOString(), signals: [], trades: [] };
    } catch (err) {
      if (isPrismaNotFound(err)) return reply.status(404).send({ error: "Not found" });
      throw err;
    }
  });

  // GET /api/trades
  fastify.get<{ Querystring: TradesQuery }>("/api/trades", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          botId: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
          from: { type: "string" },
          to: { type: "string" },
        },
      },
      response: { 200: { type: "array", items: tradeItem } },
    },
  }, async (req) => {
    const { botId, limit, from, to } = req.query;
    const trades = await db.trade.findMany({
      where: {
        ...(botId !== undefined ? { botId } : {}),
        ...(from || to ? { openedAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
      },
      orderBy: { openedAt: "desc" },
      take: limit,
    });
    return trades.map((t) => ({
      ...t,
      openedAt: t.openedAt.toISOString(),
      closedAt: t.closedAt?.toISOString() ?? null,
    }));
  });

  // GET /api/equity
  fastify.get<{ Querystring: EquityQuery }>("/api/equity", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
      },
      response: { 200: { type: "array", items: equityItem } },
    },
  }, async (req) => {
    const { from, to } = req.query;
    const snapshots = await db.balanceSnapshot.findMany({
      where: {
        ...(from || to ? { takenAt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
      },
      orderBy: { takenAt: "asc" },
    });
    return snapshots.map((s) => ({ ...s, takenAt: s.takenAt.toISOString() }));
  });

  // POST /api/kill-switch
  fastify.post("/api/kill-switch", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: { disabled: { type: "integer" } },
          required: ["disabled"],
        },
      },
    },
  }, async () => {
    const result = await db.bot.updateMany({ where: { enabled: true }, data: { enabled: false } });
    return { disabled: result.count };
  });
};
