const BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";
const TOKEN = (import.meta.env.VITE_API_TOKEN as string | undefined) ?? "";

export type Bot = {
  id: number;
  name: string;
  symbol: string;
  enabled: boolean;
  dryRun: boolean;
  maxPositionUsd: number;
  maxLeverage: number;
  dailyLossLimitUsd: number;
  createdAt: string;
  openTradeCount: number;
};

export type Trade = {
  id: number;
  botId: number;
  signalId: number;
  exchangeOrderId: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  entryFillPrice: number | null;
  exitPrice: number | null;
  exitFillPrice: number | null;
  pnlUsd: number | null;
  realizedPnlUsd: number | null;
  feeOpenUsd: number | null;
  feeCloseUsd: number | null;
  pnlSource: string | null;
  takeProfitPrice: number | null;
  stopLossPrice: number | null;
  tpslSet: boolean;
  status: string;
  openedAt: string;
  closedAt: string | null;
};

export type Position = {
  tradeId: number;
  botId: number;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  entryFillPrice: number | null;
  markPrice: number | null;
  unrealisedPnl: number | null;
  feeOpenUsd: number | null;
  status: string;
  openedAt: string;
};

export type EquitySummary = {
  from: string;
  to: string;
  deltaEquityUsd: number;
  sumRealizedPnlUsd: number;
  sumFeeUsd: number;
  sumFundingUsd: number;
  residualUsd: number;
  tradeCount: number;
  unaccountedTradeCount: number;
};

export type EquityPoint = {
  id: number;
  equityUsd: number;
  availableUsd: number;
  takenAt: string;
};

export type Signal = {
  id: number;
  botId: number;
  action: string;
  symbol: string;
  status: string;
  receivedAt: string;
  processedAt: string | null;
  rejectionReason: string | null;
  isTest?: boolean;
};

export type BotDetail = Bot & {
  signals: (Signal & { processedAt: string | null })[];
  trades: Trade[];
};

export type BotEvent =
  | { type: "signal.received"; data: { signalId: number; botId: number; action: string; symbol: string } }
  | { type: "trade.opened"; data: { tradeId: number; botId: number; symbol: string; side: string; qty: number; entryPrice: number } }
  | { type: "trade.closed"; data: { tradeId: number; botId: number; symbol: string; pnlUsd: number | null } }
  | { type: "trade.liquidated"; data: { tradeId: number; botId: number; symbol: string; realizedPnlUsd: number; createType: string } }
  | { type: "balance.updated"; data: { equityUsd: number; availableUsd: number } }
  | { type: "ws.reconnected"; data: { disconnectedMs: number } };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  // Only set Content-Type when there's an actual body — Fastify's default JSON body parser
  // rejects a bodyless request that claims application/json (FST_ERR_CTP_EMPTY_JSON_BODY),
  // which broke every bodyless POST (e.g. the optimize/auto cancel and kill-switch routes).
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      ...(init?.body != null ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const fetchBots = () => req<Bot[]>("/api/bots");

export const createBot = (data: {
  name: string;
  symbol: string;
  enabled?: boolean;
  dryRun?: boolean;
  maxPositionUsd?: number;
  maxLeverage?: number;
  dailyLossLimitUsd?: number;
}) => req<Bot>("/api/bots", { method: "POST", body: JSON.stringify(data) });

export const patchBot = (
  id: number,
  data: Partial<Pick<Bot, "name" | "symbol" | "enabled" | "dryRun" | "maxPositionUsd" | "maxLeverage" | "dailyLossLimitUsd">>,
) => req<Bot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(data) });

export const fetchBot = (id: number) => req<BotDetail>(`/api/bots/${id}`);

export const testSignal = (botId: number, action: "BUY" | "SELL", simulateTpSlError: boolean) =>
  req<{ signalId: number; webhookId: string }>(
    `/api/bots/${botId}/test-signal`,
    { method: "POST", body: JSON.stringify({ action, simulateTpSlError }) },
  );

export const fetchTrades = (params?: { botId?: number; limit?: number; from?: string; to?: string }) => {
  const q = new URLSearchParams();
  if (params?.botId !== undefined) q.set("botId", String(params.botId));
  if (params?.limit !== undefined) q.set("limit", String(params.limit));
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  return req<Trade[]>(`/api/trades?${q}`);
};

export const fetchEquity = (params?: { from?: string; to?: string }) => {
  const q = new URLSearchParams();
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  return req<EquityPoint[]>(`/api/equity?${q}`);
};

export const fetchPositions = () => req<Position[]>("/api/positions");

export const fetchEquitySummary = (params?: { from?: string; to?: string }) => {
  const q = new URLSearchParams();
  if (params?.from) q.set("from", params.from);
  if (params?.to) q.set("to", params.to);
  return req<EquitySummary>(`/api/equity/summary?${q}`);
};

export const fetchSignals = (params?: { botId?: number; limit?: number }) => {
  const q = new URLSearchParams();
  if (params?.botId !== undefined) q.set("botId", String(params.botId));
  q.set("limit", String(params?.limit ?? 50));
  return req<Signal[]>(`/api/signals?${q}`);
};

export const postKillSwitch = () =>
  req<{ disabled: number }>("/api/kill-switch", { method: "POST" });

// ── Backtesting ────────────────────────────────────────────────────────────

export type BacktestTimeframe = "5m" | "15m" | "4h" | "1d" | "1w";

export type BacktestStrategyParam = {
  name: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
  /** When present, render as a select — the value is still a number (index into this list). */
  options?: string[];
  /** Only show this param when `params[showIf.param] === showIf.equals`. */
  showIf?: { param: string; equals: number };
};

