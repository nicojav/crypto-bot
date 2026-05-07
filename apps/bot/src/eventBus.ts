import { EventEmitter } from "node:events";

export type BotEvent =
  | { type: "signal.received"; data: { signalId: number; botId: number; action: string; symbol: string } }
  | { type: "trade.opened"; data: { tradeId: number; botId: number; symbol: string; side: string; qty: number; entryPrice: number } }
  | { type: "trade.closed"; data: { tradeId: number; botId: number; symbol: string; pnlUsd: number | null } }
  | { type: "balance.updated"; data: { equityUsd: number; availableUsd: number } };

export class EventBus extends EventEmitter {
  publish(event: BotEvent): void {
    this.emit("event", event);
  }
}
