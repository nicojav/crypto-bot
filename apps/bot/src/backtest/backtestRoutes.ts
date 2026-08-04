import type { FastifyPluginAsync } from "fastify";
import type { PrismaClient } from "../generated/prisma/client.js";
import type { BybitClient, TimeframeId } from "../exchange/bybit.js";
import { env } from "../env.js";
import { ensureCandles } from "./candleStore.js";
import { listStrategies, getStrategy } from "./strategies/index.js";
import type { EquityPoint } from "./engine.js";
import { countCombinations, generateParamCombinations, runOneBacktest, type SweepParam } from "./optimizer.js";
import { runAutoOptimization, isOptimizationRunning, cancelRun, getActiveRunId, type AutoOptimizeConfig } from "./optimizationRunner.js";
import { DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from "./scoring.js";
import type { Candle } from "./types.js";

const TIMEFRAMES = ["5m", "15m", "4h", "1d", "1w"] as const;
const MAX_CANDLES_PER_REQUEST = 5_000;
const MAX_CURVE_POINTS = 1_500;
const MAX_OPTIMIZE_COMBINATIONS = 500;
const MAX_OPTIMIZE_RESULTS = 50;

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

const optimizeSweepParamSchema = {
  type: "object",
  properties: {
    param: { type: "string" },
    min: { type: "number" },
    max: { type: "number" },
    step: { type: "number", exclusiveMinimum: 0 },
  },
  required: ["param", "min", "max", "step"],
} as const;

const optimizeResultSchema = {
  type: "object",
  properties: {
    params: { type: "object", additionalProperties: { type: "number" } },
    stats: statsSchema,
  },
  required: ["params", "stats"],
} as const;

const scoreWeightsSchema = {
  type: "object",
  properties: {
    sharpeWeight: { type: "number" },
    profitFactorWeight: { type: "number" },
    pnlWeight: { type: "number" },
    drawdownPenalty: { type: "number" },
    minTrades: { type: "number" },
  },
} as const;

const cellResultSchema = {
  type: "object",
  properties: {
    strategyId: { type: "string" },
    symbol: { type: "string" },
    timeframe: { type: "string" },
    params: { type: "object", additionalProperties: { type: "number" } },
    isStats: statsSchema,
    oosStats: statsSchema,
    isScore: { type: "number" },
    oosScore: { type: "number" },
    overfitFlag: { type: "boolean" },
  },
  required: ["strategyId", "symbol", "timeframe", "params", "isStats", "oosStats", "isScore", "oosScore", "overfitFlag"],
} as const;

const autoOptimizeRunSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    status: { type: "string" }, // running | done | error | cancelled
    cellsTotal: { type: "integer" },
    cellsDone: { type: "integer" },
    backtestsRun: { type: "integer" },
    error: { type: ["string", "null"] },
    createdAt: { type: "string" },
    results: { type: "array", items: cellResultSchema },
  },
  required: ["id", "status", "cellsTotal", "cellsDone", "backtestsRun", "createdAt", "results"],
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

interface OptimizeBody {
  strategyId: string;
  baseParams: Record<string, number>;
  sweep: SweepParam[];
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
  minTrades?: number;
}

interface AutoOptimizeBody {
  symbols: string[];
  timeframes: (typeof TIMEFRAMES)[number][];
  strategyIds?: string[];
  from: string;
  to: string;
  oosFraction?: number;
  minTrades?: number;
  scoreWeights?: Partial<ScoreWeights>;
  initialCapital?: number;
  maxPositionUsd?: number;
  leverage?: number;
  feeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
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

    const { trades, equityCurve, buyHoldCurve, stats } = runOneBacktest(strategy, candles, params, {
      initialCapital: req.body.initialCapital ?? 10_000,
      maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
      leverage: req.body.leverage ?? 5,
      feeBps: req.body.feeBps ?? 5.5,
      slippageBps: req.body.slippageBps ?? 2,
      fillModel: req.body.fillModel ?? "signalClose",
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
    });

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

