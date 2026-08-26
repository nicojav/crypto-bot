import type { FastifyPluginAsync } from "fastify";

import type { PrismaClient } from "../generated/prisma/client.js";
import type { BybitClient, TimeframeId } from "../exchange/bybit.js";
import { env } from "../env.js";
import { ensureCandles } from "./candleStore.js";
import { ensureFundingRates } from "./fundingStore.js";
import { listStrategies, getStrategy } from "./strategies/index.js";
import type { EquityPoint, FundingRatePoint, BacktestTrade } from "./engine.js";
import { countCombinations, generateParamCombinations, type SweepParam } from "./optimizer.js";
import { runAutoOptimization, isOptimizationRunning, cancelRun, getActiveRunId, type AutoOptimizeConfig } from "./optimizationRunner.js";
import { DEFAULT_SCORE_WEIGHTS, type ScoreWeights } from "./scoring.js";
import { BacktestWorkerPool } from "./workerPool.js";
import type { Candle } from "./types.js";

const TIMEFRAMES = ["5m", "15m", "4h", "1d", "1w"] as const;
const MAX_CANDLES_PER_REQUEST = 5_000;
const MAX_CURVE_POINTS = 1_500;
const MAX_OPTIMIZE_COMBINATIONS = 500;
const MAX_OPTIMIZE_RESULTS = 50;
/** Bounds one /optimize sweep's total work (candles x combos) — worker threads keep this off
 * the event loop, but an unbounded sweep can still monopolize the pool for an unreasonable time. */
const MAX_OPTIMIZE_WORKLOAD = 100_000_000;
/** Bounds one Strategy Finder run's cell count (strategies x symbols x timeframes) — nothing in
 * the UI enforces this, and each cell is itself ~1,200 backtests. */
const MAX_AUTO_OPTIMIZE_CELLS = 100;
/** How many /run + /optimize requests may have their own worker pool active at once. Each pool
 * uses up to os.availableParallelism()-1 threads, so unbounded concurrent requests would still
 * let many browser tabs fight over the same physical cores (and, at the limit, starve the
 * trading process of CPU) even though no single request can block the event loop anymore. */
const MAX_CONCURRENT_ADHOC_POOLS = 2;
let activeAdhocPools = 0;