export type BacktestStrategy = {
  id: string;
  label: string;
  description: string;
  params: BacktestStrategyParam[];
  supportsPine: boolean;
};

export type BacktestTrade = {
  entryTime: number;
  exitTime: number;
  side: "BUY" | "SELL";
  entryPrice: number;
  exitPrice: number;
  qty: number;
  sizeUsd: number;
  pnlUsd: number;
  pnlPct: number;
  feeUsd: number;
  barsHeld: number;
  exitReason: "tp" | "sl" | "reversal" | "windowEnd";
};

export type BacktestEquityPoint = { time: number; equity: number };

export type BacktestHistogramBin = { rangeStart: number; rangeEnd: number; count: number };

export type BacktestStats = {
  totalPnlUsd: number;
  totalPnlPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  totalTrades: number;
  winners: number;
  losers: number;
  breakevens: number;
  winRatePct: number;
  profitFactor: number | null;
  avgPnlUsd: number;
  avgPnlPct: number;
  avgBarsHeld: number;
  largestProfitUsd: number;
  largestLossUsd: number;
  avgProfitPct: number;
  avgLossPct: number;
  returnsHistogram: BacktestHistogramBin[];
};

export type BacktestMarker = { time: number; price: number; kind: "long" | "short" | "exit"; exitReason?: string };

export type BacktestRunResult = {
  stats: BacktestStats;
  trades: BacktestTrade[];
  equityCurve: BacktestEquityPoint[];
  buyHoldCurve: BacktestEquityPoint[];
  markers: BacktestMarker[];
};

export type BacktestCandle = { openTime: number; open: number; high: number; low: number; close: number; volume: number };

export const fetchBacktestStrategies = () => req<BacktestStrategy[]>("/api/backtest/strategies");

export const fetchBacktestPine = (strategyId: string, params: Record<string, number>) =>
  req<{ pine: string }>(`/api/backtest/strategies/${strategyId}/pine`, { method: "POST", body: JSON.stringify({ params }) });

export const runBacktest = (body: {
  strategyId: string;
  params: Record<string, number>;
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string;
  to: string;
  initialCapital?: number;
  maxPositionUsd?: number;
  leverage?: number;
  feeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
}) => req<BacktestRunResult>("/api/backtest/run", { method: "POST", body: JSON.stringify(body) });

export const fetchBacktestCandles = (params: { symbol: string; timeframe: BacktestTimeframe; from: string; to: string }) => {
  const q = new URLSearchParams({ symbol: params.symbol, timeframe: params.timeframe, from: params.from, to: params.to });
  return req<{ candles: BacktestCandle[]; truncated: boolean; totalAvailable: number }>(`/api/backtest/candles?${q}`);
};

export type OptimizeSweepParam = { param: string; min: number; max: number; step: number };

export type BacktestOptimizeResult = { params: Record<string, number>; stats: BacktestStats };

export type BacktestOptimizeResponse = {
  totalCombinations: number;
  evaluatedCombinations: number;
  filteredOutCount: number;
  results: BacktestOptimizeResult[];
};

export const runBacktestOptimize = (body: {
  strategyId: string;
  baseParams: Record<string, number>;
  sweep: OptimizeSweepParam[];
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string;
  to: string;
  initialCapital?: number;
  maxPositionUsd?: number;
  leverage?: number;
  feeBps?: number;
  slippageBps?: number;
  fillModel?: "signalClose" | "nextOpen";
  minTrades?: number;
}) => req<BacktestOptimizeResponse>("/api/backtest/optimize", { method: "POST", body: JSON.stringify(body) });

// ── Strategy Finder (auto strategy/param search) ────────────────────────────

export type ScoreWeights = {
  sharpeWeight: number;
  profitFactorWeight: number;
  pnlWeight: number;
  drawdownPenalty: number;
  minTrades: number;
};

export type AutoOptimizeCellResult = {
  strategyId: string;
  symbol: string;
  timeframe: BacktestTimeframe;
  params: Record<string, number>;
  isStats: BacktestStats;
  oosStats: BacktestStats;
  isScore: number;
  oosScore: number;
  overfitFlag: boolean;
};

export type AutoOptimizeRunStatus = "running" | "done" | "error" | "cancelled";

export type AutoOptimizeRun = {
  id: number;
  status: AutoOptimizeRunStatus;
  cellsTotal: number;
  cellsDone: number;
  backtestsRun: number;
  error: string | null;
  createdAt: string;
  results: AutoOptimizeCellResult[];
};

export type AutoOptimizeRunSummary = {
  id: number;
  status: AutoOptimizeRunStatus;
  cellsTotal: number;
  cellsDone: number;
  createdAt: string;
};

export const startAutoOptimize = (body: {
  symbols: string[];
  timeframes: BacktestTimeframe[];
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
}) => req<{ runId: number }>("/api/backtest/optimize/auto", { method: "POST", body: JSON.stringify(body) });

export const getAutoOptimizeRun = (runId: number) => req<AutoOptimizeRun>(`/api/backtest/optimize/auto/${runId}`);

export const listAutoOptimizeRuns = () => req<AutoOptimizeRunSummary[]>("/api/backtest/optimize/auto");

export const cancelAutoOptimizeRun = (runId: number) =>
  req<{ cancelled: boolean }>(`/api/backtest/optimize/auto/${runId}/cancel`, { method: "POST" });

export const deleteAutoOptimizeRun = (runId: number) =>
  req<{ deleted: boolean }>(`/api/backtest/optimize/auto/${runId}`, { method: "DELETE" });