  // POST /api/backtest/optimize
  // Sweeps 1-3 numeric params over a range/step (everything else fixed at baseParams),
  // fetching candles once and reusing them across every combination. Ranked by Total PnL%,
  // excluding combinations with too few trades to be statistically meaningful.
  fastify.post<{ Body: OptimizeBody }>("/api/backtest/optimize", {
    schema: {
      body: {
        type: "object",
        required: ["strategyId", "symbol", "timeframe", "from", "to", "sweep"],
        properties: {
          strategyId:        { type: "string" },
          baseParams:        { type: "object", additionalProperties: { type: "number" }, default: {} },
          sweep:             { type: "array", items: optimizeSweepParamSchema, minItems: 1, maxItems: 3 },
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
          minTrades:         { type: "integer", minimum: 0, default: 10 },
        },
      },
      response: {
        200: {
          type: "object",
          properties: {
            totalCombinations: { type: "integer" },
            evaluatedCombinations: { type: "integer" },
            filteredOutCount: { type: "integer" },
            results: { type: "array", items: optimizeResultSchema },
          },
          required: ["totalCombinations", "evaluatedCombinations", "filteredOutCount", "results"],
        },
        400: errorSchema,
        503: errorSchema,
      },
    },
  }, async (req, reply) => {
    if (!bybit) return reply.status(503).send({ error: "Exchange client not available" });

    const strategy = getStrategy(req.body.strategyId);
    if (!strategy) return reply.status(400).send({ error: `Unknown strategy: ${req.body.strategyId}` });

    const validParamNames = new Set(strategy.params.map((p) => p.name));
    for (const s of req.body.sweep) {
      if (!validParamNames.has(s.param)) {
        return reply.status(400).send({ error: `Unknown param "${s.param}" for strategy "${strategy.id}"` });
      }
    }

    const totalCombinations = countCombinations(req.body.sweep);
    if (totalCombinations > MAX_OPTIMIZE_COMBINATIONS) {
      return reply.status(400).send({
        error: `Sweep would run ${totalCombinations} combinations — narrow the range/step to ${MAX_OPTIMIZE_COMBINATIONS} or fewer.`,
      });
    }

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
    const defaults = Object.fromEntries(strategy.params.map((p) => [p.name, p.default]));
    const baseParams = { ...defaults, ...req.body.baseParams };
    const combos = generateParamCombinations(baseParams, req.body.sweep);

    const engineConfig = {
      initialCapital: req.body.initialCapital ?? 10_000,
      maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
      leverage: req.body.leverage ?? 5,
      feeBps: req.body.feeBps ?? 5.5,
      slippageBps: req.body.slippageBps ?? 2,
      fillModel: req.body.fillModel ?? "signalClose",
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
    } as const;
    const minTrades = req.body.minTrades ?? 10;

    let filteredOutCount = 0;
    const evaluated: { params: Record<string, number>; stats: ReturnType<typeof runOneBacktest>["stats"] }[] = [];
    for (const params of combos) {
      const { stats } = runOneBacktest(strategy, candles, params, engineConfig);
      if (stats.totalTrades < minTrades) {
        filteredOutCount++;
        continue;
      }
      evaluated.push({ params, stats });
    }

    evaluated.sort((a, b) => b.stats.totalPnlPct - a.stats.totalPnlPct);

    return {
      totalCombinations,
      evaluatedCombinations: combos.length,
      filteredOutCount,
      results: evaluated.slice(0, MAX_OPTIMIZE_RESULTS),
    };
  });

  // POST /api/backtest/optimize/auto
  // Kicks off the coarse-grid / out-of-sample "Strategy Finder" search across a full
  // strategy x symbol x timeframe matrix as a detached background job (see
  // optimizationRunner.ts) — unlike /optimize above, this is NOT bounded to run inline in
  // the request: it can take minutes and must not block the live trading loop
  // (SignalProcessor/Reconciler share this process). Returns immediately with a runId to poll.
  fastify.post<{ Body: AutoOptimizeBody }>("/api/backtest/optimize/auto", {
    schema: {
      body: {
        type: "object",
        required: ["symbols", "timeframes", "from", "to"],
        properties: {
          symbols:           { type: "array", items: { type: "string", minLength: 1 }, minItems: 1 },
          timeframes:        { type: "array", items: { type: "string", enum: TIMEFRAMES }, minItems: 1 },
          strategyIds:       { type: "array", items: { type: "string" } },
          from:              { type: "string" },
          to:                { type: "string" },
          oosFraction:       { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.3 },
          minTrades:         { type: "integer", minimum: 0, default: 10 },
          scoreWeights:      scoreWeightsSchema,
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
          properties: { runId: { type: "integer" } },
          required: ["runId"],
        },
        400: errorSchema,
        409: errorSchema,
        503: errorSchema,
      },
    },
  }, async (req, reply) => {
    if (!bybit) return reply.status(503).send({ error: "Exchange client not available" });
    if (isOptimizationRunning()) {
      return reply.status(409).send({ error: "An optimization run is already active — wait for it to finish or cancel it" });
    }

    const strategyIds = req.body.strategyIds && req.body.strategyIds.length > 0 ? req.body.strategyIds : listStrategies().map((s) => s.id);
    for (const id of strategyIds) {
      if (!getStrategy(id)) return reply.status(400).send({ error: `Unknown strategy: ${id}` });
    }

    const fromMs = Date.parse(req.body.from);
    const toMs = Date.parse(req.body.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return reply.status(400).send({ error: "Invalid from/to date range" });
    }

    const config: AutoOptimizeConfig = {
      symbols: req.body.symbols.map((s) => s.toUpperCase()),
      timeframes: req.body.timeframes as TimeframeId[],
      strategyIds,
      from: req.body.from,
      to: req.body.to,
      oosFraction: req.body.oosFraction ?? 0.3,
      minTrades: req.body.minTrades ?? 10,
      scoreWeights: { ...DEFAULT_SCORE_WEIGHTS, ...req.body.scoreWeights },
      engine: {
        initialCapital: req.body.initialCapital ?? 10_000,
        maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
        leverage: req.body.leverage ?? 5,
        feeBps: req.body.feeBps ?? 5.5,
        slippageBps: req.body.slippageBps ?? 2,
        fillModel: req.body.fillModel ?? "signalClose",
      },
    };

    const run = await db.optimizationRun.create({
      data: {
        status: "running",
        configJson: JSON.stringify(config),
        cellsTotal: config.strategyIds.length * config.symbols.length * config.timeframes.length,
      },
    });

    // Detached — not awaited. runAutoOptimization owns the row's lifecycle from here
    // (progress + status updates), including on failure; this catch is a last-resort log
    // in case it throws before its own try/finally can persist an "error" status.
    runAutoOptimization(db, bybit, run.id, config).catch((err: unknown) => {
      fastify.log.error({ err, runId: run.id }, "auto optimization run failed");
    });

    return { runId: run.id };
  });