async function withPool<T>(fn: (pool: BacktestWorkerPool) => Promise<T>): Promise<T> {
  if (activeAdhocPools >= MAX_CONCURRENT_ADHOC_POOLS) {
    throw Object.assign(new Error("Too many concurrent backtests running — wait for one to finish and try again"), { statusCode: 429 });
  }
  activeAdhocPools++;
  const pool = new BacktestWorkerPool();
  try {
    return await fn(pool);
  } finally {
    activeAdhocPools--;
    await pool.destroy();
  }
}

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
    sharpeRatio: { type: "number" },
    sortinoRatio: { type: "number" },
    calmarRatio: { type: "number" },
    expectancy: { type: ["number", "null"] },
    exposurePct: { type: "number" },
    totalFeesUsd: { type: "number" },
    totalFundingUsd: { type: "number" },
    costDragPct: { type: "number" },
    avgGrossPnlPct: { type: "number" },
    avgCostPct: { type: "number" },
    maxConsecutiveLosses: { type: "integer" },
    exitReasonBreakdown: {
      type: "array",
      items: {
        type: "object",
        properties: {
          exitReason: { type: "string" },
          count: { type: "integer" },
          avgPnlUsd: { type: "number" },
        },
        required: ["exitReason", "count", "avgPnlUsd"],
      },
    },
    monthlyReturns: {
      type: "array",
      items: {
        type: "object",
        properties: {
          month: { type: "string" },
          returnPct: { type: "number" },
        },
        required: ["month", "returnPct"],
      },
    },
  },
  required: [
    "totalPnlUsd", "totalPnlPct", "maxDrawdownUsd", "maxDrawdownPct", "totalTrades",
    "winners", "losers", "breakevens", "winRatePct", "profitFactor", "avgPnlUsd",
    "avgPnlPct", "avgBarsHeld", "largestProfitUsd", "largestLossUsd", "avgProfitPct",
    "avgLossPct", "returnsHistogram", "sharpeRatio", "sortinoRatio", "calmarRatio",
    "expectancy", "exposurePct", "maxConsecutiveLosses", "exitReasonBreakdown", "monthlyReturns",
    // The cost fields above are deliberately NOT required. This same schema serializes
    // OptimizationRun rows persisted before those fields existed, and fast-json-stringify throws
    // on a missing required property — marking them required would 500 every historical run in
    // the history panel. Fresh results always carry them; old ones render without.
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
    fundingUsd: { type: "number" },
    barsHeld: { type: "integer" },
    exitReason: { type: "string" },
    maePct: { type: "number" },
    mfePct: { type: "number" },
  },
  required: ["entryTime", "exitTime", "side", "entryPrice", "exitPrice", "qty", "sizeUsd", "pnlUsd", "pnlPct", "feeUsd", "fundingUsd", "barsHeld", "exitReason", "maePct", "mfePct"],
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
    trainStats: statsSchema,
    validateStats: statsSchema,
    holdoutStats: statsSchema,
    trainScore: { type: "number" },
    validateScore: { type: "number" },
    holdoutScore: { type: "number" },
    validateRatio: { type: "number" },
    holdoutRatio: { type: "number" },
    combosEvaluated: { type: "integer" },
    walkForwardScores: { type: "array", items: { type: "number" } },
  },
  required: [
    "strategyId", "symbol", "timeframe", "params",
    "trainStats", "validateStats", "holdoutStats",
    "trainScore", "validateScore", "holdoutScore",
    "validateRatio", "holdoutRatio", "combosEvaluated",
  ],
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
    from: { type: ["string", "null"] },
    to: { type: ["string", "null"] },
    results: { type: "array", items: cellResultSchema },
  },
  required: ["id", "status", "cellsTotal", "cellsDone", "backtestsRun", "createdAt", "from", "to", "results"],
} as const;

// The run's requested date range lives only inside its configJson snapshot (see
// AutoOptimizeConfig) — never on its own columns — so both the single-run and history routes
// below parse it out here. Tolerates a malformed/legacy row (e.g. a schema change) by degrading
// to nulls instead of 500ing the whole response.
function configRange(configJson: string): { from: string | null; to: string | null } {
  try {
    const config = JSON.parse(configJson) as { from?: unknown; to?: unknown };
    return {
      from: typeof config.from === "string" ? config.from : null,
      to: typeof config.to === "string" ? config.to : null,
    };
  } catch {
    return { from: null, to: null };
  }
}

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
  /** Per-side overrides for `feeBps` — see EngineConfig.entryFeeBps. */
  entryFeeBps?: number;
  exitFeeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
  maintenanceMarginRate?: number;
  /** When true, also runs the opposite fill model and returns its stats alongside the primary
   * result — see the `fillModelComparison` response field. */
  compareFillModel?: boolean;
  /** When true, also runs at 2x slippage and 2x fees and returns its stats alongside the primary
   * result — see the `sensitivityComparison` response field. A result that survives doubled
   * costs is far more likely to be a real edge than a fee-model artifact. */
  sensitivityCheck?: boolean;
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
  /** Per-side overrides for `feeBps` — see EngineConfig.entryFeeBps. */
  entryFeeBps?: number;
  exitFeeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
  minTrades?: number;
  maintenanceMarginRate?: number;
}

