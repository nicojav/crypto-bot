import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { BybitClient } from "../exchange/bybit.js";
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
    entryFillPrice: { type: ["number", "null"] },
    exitPrice: { type: ["number", "null"] },
    exitFillPrice: { type: ["number", "null"] },
    pnlUsd: { type: ["number", "null"] },
    realizedPnlUsd: { type: ["number", "null"] },
    feeOpenUsd: { type: ["number", "null"] },
    feeCloseUsd: { type: ["number", "null"] },
    pnlSource: { type: ["string", "null"] },
    status: { type: "string" },
    openedAt: { type: "string" },
    closedAt: { type: ["string", "null"] },
  },
} as const;

const positionItem = {
  type: "object",
  properties: {
    tradeId: { type: "integer" },
    botId: { type: "integer" },
    symbol: { type: "string" },
    side: { type: "string" },
    qty: { type: "number" },
    entryPrice: { type: "number" },
    entryFillPrice: { type: ["number", "null"] },
    markPrice: { type: ["number", "null"] },
    unrealisedPnl: { type: ["number", "null"] },
    feeOpenUsd: { type: ["number", "null"] },
    status: { type: "string" },
    openedAt: { type: "string" },
  },
} as const;

const equitySummarySchema = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    deltaEquityUsd: { type: "number" },
    sumRealizedPnlUsd: { type: "number" },
    sumFeeUsd: { type: "number" },
    sumFundingUsd: { type: "number" },
    residualUsd: { type: "number" },
    tradeCount: { type: "integer" },
    unaccountedTradeCount: { type: "integer" },
  },
  required: ["from", "to", "deltaEquityUsd", "sumRealizedPnlUsd", "sumFeeUsd", "sumFundingUsd", "residualUsd", "tradeCount", "unaccountedTradeCount"],
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

