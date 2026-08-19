import { parentPort } from "node:worker_threads";

import { getStrategy } from "./strategies/index.js";
import { runOneBacktest } from "./optimizer.js";
import { scoreResult } from "./scoring.js";
import { unpackCandles } from "./candleBuffer.js";
import type { Candle } from "./types.js";
import type { TaskMessage, ResultMessage } from "./workerProtocol.js";

if (!parentPort) throw new Error("backtestWorker.ts must be run inside a worker_thread");
const port = parentPort;

// Reconstructed Candle[] cached per cellId — see workerProtocol.ts's BaseTask.cellId. workerPool
// creates a fresh pool (and so a fresh worker, and so a fresh cache) per operation (one /run
// request, one /optimize sweep, one Strategy Finder run), so this never accumulates across
// unrelated requests.
const candleCache = new Map<string, Candle[]>();

function getCandles(task: TaskMessage): Candle[] {
  let candles = candleCache.get(task.cellId);
  if (!candles) {
    candles = unpackCandles(task.shared);
    candleCache.set(task.cellId, candles);
  }
  return candles;
}

port.on("message", (task: TaskMessage) => {
  try {
    const strategy = getStrategy(task.strategyId);
    if (!strategy) throw new Error(`Unknown strategy: ${task.strategyId}`);

    const candles = getCandles(task);
    const { trades, equityCurve, buyHoldCurve, stats } = runOneBacktest(strategy, candles, task.params, task.engineConfig);

    let result: ResultMessage;
    if (task.kind === "full") {
      result = { kind: "full", taskId: task.taskId, trades, equityCurve, buyHoldCurve, stats };
    } else if (task.kind === "stats") {
      result = { kind: "stats", taskId: task.taskId, stats };
    } else {
      const score = scoreResult({ stats, equityCurve }, task.timeframe, task.weights);
      result = { kind: "score", taskId: task.taskId, score, stats };
    }
    port.postMessage(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    port.postMessage({ kind: "error", taskId: task.taskId, message } satisfies ResultMessage);
  }
});