interface AutoOptimizeBody {
  symbols: string[];
  timeframes: (typeof TIMEFRAMES)[number][];
  strategyIds?: string[];
  from: string;
  to: string;
  validateFraction?: number;
  holdoutFraction?: number;
  /** Opt-in — omit (or 1) for a single continuous validate-slice score; > 1 aggregates that many
   * rolling validate folds instead. See search.ts's WalkForwardOptions. */
  walkForwardFolds?: number;
  minTrades?: number;
  scoreWeights?: Partial<ScoreWeights>;
  initialCapital?: number;
  maxPositionUsd?: number;
  leverage?: number;
  feeBps?: number;
  /** Per-side overrides for `feeBps` — see EngineConfig.entryFeeBps. */
  entryFeeBps?: number;
  exitFeeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
  maintenanceMarginRate?: number;
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
          entryFeeBps:       { type: "number", minimum: 0 },
          exitFeeBps:        { type: "number", minimum: 0 },
          slippageBps:       { type: "number", minimum: 0, default: 2 },
          fillModel:         { type: "string", enum: ["signalClose", "nextOpen"], default: "signalClose" },
          maintenanceMarginRate: { type: "number", minimum: 0, maximum: 1 },
          compareFillModel:  { type: "boolean", default: false },
          sensitivityCheck:  { type: "boolean", default: false },
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
            fillModelComparison: {
              type: "object",
              properties: {
                fillModel: { type: "string", enum: ["signalClose", "nextOpen"] },
                stats: statsSchema,
              },
              required: ["fillModel", "stats"],
            },
            sensitivityComparison: {
              type: "object",
              properties: {
                slippageBps: { type: "number" },
                feeBps: { type: "number" },
                stats: statsSchema,
              },
              required: ["slippageBps", "feeBps", "stats"],
            },
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

    const [candles, fundingRates]: [Candle[], FundingRatePoint[]] = await Promise.all([
      ensureCandles(db, bybit, symbol, timeframe, fromMs, toMs),
      ensureFundingRates(db, bybit, symbol, fromMs, toMs),
    ]);
    if (candles.length === 0) {
      return reply.status(400).send({ error: "No candle data available for this symbol/timeframe/range" });
    }

    const instrument = await bybit.getInstrumentInfo(symbol);
    const params = { ...Object.fromEntries(strategy.params.map((p) => [p.name, p.default])), ...req.body.params };
    const engineConfig = {
      initialCapital: req.body.initialCapital ?? 10_000,
      maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
      leverage: req.body.leverage ?? 5,
      feeBps: req.body.feeBps ?? 5.5,
      entryFeeBps: req.body.entryFeeBps,
      exitFeeBps: req.body.exitFeeBps,
      slippageBps: req.body.slippageBps ?? 2,
      fillModel: req.body.fillModel ?? "signalClose",
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
      maintenanceMarginRate: req.body.maintenanceMarginRate,
      fundingRates,
    };

    // signalClose fills at the exact bar it decided on; nextOpen fills one bar later instead.
    // compareFillModel runs both so that gap is visible rather than a silent default. Note: for
    // a continuously-traded perpetual (this bot's instruments), a candle's close and the next
    // candle's open are the same price by construction — there's no session gap the way
    // traditional/equity markets have overnight ones — so nextOpen typically only shifts entry
    // *timing* by one bar (entryTime, barsHeld composition) with zero effect on fill price or
    // PnL. The comparison still has real value for less liquid symbols/timeframes where that
    // close==nextOpen equality can break down, and for strategies whose brackets are tight
    // enough that even a same-price, later-time fill changes which bar's high/low a TP/SL check
    // sees first.
    const altFillModel: "signalClose" | "nextOpen" = engineConfig.fillModel === "signalClose" ? "nextOpen" : "signalClose";

    // A result that only looks good at the exact fee/slippage assumptions above is a fee-model
    // artifact, not an edge. sensitivityCheck re-runs at double both, so that's visible instead
    // of hidden behind whatever constants happened to be configured.
    // The per-side overrides have to be doubled alongside `feeBps`, not left alone: they take
    // precedence over it in the engine, so a split-fee config would otherwise sail through the
    // sensitivity run at its original fees and look far more robust than it is.
    const sensitivityConfig = {
      ...engineConfig,
      slippageBps: engineConfig.slippageBps * 2,
      feeBps: engineConfig.feeBps * 2,
      ...(engineConfig.entryFeeBps != null ? { entryFeeBps: engineConfig.entryFeeBps * 2 } : {}),
      ...(engineConfig.exitFeeBps != null ? { exitFeeBps: engineConfig.exitFeeBps * 2 } : {}),
    };

