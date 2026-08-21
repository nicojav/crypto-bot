import type { EventBus, BotEvent } from "../eventBus.js";
import type { PrismaClient } from "../generated/prisma/client.js";
import { env } from "../env.js";

export class Notifier {
  private summaryTimer: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly bus: EventBus,
    private readonly db: PrismaClient,
  ) {
    this.enabled = env.TELEGRAM_BOT_TOKEN.length > 0 && env.TELEGRAM_CHAT_ID.length > 0;
  }

  start(): void {
    if (!this.enabled) {
      console.log("[notifier] TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID not set — notifications disabled");
      return;
    }
    this.bus.on("event", (event: BotEvent) => void this.handleEvent(event));
    this.scheduleDailySummary();
    console.log("[notifier] Telegram notifications enabled");
  }

  stop(): void {
    if (this.summaryTimer !== null) {
      clearTimeout(this.summaryTimer as ReturnType<typeof setTimeout>);
      this.summaryTimer = null;
    }
  }

  private async handleEvent(event: BotEvent): Promise<void> {
    switch (event.type) {
      case "trade.opened": {
        const { symbol, side, qty, entryPrice } = event.data;
        await this.send(`📈 Trade opened\n${side} ${qty} ${symbol} @ ${entryPrice.toFixed(2)} USDT`);
        break;
      }
      case "trade.closed": {
        const { symbol, pnlUsd } = event.data;
        const pnlStr = pnlUsd != null
          ? `PnL: ${pnlUsd >= 0 ? "+" : ""}${pnlUsd.toFixed(2)} USDT`
          : "PnL: unknown";
        const icon = (pnlUsd ?? 0) >= 0 ? "✅" : "❌";
        await this.send(`${icon} Trade closed\n${symbol} — ${pnlStr}`);
        break;
      }
      case "signal.rejected": {
        const { signalId, reason } = event.data;
        const isKillSwitch = reason.includes("disabled") || reason.includes("kill switch");
        const isLossLimit = reason.includes("Daily loss limit");
        if (isKillSwitch) {
          await this.send(`🔴 Kill switch active\nSignal #${signalId} rejected: ${reason}`);
        } else if (isLossLimit) {
          await this.send(`⚠️ Daily loss limit hit\nSignal #${signalId} rejected: ${reason}`);
        } else {
          await this.send(`⚠️ Signal #${signalId} rejected\n${reason}`);
        }
        break;
      }
      case "ws.reconnected": {
        const secs = Math.round(event.data.disconnectedMs / 1000);
        if (secs >= 30) {
          await this.send(`🔌 WebSocket reconnected after ${secs}s disconnection`);
        }
        break;
      }
      case "storage.critical": {
        const { dbSizeBytes, volumeSizeBytes, percentUsed } = event.data;
        const gb = (n: number) => (n / 1_073_741_824).toFixed(2);
        await this.send(
          `⚠️ Database storage critical\n${gb(dbSizeBytes)} GB / ${gb(volumeSizeBytes)} GB (${percentUsed.toFixed(1)}%) — review the dashboard's Storage panel to prune old backtest candle data.`
        );
        break;
      }
    }
  }

  private scheduleDailySummary(): void {
    const now = new Date();
    const next = new Date(now);
    next.setUTCHours(env.DAILY_SUMMARY_HOUR_UTC, 0, 0, 0);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    const delay = next.getTime() - now.getTime();

    this.summaryTimer = setTimeout(() => {
      void this.sendDailySummary();
      this.summaryTimer = setInterval(() => void this.sendDailySummary(), 24 * 60 * 60 * 1000);
    }, delay);
  }

  private async sendDailySummary(): Promise<void> {
    const startOfDay = new Date();
    startOfDay.setUTCHours(0, 0, 0, 0);

    const trades = await this.db.trade.findMany({
      where: { status: "CLOSED", closedAt: { gte: startOfDay } },
    });

    const totalTrades = trades.length;
    const wins = trades.filter((t) => (t.pnlUsd ?? 0) > 0).length;
    const totalPnl = trades.reduce((sum, t) => sum + (t.pnlUsd ?? 0), 0);
    const winRate = totalTrades > 0 ? `${((wins / totalTrades) * 100).toFixed(1)}%` : "—";

    const latest = await this.db.balanceSnapshot.findFirst({ orderBy: { takenAt: "desc" } });
    const equity = latest != null ? `${latest.equityUsd.toFixed(2)} USDT` : "—";

    const pnlSign = totalPnl >= 0 ? "+" : "";
    const lines = [
      "📊 Daily Summary",
      `Trades today: ${totalTrades} (Win rate: ${winRate})`,
      `PnL: ${pnlSign}${totalPnl.toFixed(2)} USDT`,
      `Current equity: ${equity}`,
    ];
    await this.send(lines.join("\n"));
  }

  private async send(text: string): Promise<void> {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
      });
      if (!res.ok) {
        const body = await res.text();
        console.error(`[notifier] Telegram error ${res.status}: ${body}`);
      }
    } catch (err) {
      console.error("[notifier] send failed:", err);
    }
  }
}
