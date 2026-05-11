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
  exitPrice: number | null;
  pnlUsd: number | null;
  status: string;
  openedAt: string;
  closedAt: string | null;
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
  | { type: "balance.updated"; data: { equityUsd: number; availableUsd: number } };

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

export const fetchSignals = (params?: { botId?: number; limit?: number }) => {
  const q = new URLSearchParams();
  if (params?.botId !== undefined) q.set("botId", String(params.botId));
  q.set("limit", String(params?.limit ?? 50));
  return req<Signal[]>(`/api/signals?${q}`);
};

export const postKillSwitch = () =>
  req<{ disabled: number }>("/api/kill-switch", { method: "POST" });