    // Off the main thread — this request used to run the full simulation synchronously inline,
    // which could stall webhook ingestion/reconciliation in this same process for as long as a
    // large candle window took to simulate. See workerPool.ts.
    const [primary, comparison, sensitivity] = await withPool((pool) =>
      Promise.all([
        pool.runFull(candles, strategy.id, params, engineConfig, timeframe),
        req.body.compareFillModel ? pool.runFull(candles, strategy.id, params, { ...engineConfig, fillModel: altFillModel }, timeframe) : null,
        req.body.sensitivityCheck ? pool.runFull(candles, strategy.id, params, sensitivityConfig, timeframe) : null,
      ]),
    );

    const { trades, equityCurve, buyHoldCurve, stats } = primary;

    const markers = trades.flatMap((t: BacktestTrade) => [
      { time: t.entryTime, price: t.entryPrice, kind: t.side === "BUY" ? "long" : "short" },
      { time: t.exitTime, price: t.exitPrice, kind: "exit", exitReason: t.exitReason },
    ]);

    return {
      stats,
      trades,
      equityCurve: downsample(equityCurve, MAX_CURVE_POINTS),
      buyHoldCurve: downsample(buyHoldCurve, MAX_CURVE_POINTS),
      markers,
      ...(comparison ? { fillModelComparison: { fillModel: altFillModel, stats: comparison.stats } } : {}),
      ...(sensitivity ? { sensitivityComparison: { slippageBps: sensitivityConfig.slippageBps, feeBps: sensitivityConfig.feeBps, stats: sensitivity.stats } } : {}),
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
          entryFeeBps:       { type: "number", minimum: 0 },
          exitFeeBps:        { type: "number", minimum: 0 },
          slippageBps:       { type: "number", minimum: 0, default: 2 },
          fillModel:         { type: "string", enum: ["signalClose", "nextOpen"], default: "signalClose" },
          minTrades:         { type: "integer", minimum: 0, default: 10 },
          maintenanceMarginRate: { type: "number", minimum: 0, maximum: 1 },
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

    const [candles, fundingRates]: [Candle[], FundingRatePoint[]] = await Promise.all([
      ensureCandles(db, bybit, symbol, timeframe, fromMs, toMs),
      ensureFundingRates(db, bybit, symbol, fromMs, toMs),
    ]);
    if (candles.length === 0) {
      return reply.status(400).send({ error: "No candle data available for this symbol/timeframe/range" });
    }

    const instrument = await bybit.getInstrumentInfo(symbol);
    const defaults = Object.fromEntries(strategy.params.map((p) => [p.name, p.default]));
    const baseParams = { ...defaults, ...req.body.baseParams };
    const combos = generateParamCombinations(baseParams, req.body.sweep);

    const workload = candles.length * combos.length;
    if (workload > MAX_OPTIMIZE_WORKLOAD) {
      return reply.status(400).send({
        error: `Sweep would evaluate ${combos.length} combinations over ${candles.length} candles (${workload.toLocaleString()} candle-evaluations) — narrow the date range, timeframe, or sweep.`,
      });
    }

    const engineConfig = {
      initialCapital: req.body.initialCapital ?? 10_000,
      maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
      leverage: req.body.leverage ?? 5,
      feeBps: req.body.feeBps ?? 5.5,
      entryFeeBps: req.body.entryFeeBps,
      exitFeeBps: req.body.exitFeeBps,
      slippageBps: req.body.slippageBps ?? 2,
      fillModel: req.body.fillModel ?? "signalClose",
      lotSize: instrument.lotSize,
      tickSize: instrument.tickSize,
      maintenanceMarginRate: req.body.maintenanceMarginRate,
      fundingRates,
    };
    const minTrades = req.body.minTrades ?? 10;

    // Off the main thread and dispatched concurrently — this loop used to run every combo
    // synchronously inline with no yielding, up to MAX_OPTIMIZE_COMBINATIONS in one request.
    let filteredOutCount = 0;
    const allResults = await withPool((pool) =>
      Promise.all(combos.map((params) => pool.runStats(candles, strategy.id, params, engineConfig, timeframe).then((r) => ({ params, stats: r.stats })))),
    );
    const evaluated: { params: Record<string, number>; stats: (typeof allResults)[number]["stats"] }[] = [];
    for (const { params, stats } of allResults) {
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
          validateFraction:  { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.15 },
          holdoutFraction:   { type: "number", exclusiveMinimum: 0, exclusiveMaximum: 1, default: 0.15 },
          walkForwardFolds:  { type: "integer", minimum: 2, maximum: 12 },
          minTrades:         { type: "integer", minimum: 0, default: 30 },
          scoreWeights:      scoreWeightsSchema,
          initialCapital:    { type: "number", exclusiveMinimum: 0, default: 10_000 },
          maxPositionUsd:    { type: "number", exclusiveMinimum: 0, default: 1_000 },
          leverage:          { type: "integer", minimum: 1, maximum: 100, default: 5 },
          feeBps:            { type: "number", minimum: 0, default: 5.5 },
          entryFeeBps:       { type: "number", minimum: 0 },
          exitFeeBps:        { type: "number", minimum: 0 },
          slippageBps:       { type: "number", minimum: 0, default: 2 },
          fillModel:         { type: "string", enum: ["signalClose", "nextOpen"], default: "signalClose" },
          maintenanceMarginRate: { type: "number", minimum: 0, maximum: 1 },
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

    const cellCount = strategyIds.length * req.body.symbols.length * req.body.timeframes.length;
    if (cellCount > MAX_AUTO_OPTIMIZE_CELLS) {
      return reply.status(400).send({
        error: `${cellCount} cells (strategies x symbols x timeframes) requested — narrow the selection to ${MAX_AUTO_OPTIMIZE_CELLS} or fewer. Each cell is its own coarse-to-fine search.`,
      });
    }

    const fromMs = Date.parse(req.body.from);
    const toMs = Date.parse(req.body.to);
    if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
      return reply.status(400).send({ error: "Invalid from/to date range" });
    }

    const validateFraction = req.body.validateFraction ?? 0.15;
    const holdoutFraction = req.body.holdoutFraction ?? 0.15;
    if (validateFraction + holdoutFraction >= 1) {
      return reply.status(400).send({ error: "validateFraction + holdoutFraction must leave room for a training set (sum < 1)" });
    }

    const config: AutoOptimizeConfig = {
      symbols: req.body.symbols.map((s) => s.toUpperCase()),
      timeframes: req.body.timeframes as TimeframeId[],
      strategyIds,
      from: req.body.from,
      to: req.body.to,
      validateFraction,
      holdoutFraction,
      walkForwardFolds: req.body.walkForwardFolds,
      minTrades: req.body.minTrades ?? 30,
      scoreWeights: { ...DEFAULT_SCORE_WEIGHTS, ...req.body.scoreWeights },
      engine: {
        initialCapital: req.body.initialCapital ?? 10_000,
        maxPositionUsd: req.body.maxPositionUsd ?? 1_000,
        leverage: req.body.leverage ?? 5,
        feeBps: req.body.feeBps ?? 5.5,
        entryFeeBps: req.body.entryFeeBps,
        exitFeeBps: req.body.exitFeeBps,
        slippageBps: req.body.slippageBps ?? 2,
        fillModel: req.body.fillModel ?? "signalClose",
        maintenanceMarginRate: req.body.maintenanceMarginRate,
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
      ...configRange(run.configJson),
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
              from: { type: ["string", "null"] },
              to: { type: ["string", "null"] },
            },
            required: ["id", "status", "cellsTotal", "cellsDone", "createdAt", "from", "to"],
          },
        },
      },
    },
  }, async () => {
    const runs = await db.optimizationRun.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
    return runs.map((r) => ({
      id: r.id,
      status: r.status,
      cellsTotal: r.cellsTotal,
      cellsDone: r.cellsDone,
      createdAt: r.createdAt.toISOString(),
      ...configRange(r.configJson),
    }));
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
