import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { BybitClient, TimeframeId } from "../exchange/bybit.js";
import { env } from "../env.js";
import { ensureCandles } from "./candleStore.js";
import { listStrategies, getStrategy } from "./strategies/index.js";
import { runBacktestEngine, type EquityPoint } from "./engine.js";
import { computeStats } from "./stats.js";
import type { Candle } from "./types.js";

const TIMEFRAMES = ["5m", "15m", "4h", "1d", "1w"] as const;
const MAX_CANDLES_PER_REQUEST = 5_000;
const MAX_CURVE_POINTS = 1_500;

// ── Shared schemas ────────────────────────────────────────────────────────────

const strategyParamSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    label: { type: "string" },
    default: { type: "number" },
    min: { type: "number" },
    max: { type: "number" },
    step: { type: "number" },
    // Enum rendering hint — value stays numeric (index into this list); UI-only.
    options: { type: "array", items: { type: "string" } },
    // Conditional-visibility rendering hint — UI-only.
    showIf: {
      type: "object",
      properties: { param: { type: "string" }, equals: { type: "number" } },
      required: ["param", "equals"],
    },
  },
  required: ["name", "label", "default", "min", "max", "step"],
} as const;

const strategyItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    description: { type: "string" },
    params: { type: "array", items: strategyParamSchema },
    supportsPine: { type: "boolean" },
  },
  required: ["id", "label", "description", "params", "supportsPine"],
} as const;

const statsSchema = {
  type: "object",
  properties: {
    totalPnlUsd: { type: "number" },
    totalPnlPct: { type: "number" },
    maxDrawdownUsd: { type: "number" },
    maxDrawdownPct: { type: "number" },
    totalTrades: { type: "integer" },
    winners: { type: "integer" },
    losers: { type: "integer" },
    breakevens: { type: "integer" },
    winRatePct: { type: "number" },
    profitFactor: { type: ["number", "null"] },
    avgPnlUsd: { type: "number" },
    avgPnlPct: { type: "number" },
    avgBarsHeld: { type: "number" },
    largestProfitUsd: { type: "number" },
    largestLossUsd: { type: "number" },
    avgProfitPct: { type: "number" },
    avgLossPct: { type: "number" },
    returnsHistogram: {
      type: "array",
      items: {
        type: "object",
        properties: {
          rangeStart: { type: "number" },
          rangeEnd: { type: "number" },
          count: { type: "integer" },
        },
        required: ["rangeStart", "rangeEnd", "count"],
      },
    },
  },
  required: [
    "totalPnlUsd", "totalPnlPct", "maxDrawdownUsd", "maxDrawdownPct", "totalTrades",
    "winners", "losers", "breakevens", "winRatePct", "profitFactor", "avgPnlUsd",
    "avgPnlPct", "avgBarsHeld", "largestProfitUsd", "largestLossUsd", "avgProfitPct",
    "avgLossPct", "returnsHistogram",
  ],
} as const;

const tradeSchema = {
  type: "object",
  properties: {
    entryTime: { type: "integer" },
    exitTime: { type: "integer" },
    side: { type: "string" },
    entryPrice: { type: "number" },
    exitPrice: { type: "number" },
    qty: { type: "number" },
    sizeUsd: { type: "number" },
    pnlUsd: { type: "number" },
    pnlPct: { type: "number" },
    feeUsd: { type: "number" },
    barsHeld: { type: "integer" },
    exitReason: { type: "string" },
  },
  required: ["entryTime", "exitTime", "side", "entryPrice", "exitPrice", "qty", "sizeUsd", "pnlUsd", "pnlPct", "feeUsd", "barsHeld", "exitReason"],
} as const;

const equityPointSchema = {
  type: "object",
  properties: {
    time: { type: "integer" },
    equity: { type: "number" },
  },
  required: ["time", "equity"],
} as const;

