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
};

export type BotEvent =
  | { type: "signal.received"; data: { signalId: number; botId: number; action: string; symbol: string } }
  | { type: "trade.opened"; data: { tradeId: number; botId: number; symbol: string; side: string; qty: number; entryPrice: number } }
  | { type: "trade.closed"; data: { tradeId: number; botId: number; symbol: string; pnlUsd: number | null } }
  | { type: "trade.liquidated"; data: { tradeId: number; botId: number; symbol: string; realizedPnlUsd: number; createType: string } }
  | { type: "balance.updated"; data: { equityUsd: number; availableUsd: number } }
  | { type: "ws.reconnected"; data: { disconnectedMs: number } };

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
  data: Partial<Pick<Bot, "enabled" | "dryRun" | "maxPositionUsd" | "maxLeverage" | "dailyLossLimitUsd">>,
) => req<Bot>(`/api/bots/${id}`, { method: "PATCH", body: JSON.stringify(data) });

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