  // GET /api/backtest/optimize/auto/:runId
  fastify.get<{ Params: { runId: string } }>("/api/backtest/optimize/auto/:runId", {
    schema: {
      params: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      response: { 200: autoOptimizeRunSchema, 404: errorSchema },
    },
  }, async (req, reply) => {
    const run = await db.optimizationRun.findUnique({ where: { id: Number(req.params.runId) } });
    if (!run) return reply.status(404).send({ error: "Run not found" });

    return {
      id: run.id,
      status: run.status,
      cellsTotal: run.cellsTotal,
      cellsDone: run.cellsDone,
      backtestsRun: run.backtestsRun,
      error: run.error,
      createdAt: run.createdAt.toISOString(),
      results: JSON.parse(run.resultsJson),
    };
  });

  // GET /api/backtest/optimize/auto — recent run history
  fastify.get("/api/backtest/optimize/auto", {
    schema: {
      response: {
        200: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "integer" },
              status: { type: "string" },
              cellsTotal: { type: "integer" },
              cellsDone: { type: "integer" },
              createdAt: { type: "string" },
            },
            required: ["id", "status", "cellsTotal", "cellsDone", "createdAt"],
          },
        },
      },
    },
  }, async () => {
    const runs = await db.optimizationRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    return runs.map((r) => ({ id: r.id, status: r.status, cellsTotal: r.cellsTotal, cellsDone: r.cellsDone, createdAt: r.createdAt.toISOString() }));
  });

  // POST /api/backtest/optimize/auto/:runId/cancel
  fastify.post<{ Params: { runId: string } }>("/api/backtest/optimize/auto/:runId/cancel", {
    schema: {
      params: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      response: {
        200: { type: "object", properties: { cancelled: { type: "boolean" } }, required: ["cancelled"] },
        404: errorSchema,
      },
    },
  }, async (req, reply) => {
    const runId = Number(req.params.runId);
    if (cancelRun(runId)) return { cancelled: true };

    // Not the current process's active run — either it already finished normally, or it's
    // orphaned: the process that was executing it died (crash, deploy, a `tsx watch` restart)
    // before reaching its cleanup code, so the row is stuck at "running" forever with no live
    // process able to signal it (healOrphanedRuns only runs at startup). Self-heal that case
    // here so cancel always gives the user a way out, not just after another restart.
    const run = await db.optimizationRun.findUnique({ where: { id: runId } });
    if (!run) return reply.status(404).send({ error: "Run not found" });

    if (run.status === "running" && getActiveRunId() !== runId) {
      await db.optimizationRun.update({
        where: { id: runId },
        data: { status: "cancelled", error: "Interrupted — no active process was executing this run (likely a server restart)" },
      });
      return { cancelled: true };
    }

    return reply.status(404).send({ error: "Run not active (already finished)" });
  });

  // DELETE /api/backtest/optimize/auto/:runId — clears a run (and its results) from history.
  fastify.delete<{ Params: { runId: string } }>("/api/backtest/optimize/auto/:runId", {
    schema: {
      params: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
      response: {
        200: { type: "object", properties: { deleted: { type: "boolean" } }, required: ["deleted"] },
        404: errorSchema,
        409: errorSchema,
      },
    },
  }, async (req, reply) => {
    const runId = Number(req.params.runId);
    if (getActiveRunId() === runId) {
      return reply.status(409).send({ error: "This run is still active — cancel it before deleting" });
    }

    const run = await db.optimizationRun.findUnique({ where: { id: runId } });
    if (!run) return reply.status(404).send({ error: "Run not found" });

    await db.optimizationRun.delete({ where: { id: runId } });
    return { deleted: true };
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
