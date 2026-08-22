import { describe, it, expect, vi } from "vitest";
import { EventBus } from "../eventBus.js";
import type { BotEvent } from "../eventBus.js";
import { StorageMonitor } from "./storageMonitor.js";

// Minimal stub satisfying the Prisma calls getStorageStats makes — the real query behavior is
// already covered by dbStats.test.ts against a real sqlite DB; this file is purely about
// StorageMonitor's threshold/cooldown/publish logic.
function makeDb(overrides: Partial<{ candleCount: number; fundingCount: number }> = {}) {
  return {
    candle: {
      count: vi.fn().mockResolvedValue(overrides.candleCount ?? 0),
      aggregate: vi.fn().mockResolvedValue({ _min: { openTime: null }, _max: { openTime: null } }),
    },
    fundingRate: {
      count: vi.fn().mockResolvedValue(overrides.fundingCount ?? 0),
      aggregate: vi.fn().mockResolvedValue({ _min: { fundingTime: null }, _max: { fundingTime: null } }),
    },
  };
}

function collectEvents(bus: EventBus): BotEvent[] {
  const events: BotEvent[] = [];
  bus.on("event", (e: BotEvent) => events.push(e));
  return events;
}

describe("StorageMonitor", () => {
  it("publishes storage.critical when usage crosses the threshold", async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);

    // __filename is a real, small file on disk — with a 1-byte "volume" its statSync size
    // trivially clears any threshold, letting this test avoid spinning up a real sqlite DB just
    // to prove the threshold-crossing/publish wiring (that part is dbStats.test.ts's job).
    const monitor = new StorageMonitor(makeDb() as never, bus, __filename, 1, 0);
    await monitor.check();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "storage.critical" });
  });

  it("does not publish when usage is below the threshold", async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);

    const monitor = new StorageMonitor(makeDb() as never, bus, __filename, 1_000_000_000_000, 85);
    await monitor.check();

    expect(events).toHaveLength(0);
  });

  it("does not re-publish within the cooldown window while still critical", async () => {
    const bus = new EventBus();
    const events = collectEvents(bus);

    const monitor = new StorageMonitor(makeDb() as never, bus, __filename, 1, 0);
    await monitor.check();
    await monitor.check();
    await monitor.check();

    expect(events).toHaveLength(1);
  });

  it("re-publishes once the cooldown window has passed", async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const events = collectEvents(bus);

      const monitor = new StorageMonitor(makeDb() as never, bus, __filename, 1, 0);
      await monitor.check();
      expect(events).toHaveLength(1);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
      await monitor.check();
      expect(events).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("start() schedules periodic checks and stop() cancels them", async () => {
    vi.useFakeTimers();
    try {
      const bus = new EventBus();
      const events = collectEvents(bus);

      const monitor = new StorageMonitor(makeDb() as never, bus, __filename, 1, 0);
      monitor.start(1_000);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(events.length).toBeGreaterThanOrEqual(1);

      monitor.stop();
      const countAfterStop = events.length;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(events.length).toBe(countAfterStop); // no further ticks after stop()
    } finally {
      vi.useRealTimers();
    }
  });
});