const markerSchema = {
  type: "object",
  properties: {
    time: { type: "integer" },
    price: { type: "number" },
    kind: { type: "string" }, // long | short | exit
    exitReason: { type: "string" },
  },
  required: ["time", "price", "kind"],
} as const;

const candleSchema = {
  type: "object",
  properties: {
    openTime: { type: "integer" },
    open: { type: "number" },
    high: { type: "number" },
    low: { type: "number" },
    close: { type: "number" },
    volume: { type: "number" },
  },
  required: ["openTime", "open", "high", "low", "close", "volume"],
} as const;

const errorSchema = {
  type: "object",
  properties: { error: { type: "string" } },
} as const;

// ── Typed request shapes ──────────────────────────────────────────────────────

interface RunBody {
  strategyId: string;
  params: Record<string, number>;
  symbol: string;
  timeframe: (typeof TIMEFRAMES)[number];
  from: string;
  to: string;
  initialCapital?: number;
  maxPositionUsd?: number;
  leverage?: number;
  feeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
}

interface CandlesQuery {
  symbol: string;
  timeframe: (typeof TIMEFRAMES)[number];
  from: string;
  to: string;
}

function downsample(points: readonly EquityPoint[], maxPoints: number): EquityPoint[] {
  if (points.length <= maxPoints) return [...points];
  const stride = Math.ceil(points.length / maxPoints);
  const out: EquityPoint[] = [];
  for (let i = 0; i < points.length; i += stride) out.push(points[i]!);
  const last = points[points.length - 1]!;
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export const backtestPlugin: FastifyPluginAsync<{ db: PrismaClient; bybit?: BybitClient }> = async (fastify, { db, bybit }) => {
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

  // GET /api/backtest/strategies
  fastify.get("/api/backtest/strategies", {
    schema: {
      response: { 200: { type: "array", items: strategyItemSchema } },
    },
  }, async () => {
    return listStrategies().map((s) => ({
      id: s.id, label: s.label, description: s.description, params: s.params,
      supportsPine: typeof s.toPine === "function",
    }));
  });

  // POST /api/backtest/strategies/:id/pine
  fastify.post<{ Params: { id: string }; Body: { params?: Record<string, number> } }>(
    "/api/backtest/strategies/:id/pine",
    {
      schema: {
        params: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: { params: { type: "object", additionalProperties: { type: "number" }, default: {} } },
        },
        response: {
          200: {
            type: "object",
            properties: { pine: { type: "string" } },
            required: ["pine"],
          },
          400: errorSchema,
        },
      },
    },
    async (req, reply) => {
      const strategy = getStrategy(req.params.id);
      if (!strategy) return reply.status(400).send({ error: `Unknown strategy: ${req.params.id}` });
      if (!strategy.toPine) return reply.status(400).send({ error: `Strategy "${strategy.id}" does not support Pine export` });

      const params = { ...Object.fromEntries(strategy.params.map((p) => [p.name, p.default])), ...req.body.params };
      return { pine: strategy.toPine(params) };
    },
  );

  // POST /api/backtest/run
  fastify.post<{ Body: RunBody }>("/api/backtest/run", {
    schema: {
      body: {
        type: "object",
        required: ["strategyId", "symbol", "timeframe", "from", "to"],
        properties: {
          strategyId:        { type: "string" },
          params:            { type: "object", additionalProperties: { type: "number" }, default: {} },
          symbol:            { type: "string", minLength: 1 },
          timeframe:         { type: "string", enum: TIMEFRAMES },
          from:              { type: "string" },
          to:                { type: "string" },
          initialCapital:    { type: "number", exclusiveMinimum: 0, default: 10_000 },
          maxPositionUsd:    { type: "number", exclusiveMinimum: 0, default: 1_000 },
          leverage:          { type: "integer", minimum: 1, maximum: 100, default: 5 },
          feeBps:            { type: "number", minimum: 0, default: 5.5 },
          slippageBps:       { type: "number", minimum: 0, default: 2 },
          fillModel:         { type: "string", enum: ["signalClose", "nextOpen"], default: "signalClose" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            stats: statsSchema,
            trades: { type: "array", items: tradeSchema },
            equityCurve: { type: "array", items: equityPointSchema },
            buyHoldCurve: { type: "array", items: equityPointSchema },
            markers: { type: "array", items: markerSchema },
          },
          required: ["stats", "trades", "equityCurve", "buyHoldCurve", "markers"],
        },
        400: errorSchema,
        503: errorSchema,
      },
    },
  }, async (req, reply) => {
    if (!bybit) return reply.status(503).send({ error: "Exchange client not available" });

    const strategy = getStrategy(req.body.strategyId);
    if (!strategy) return reply.status(400).send({ error: `Unknown strategy: ${req.body.strategyId}` });

    const symbol = req.body.symbol.toUpperCase();
    const timeframe = req.body.timeframe as TimeframeId;
    const fromMs = Date.parse(req.body.from);
    const toMs = Date.parse(req.body.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return reply.status(400).send({ error: "Invalid from/to date range" });
    }

    const candles: Candle[] = await ensureCandles(db, bybit, symbol, timeframe, fromMs, toMs);
    if (candles.length === 0) {
      return reply.status(400).send({ error: "No candle data available for this symbol/timeframe/range" });
    }

    const instrument = await bybit.getInstrumentInfo(symbol);
    const params = { ...Object.fromEntries(strategy.params.map((p) => [p.name, p.default])), ...req.body.params };

    const signals = strategy.run(candles, params);
    const { trades, equityCurve, buyHoldCurve } = runBacktestEngine(candles, signals, {
      initialCapital: req.body.initialCapital ?? 10_000,
      maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
      leverage: req.body.leverage ?? 5,
      feeBps: req.body.feeBps ?? 5.5,
      slippageBps: req.body.slippageBps ?? 2,
      fillModel: req.body.fillModel ?? "signalClose",
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
    });

    const stats = computeStats(trades, equityCurve, req.body.initialCapital ?? 10_000);

    const markers = trades.flatMap((t) => [
      { time: t.entryTime, price: t.entryPrice, kind: t.side === "BUY" ? "long" : "short" },
      { time: t.exitTime, price: t.exitPrice, kind: "exit", exitReason: t.exitReason },
    ]);

    return {
      stats,
      trades,
      equityCurve: downsample(equityCurve, MAX_CURVE_POINTS),
      buyHoldCurve: downsample(buyHoldCurve, MAX_CURVE_POINTS),
      markers,
    };
  });

  // GET /api/backtest/candles?symbol&timeframe&from&to
  fastify.get<{ Querystring: CandlesQuery }>("/api/backtest/candles", {
    schema: {
      querystring: {
        type: "object",
        required: ["symbol", "timeframe", "from", "to"],
        properties: {
          symbol:    { type: "string", minLength: 1 },
          timeframe: { type: "string", enum: TIMEFRAMES },
          from:      { type: "string" },
          to:        { type: "string" },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            candles: { type: "array", items: candleSchema },
            truncated: { type: "boolean" },
            totalAvailable: { type: "integer" },
          },
          required: ["candles", "truncated", "totalAvailable"],
        },
        400: errorSchema,
        503: errorSchema,
      },
    },
  }, async (req, reply) => {
    if (!bybit) return reply.status(503).send({ error: "Exchange client not available" });

    const symbol = req.query.symbol.toUpperCase();
    const timeframe = req.query.timeframe as TimeframeId;
    const fromMs = Date.parse(req.query.from);
    const toMs = Date.parse(req.query.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return reply.status(400).send({ error: "Invalid from/to date range" });
    }

    const candles = await ensureCandles(db, bybit, symbol, timeframe, fromMs, toMs);
    const truncated = candles.length > MAX_CANDLES_PER_REQUEST;
    const windowed = truncated ? candles.slice(candles.length - MAX_CANDLES_PER_REQUEST) : candles;

    return { candles: windowed, truncated, totalAvailable: candles.length };
  });
};