const signalItem = {
  type: "object",
  properties: {
    id: { type: "integer" },
    botId: { type: "integer" },
    action: { type: "string" },
    symbol: { type: "string" },
    status: { type: "string" },
    receivedAt: { type: "string" },
    processedAt: { type: ["string", "null"] },
    rejectionReason: { type: ["string", "null"] },
    isTest: { type: "boolean" },
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

interface CreateBotBody {
  name: string;
  symbol: string;
  enabled?: boolean;
  dryRun?: boolean;
  maxPositionUsd?: number;
  maxLeverage?: number;
  dailyLossLimitUsd?: number;
}

interface PatchBotBody {
  name?: string;
  symbol?: string;
  enabled?: boolean;
  dryRun?: boolean;
  maxPositionUsd?: number;
  maxLeverage?: number;
  dailyLossLimitUsd?: number;
}

interface TradesQuery {
  botId?: number;
  limit: number;
  from?: string;
  to?: string;
}

interface SignalsQuery {
  botId?: number;
  limit: number;
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

// 5s in-memory cache for live Bybit positions (symbol → { data, expiresAt })
const positionCache = new Map<string, { unrealisedPnl: number; markPrice: number; expiresAt: number }>();

export const apiPlugin: FastifyPluginAsync<{ db: PrismaClient; bybit?: BybitClient }> = async (fastify, { db, bybit }) => {
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

  // POST /api/bots
  fastify.post<{ Body: CreateBotBody }>("/api/bots", {
    schema: {
      body: {
        type: "object",
        required: ["name", "symbol"],
        additionalProperties: false,
        properties: {
          name:              { type: "string", minLength: 1 },
          symbol:            { type: "string", minLength: 1 },
          enabled:           { type: "boolean" },
          dryRun:            { type: "boolean" },
          maxPositionUsd:    { type: "number", exclusiveMinimum: 0 },
          maxLeverage:       { type: "integer", minimum: 1 },
          dailyLossLimitUsd: { type: "number" },
        },
      },
      response: { 201: botListItem },
    },
  }, async (req, reply) => {
    const bot = await db.bot.create({ data: req.body });
    return reply.status(201).send({
      id: bot.id,
      name: bot.name,
      symbol: bot.symbol,
      enabled: bot.enabled,
      dryRun: bot.dryRun,
      maxPositionUsd: bot.maxPositionUsd,
      maxLeverage: bot.maxLeverage,
      dailyLossLimitUsd: bot.dailyLossLimitUsd,
      createdAt: bot.createdAt.toISOString(),
      openTradeCount: 0,
    });
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
          name:              { type: "string", minLength: 1 },
          symbol:            { type: "string", minLength: 1 },
          enabled:           { type: "boolean" },
          dryRun:            { type: "boolean" },
          maxPositionUsd:    { type: "number", exclusiveMinimum: 0 },
          maxLeverage:       { type: "integer", minimum: 1 },
          dailyLossLimitUsd: { type: "number" },
        },
        additionalProperties: false,
        minProperties: 1,
      },
      response: { 200: botDetail, 404: errorSchema },
    },
  }, async (req, reply) => {
    // Guard: reject symbol changes while the bot has open or closing positions
    if (req.body.symbol !== undefined) {
      const current = await db.bot.findUnique({ where: { id: req.params.id } });
      if (!current) return reply.status(404).send({ error: "Not found" });
      if (req.body.symbol.toUpperCase() !== current.symbol) {
        const openCount = await db.trade.count({
          where: { botId: req.params.id, status: { in: ["OPEN", "CLOSING"] } },
        });
        if (openCount > 0) {
          return reply.status(409).send({ error: "Cannot change symbol while positions are open" });
        }
      }
      // Normalise to uppercase regardless
      req.body.symbol = req.body.symbol.toUpperCase();
    }

    try {
      const bot = await db.bot.update({ where: { id: req.params.id }, data: req.body });
      return { ...bot, createdAt: bot.createdAt.toISOString(), signals: [], trades: [] };
    } catch (err) {
      if (isPrismaNotFound(err)) return reply.status(404).send({ error: "Not found" });
      throw err;
    }
  });

  // GET /api/signals
  fastify.get<{ Querystring: SignalsQuery }>("/api/signals", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          botId: { type: "integer", minimum: 1 },
          limit: { type: "integer", minimum: 1, maximum: 500, default: 50 },
        },
      },
      response: { 200: { type: "array", items: signalItem } },
    },
  }, async (req) => {
    const { botId, limit } = req.query;
    const signals = await db.signal.findMany({
      where: botId !== undefined ? { botId } : {},
      include: { bot: { select: { symbol: true } } },
      orderBy: { receivedAt: "desc" },
      take: limit,
    });
    return signals.map((s) => {
      const parsedPayload = (() => { try { return JSON.parse(s.payload ?? "{}"); } catch { return {}; } })();
      return {
        id: s.id,
        botId: s.botId,
        action: s.action,
        symbol: s.bot.symbol,
        status: s.status,
        receivedAt: s.receivedAt.toISOString(),
        processedAt: s.processedAt?.toISOString() ?? null,
        rejectionReason: s.rejectionReason ?? null,
        isTest: parsedPayload?.meta?._test === true,
      };
    });
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
      // Use real Bybit PnL when available; fall back to legacy local estimate
      pnlUsd: t.realizedPnlUsd ?? t.pnlUsd ?? null,
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

  // GET /api/equity/summary?from&to
  // Returns a decomposition of Δequity into realized PnL, fees, and residual.
  fastify.get<{ Querystring: EquityQuery }>("/api/equity/summary", {
    schema: {
      querystring: {
        type: "object",
        properties: {
          from: { type: "string" },
          to: { type: "string" },
        },
      },
      response: { 200: equitySummarySchema },
    },
  }, async (req) => {
    const fromDate = req.query.from ? new Date(req.query.from) : new Date(new Date().setHours(0, 0, 0, 0));
    const toDate = req.query.to ? new Date(req.query.to) : new Date();

    const [snapshots, trades, fundingAgg, unaccountedTradeCount] = await Promise.all([
      db.balanceSnapshot.findMany({
        where: { takenAt: { gte: fromDate, lte: toDate } },
        orderBy: { takenAt: "asc" },
      }),
      db.trade.findMany({
        where: {
          status: "CLOSED",
          closedAt: { gte: fromDate, lte: toDate },
        },
      }),
      db.fundingEvent.aggregate({
        _sum: { fundingUsd: true },
        where: { execTime: { gte: fromDate, lte: toDate } },
      }),
      db.trade.count({
        where: {
          status: "CLOSED",
          closedAt: { gte: fromDate, lte: toDate },
          realizedPnlUsd: null,
          pnlUsd: null,
        },
      }),
    ]);

    const firstSnap = snapshots[0];
    const lastSnap = snapshots[snapshots.length - 1];
    const deltaEquityUsd = firstSnap && lastSnap ? lastSnap.equityUsd - firstSnap.equityUsd : 0;

    let sumRealizedPnlUsd = 0;
    let sumFeeUsd = 0;
    for (const t of trades) {
      sumRealizedPnlUsd += t.realizedPnlUsd ?? t.pnlUsd ?? 0;
      sumFeeUsd += (t.feeOpenUsd ?? 0) + (t.feeCloseUsd ?? 0);
    }

    const sumFundingUsd = fundingAgg._sum.fundingUsd ?? 0;

    // residual ≈ Δequity − (realized − fees + funding) ≈ unrealizedPnl change + rounding
    const residualUsd = deltaEquityUsd - (sumRealizedPnlUsd - sumFeeUsd + sumFundingUsd);

    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      deltaEquityUsd,
      sumRealizedPnlUsd,
      sumFeeUsd,
      sumFundingUsd,
      residualUsd,
      tradeCount: trades.length,
      unaccountedTradeCount,
    };
  });

  // GET /api/positions
  // Returns all OPEN/CLOSING trades joined with live Bybit unrealized PnL.
  fastify.get("/api/positions", {
    schema: {
      response: { 200: { type: "array", items: positionItem } },
    },
  }, async () => {
    const openTrades = await db.trade.findMany({
      where: { status: { in: ["OPEN", "CLOSING"] } },
      orderBy: { openedAt: "desc" },
    });

    const symbols = [...new Set(openTrades.map((t) => t.symbol))];
    const liveBySymbol = new Map<string, { unrealisedPnl: number; markPrice: number }>();

    if (bybit) {
      await Promise.all(
        symbols.map(async (sym) => {
          const cached = positionCache.get(sym);
          if (cached && cached.expiresAt > Date.now()) {
            liveBySymbol.set(sym, { unrealisedPnl: cached.unrealisedPnl, markPrice: cached.markPrice });
            return;
          }
          try {
            const positions = await bybit.getPositions(sym);
            const pos = positions.find((p) => p.size > 0);
            const entry = { unrealisedPnl: pos?.unrealisedPnl ?? 0, markPrice: pos?.markPrice ?? 0 };
            liveBySymbol.set(sym, entry);
            positionCache.set(sym, { ...entry, expiresAt: Date.now() + 5_000 });
          } catch {
            // non-fatal: return without live data
          }
        })
      );
    }

    return openTrades.map((t) => {
      const live = liveBySymbol.get(t.symbol);
      return {
        tradeId: t.id,
        botId: t.botId,
        symbol: t.symbol,
        side: t.side,
        qty: t.qty,
        entryPrice: t.entryPrice,
        entryFillPrice: t.entryFillPrice ?? null,
        markPrice: live?.markPrice ?? null,
        unrealisedPnl: live?.unrealisedPnl ?? null,
        feeOpenUsd: t.feeOpenUsd ?? null,
        status: t.status,
        openedAt: t.openedAt.toISOString(),
      };
    });
  });

  // DELETE /api/reset-trade-data?confirm=true
  // Wipes all Signals and Trades. Preserves Bots and BalanceSnapshots.
  // Omit ?confirm=true for a dry-run (returns counts only, deletes nothing).
  fastify.delete<{ Querystring: { confirm?: string } }>("/api/reset-trade-data", {
    schema: {
      querystring: {
        type: "object",
        properties: { confirm: { type: "string" } },
      },
      response: {
        200: {
          type: "object",
          properties: {
            dryRun: { type: "boolean" },
            trades: { type: "integer" },
            signals: { type: "integer" },
          },
          required: ["dryRun", "trades", "signals"],
        },
      },
    },
  }, async (req) => {
    const [trades, signals] = await Promise.all([
      db.trade.count(),
      db.signal.count(),
    ]);

    if (req.query.confirm !== "true") {
      return { dryRun: true, trades, signals };
    }

    await db.$transaction([
      db.trade.deleteMany({}),
      db.signal.deleteMany({}),
    ]);

    return { dryRun: false, trades, signals };
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

  // GET /api/reconcile
  // Compares live Bybit positions against DB OPEN/CLOSING trades and returns orphans in both directions.
  // Read-only diagnostic — use POST /api/reconcile/close to flatten an orphaned exchange position.
  fastify.get("/api/reconcile", {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            orphanedOnExchange: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  symbol: { type: "string" },
                  side: { type: "string" },
                  size: { type: "number" },
                  entryPrice: { type: "number" },
                },
                required: ["symbol", "side", "size", "entryPrice"],
              },
            },
            orphanedInDb: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  tradeId: { type: "integer" },
                  symbol: { type: "string" },
                  side: { type: "string" },
                  status: { type: "string" },
                },
                required: ["tradeId", "symbol", "side", "status"],
              },
            },
          },
          required: ["orphanedOnExchange", "orphanedInDb"],
        },
      },
    },
  }, async () => {
    if (!bybit) return { orphanedOnExchange: [], orphanedInDb: [] };

    const [livePositions, dbTrades] = await Promise.all([
      bybit.getAllPositions(),
      db.trade.findMany({ where: { status: { in: ["OPEN", "CLOSING"] } } }),
    ]);

    // Positions on exchange but no matching OPEN/CLOSING trade in DB
    const orphanedOnExchange = livePositions.filter(
      (p) => !dbTrades.some(
        (t) => t.symbol === p.symbol && t.side === (p.side === "Buy" ? "BUY" : "SELL")
      )
    );

    // DB OPEN/CLOSING trades with no matching live exchange position
    const orphanedInDb = dbTrades.filter(
      (t) => !livePositions.some(
        (p) => p.symbol === t.symbol && (p.side === "Buy" ? "BUY" : "SELL") === t.side
      )
    );

    return {
      orphanedOnExchange: orphanedOnExchange.map((p) => ({
        symbol: p.symbol,
        side: p.side,
        size: p.size,
        entryPrice: p.entryPrice,
      })),
      orphanedInDb: orphanedInDb.map((t) => ({
        tradeId: t.id,
        symbol: t.symbol,
        side: t.side,
        status: t.status,
      })),
    };
  });

  // POST /api/reconcile/close?symbol=XRPUSDT
  // Flattens an orphaned exchange position for the given symbol via a reduce-only market order.
  fastify.post<{ Querystring: { symbol: string } }>("/api/reconcile/close", {
    schema: {
      querystring: {
        type: "object",
        properties: { symbol: { type: "string" } },
        required: ["symbol"],
      },
      response: {
        200: {
          type: "object",
          properties: {
            orderId: { type: "string" },
            symbol: { type: "string" },
            side: { type: "string" },
            qty: { type: "number" },
          },
          required: ["orderId", "symbol", "side", "qty"],
        },
      },
    },
  }, async (req, reply) => {
    if (!bybit) return reply.status(503).send({ error: "Exchange client not available" });

    const { symbol } = req.query;
    const positions = await bybit.getPositions(symbol);
    const pos = positions.find((p) => p.size > 0);

    if (!pos) {
      return reply.status(404).send({ error: `No open position found for ${symbol} on exchange` });
    }

    const closeSide = pos.side === "Buy" ? "Sell" as const : "Buy" as const;
    const orderId = await bybit.placeMarketOrder({ symbol, side: closeSide, qty: pos.size, reduceOnly: true });

    return { orderId, symbol, side: closeSide, qty: pos.size };
  });

  // POST /api/bots/:id/test-signal
  // Inserts a PENDING Signal directly (bypasses webhook secret check).
  // The SignalProcessor picks it up within 500ms exactly as a real TradingView alert.
  // Use simulateTpSlError=true to place extreme TP/SL offsets that trigger Bybit's price-band
  // check (30208/10001), verifying the naked-entry fallback works. No-op in dryRun mode
  // (dryRun never calls Bybit, so the band error never fires).
  fastify.post<{ Params: IdParams; Body: { action: "BUY" | "SELL"; simulateTpSlError?: boolean } }>(
    "/api/bots/:id/test-signal",
    {
      schema: {
        params: idParam,
        body: {
          type: "object",
          required: ["action"],
          additionalProperties: false,
          properties: {
            action:            { type: "string", enum: ["BUY", "SELL"] },
            simulateTpSlError: { type: "boolean" },
          },
        },
        response: {
          201: {
            type: "object",
            properties: { signalId: { type: "integer" }, webhookId: { type: "string" } },
            required: ["signalId", "webhookId"],
          },
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const { action, simulateTpSlError = false } = req.body;

      const bot = await db.bot.findUnique({ where: { id } });
      if (!bot) return reply.status(404).send({ error: "Not found" });

      // refPrice=1.0 so the processor's re-anchoring (markPrice + (tp - ref)) produces
      // tp = markPrice ± 1.0 — well outside Bybit's ~6% price band → triggers 30208/10001.
      const refPrice = 1.0;
      const payload: Record<string, unknown> = {
        symbol: bot.symbol,
        price: refPrice,
        meta: { _test: true },  // surfaced as isTest in the dashboard
      };
      if (simulateTpSlError) {
        payload.takeProfit = action === "BUY" ? refPrice + 1.0 : refPrice * 0.5;
        payload.stopLoss   = action === "BUY" ? refPrice * 0.5 : refPrice + 1.0;
      }

      const webhookId = `test-${Date.now()}-${action.toLowerCase()}`;
      const signal = await db.signal.create({
        data: { botId: id, webhookId, action, payload: JSON.stringify(payload), status: "PENDING" },
      });

      return reply.status(201).send({ signalId: signal.id, webhookId });
    },
  );
};
