// Ad-hoc CLI to run the real Strategy Finder search (searchCell) against cached candles for a
// hand-picked set of strategies, and print holdout Fit% side by side — without spinning up the
// dashboard, the worker pool, or an OptimizationRun row. Useful for a quick "does this strategy
// actually clear holdout" sanity check while developing, e.g. after adding a new strategy or
// changing the search budget.
//
// Requires the candles already be cached locally (via the dashboard's backtest date range, or
// `ensureCandles` some other way) — this reads directly from the Candle table and does not hit
// Bybit itself, so an uncached symbol/timeframe/range just comes back empty.
//
// Usage:
//   npx tsx src/scripts/compareStrategies.ts --symbols BTCUSDT,XRPUSDT --timeframe 15m \
//     --strategies sessionOrb,sessionVwapReversion,customMaCross,emaCrossTpSl [--walkForward 4]
import { prisma } from "../db.js";
import { searchCell, DEFAULT_SEARCH_OPTIONS, type SearchOptions } from "../backtest/search.js";
import { getStrategy, listStrategies } from "../backtest/strategies/index.js";
import type { Candle } from "../backtest/types.js";
import { TIMEFRAME_MS, type TimeframeId } from "../exchange/bybit.js";
import type { EngineConfig } from "../backtest/engine.js";

function parseArgs(argv: string[]): { symbols: string[]; timeframe: TimeframeId; strategyIds: string[]; walkForwardFolds?: number } {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key?.startsWith("--")) continue;
    flags.set(key.slice(2), argv[i + 1] ?? "");
  }

  const symbols = (flags.get("symbols") ?? "BTCUSDT").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const timeframe = (flags.get("timeframe") ?? "15m") as TimeframeId;
  if (!(timeframe in TIMEFRAME_MS)) throw new Error(`Unknown timeframe "${timeframe}" — expected one of ${Object.keys(TIMEFRAME_MS).join(", ")}`);

  const strategyIds = flags.has("strategies")
    ? flags.get("strategies")!.split(",").map((s) => s.trim()).filter(Boolean)
    : listStrategies().map((s) => s.id);
  for (const id of strategyIds) if (!getStrategy(id)) throw new Error(`Unknown strategy "${id}"`);

  const walkForwardRaw = flags.get("walkForward");
  const walkForwardFolds = walkForwardRaw ? Number(walkForwardRaw) : undefined;

  return { symbols, timeframe, strategyIds, walkForwardFolds };
}

async function loadCandles(symbol: string, timeframe: TimeframeId): Promise<Candle[]> {
  const rows = await prisma.candle.findMany({ where: { symbol, timeframe }, orderBy: { openTime: "asc" } });
  return rows.map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume }));
}

const ENGINE: EngineConfig = {
  initialCapital: 10_000,
  maxPositionUsd: 1_000,
  leverage: 5,
  feeBps: 5.5,
  entryFeeBps: 2, // assumes a limit-order entry (ORB retest, VWAP fade) at the Bybit maker rate
  slippageBps: 2,
  fillModel: "signalClose",
  lotSize: 0.001,
  tickSize: 0.01,
};

async function run() {
  const { symbols, timeframe, strategyIds, walkForwardFolds } = parseArgs(process.argv.slice(2));
  const opts: SearchOptions = { ...DEFAULT_SEARCH_OPTIONS, ...(walkForwardFolds ? { walkForward: { folds: walkForwardFolds } } : {}) };

  for (const symbol of symbols) {
    const candles = await loadCandles(symbol, timeframe);
    if (candles.length === 0) {
      console.log(`\n=== ${symbol} ${timeframe} — no cached candles, skipping ===`);
      continue;
    }
    console.log(
      `\n=== ${symbol} ${timeframe} — ${candles.length} candles ` +
      `(${new Date(candles[0]!.openTime).toISOString()} -> ${new Date(candles[candles.length - 1]!.openTime).toISOString()}) ===`,
    );

    for (const strategyId of strategyIds) {
      const strategy = getStrategy(strategyId)!;
      const results = await searchCell(strategy, candles, timeframe, ENGINE, opts);

      if (results.length === 0) {
        console.log(`  ${strategyId}: no qualifying config (not enough trades in one of train/validate/holdout to trust)`);
        continue;
      }
      const top = results[0]!;
      const fitPct = top.holdoutRatio * 100;
      console.log(
        `  ${strategyId}: train ${top.trainStats.totalPnlPct.toFixed(1)}% | validate ${top.validateStats.totalPnlPct.toFixed(1)}% | ` +
        `holdout ${top.holdoutStats.totalPnlPct.toFixed(1)}% | fit ${fitPct.toFixed(0)}% | trades(holdout) ${top.holdoutStats.totalTrades} | ` +
        `grossPnl/trade ${top.holdoutStats.avgGrossPnlPct.toFixed(3)}% | cost/trade ${top.holdoutStats.avgCostPct.toFixed(3)}%`,
      );
    }
  }
  await prisma.$disconnect();
}

run().catch((err) => { console.error(err); process.exit(1); });
