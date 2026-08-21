import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Vitest's default "threads" pool runs each test file inside a worker_thread. Any test that
    // registers backtestRoutes.ts's plugin transitively imports workerPool.ts, which spawns real
    // worker_threads of its own (see engine.ts's worker-pool backtest execution) — nesting
    // worker_threads combined with better-sqlite3 (a native addon) reliably hangs the process on
    // exit after a DB query runs, even though the query itself succeeds and the app has zero
    // actual lingering handles (confirmed via a standalone, non-vitest repro). Forks (child
    // processes) sidestep the nested-worker-thread case entirely.
    pool: "forks",
  },
});
