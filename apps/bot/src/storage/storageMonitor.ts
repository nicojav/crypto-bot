import type { PrismaClient } from "../generated/prisma/client.js";
import type { EventBus } from "../eventBus.js";
import { getStorageStats } from "./dbStats.js";

// Once per notification, not per tick, while usage stays above the threshold — otherwise a
// long-running critical state would fire a Telegram message (and a dashboard WS event) every
// single tick. A process restart resets this in-memory cooldown; that's an acceptable minor gap
// (worst case: one extra notification sooner than the full cooldown), not silent data loss — the
// dashboard's Storage panel/banner reflect the true state continuously either way.
const NOTIFY_COOLDOWN_MS = 24 * 60 * 60 * 1000;

/**
 * Periodically checks total DB file size against the configured Railway Volume ceiling and
 * publishes a `storage.critical` event (picked up by notifications/notifier.ts for Telegram, and
 * broadcast to the dashboard over the existing WS pipe) once usage crosses the critical
 * threshold. Same start()/stop()/setInterval shape as SignalProcessor/Reconciler, including the
 * per-tick `.catch()` so one failed check never kills the timer.
 */
export class StorageMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastNotifiedAt: number | null = null;
  private stopping = false;

  constructor(
    private readonly db: PrismaClient,
    private readonly bus: EventBus,
    private readonly dbFilePath: string,
    private readonly volumeSizeBytes: number,
    private readonly criticalThresholdPct: number,
  ) {}

  start(intervalMs = 6 * 60 * 60 * 1000): void {
    this.stopping = false;
    this.timer = setInterval(() => {
      if (this.stopping) return;
      this.check().catch((err: unknown) => console.error("[storageMonitor] check failed:", err));
    }, intervalMs);
  }

  stop(): void {
    this.stopping = true;
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async check(): Promise<void> {
    const stats = await getStorageStats(this.db, this.dbFilePath, this.volumeSizeBytes, this.criticalThresholdPct);
    if (stats.percentUsed < stats.criticalThresholdPct) return;

    const now = Date.now();
    if (this.lastNotifiedAt !== null && now - this.lastNotifiedAt < NOTIFY_COOLDOWN_MS) return;
    this.lastNotifiedAt = now;

    this.bus.publish({
      type: "storage.critical",
      data: { dbSizeBytes: stats.dbSizeBytes, volumeSizeBytes: stats.volumeSizeBytes, percentUsed: stats.percentUsed },
    });
  }
}
