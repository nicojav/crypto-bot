import { useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";

import { runBacktest, type BacktestRunResult } from "../api/client";
import { BacktestConfig, type BacktestRunConfig, type BacktestConfigPrefill } from "../components/backtest/BacktestConfig";
import { BacktestKeyStats } from "../components/backtest/BacktestKeyStats";
import { BacktestComparisonNotes } from "../components/backtest/BacktestComparisonNotes";
import { BacktestEquityChart } from "../components/backtest/BacktestEquityChart";
import { BacktestTradesTable } from "../components/backtest/BacktestTradesTable";
import { BacktestAnalysis } from "../components/backtest/BacktestAnalysis";
import { BacktestChart } from "../components/backtest/BacktestChart";
import { StrategyFinderPanel, type LoadIntoBacktestPayload } from "../components/backtest/StrategyFinderPanel";

type Tab = "performance" | "trades" | "analysis" | "chart";
const TABS: { key: Tab; label: string }[] = [
  { key: "performance", label: "Performance" },
  { key: "trades", label: "List of trades" },
  { key: "analysis", label: "Trades analysis" },
  { key: "chart", label: "Chart" },
];

type Mode = "single" | "finder";
const MODES: { key: Mode; label: string }[] = [
  { key: "single", label: "Single backtest" },
  { key: "finder", label: "Strategy Finder" },
];

// Survives an accidental refresh — this is a convenience for the current session, not a history
// (Strategy Finder already has full server-side persistence for that use case via
// OptimizationRun). localStorage rather than a backend table since there's nothing here worth
// keeping past the browser being cleared.
const STORAGE_KEY = "backtest:lastRun";

function loadPersisted(): { config: BacktestRunConfig; result: BacktestRunResult } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { config: BacktestRunConfig; result: BacktestRunResult };
    if (!parsed.config || !parsed.result) return null;
    return parsed;
  } catch {
    return null; // corrupt/foreign data in the slot — ignore rather than crash the page
  }
}

export default function BacktestPage() {
  const [mode, setMode] = useState<Mode>("single");
  const [tab, setTab] = useState<Tab>("performance");
  const persisted = useRef(loadPersisted()).current; // read once, before first paint — not a live subscription
  const [lastConfig, setLastConfig] = useState<BacktestRunConfig | null>(persisted?.config ?? null);
  const [result, setResult] = useState<BacktestRunResult | null>(persisted?.result ?? null);
  const [prefill, setPrefill] = useState<BacktestConfigPrefill | null>(null);
  // Monotonic id for "load these params into the form" requests — doesn't need to trigger
  // its own render, only `prefill` does, so a ref (not state) is the right tool here.
  const prefillTokenRef = useRef(0);

  const mutation = useMutation({
    mutationFn: runBacktest,
    onSuccess: (data, config) => {
      setResult(data);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ config, result: data }));
      } catch {
        // storage full/unavailable (private browsing) — the run still succeeded, just won't survive a refresh
      }
    },
  });

  function handleRun(config: BacktestRunConfig) {
    setLastConfig(config);
    mutation.mutate(config);
  }

  function handleLoadIntoBacktest(payload: LoadIntoBacktestPayload) {
    prefillTokenRef.current += 1;
    setPrefill({ ...payload, token: prefillTokenRef.current });
    setMode("single");
  }

  return (
    <main className="max-w-[1440px] mx-auto px-6 py-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-text-3 hover:text-text-1 transition-colors text-sm">← Dashboard</Link>
        <h1 className="font-semibold text-lg text-text-1">Backtest</h1>
      </div>

      <div className="flex items-center gap-1 bg-surface rounded-lg p-1 w-fit">
        {MODES.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setMode(key)}
            className={[
              "px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors",
              mode === key ? "bg-card text-text-1 shadow-sm" : "text-text-2 hover:text-text-1",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === "finder" && <StrategyFinderPanel onLoadIntoBacktest={handleLoadIntoBacktest} />}

      {mode === "single" && (
        <>
          <BacktestConfig onRun={handleRun} isRunning={mutation.isPending} prefill={prefill} />

          {mutation.isError && (
            <div className="bg-red/10 border border-red/20 rounded-xl px-4 py-3 text-sm text-red">
              {(mutation.error).message}
            </div>
          )}

          {result && lastConfig && (
            <div className="relative">
              <div className={`space-y-4 transition-opacity ${mutation.isPending ? "opacity-40 pointer-events-none" : ""}`}>
                <BacktestKeyStats stats={result.stats} />
                <BacktestComparisonNotes result={result} />

                <div className="flex items-center gap-1 bg-surface rounded-lg p-1 w-fit">
                  {TABS.map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setTab(key)}
                      className={[
                        "px-3.5 py-1.5 text-xs font-medium rounded-md transition-colors",
                        tab === key ? "bg-card text-text-1 shadow-sm" : "text-text-2 hover:text-text-1",
                      ].join(" ")}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {tab === "performance" && (
                  <BacktestEquityChart equityCurve={result.equityCurve} buyHoldCurve={result.buyHoldCurve} />
                )}
                {tab === "trades" && <BacktestTradesTable trades={result.trades} />}
                {tab === "analysis" && <BacktestAnalysis stats={result.stats} />}
                {tab === "chart" && (
                  <BacktestChart
                    symbol={lastConfig.symbol}
                    timeframe={lastConfig.timeframe}
                    from={lastConfig.from}
                    to={lastConfig.to}
                    markers={result.markers}
                  />
                )}
              </div>

              {mutation.isPending && (
                <div className="absolute inset-0 flex items-start justify-center pt-16">
                  <div className="flex items-center gap-2.5 bg-card border border-border rounded-xl px-4 py-2.5 shadow-xl">
                    <Spinner />
                    <span className="text-sm text-text-2">Running backtest…</span>
                  </div>
                </div>
              )}
            </div>
          )}

          {!result && mutation.isPending && (
            <div className="bg-card border border-border rounded-[14px] p-10 flex flex-col items-center justify-center gap-3 text-text-3 text-sm">
              <Spinner />
              Running backtest — downloading candles and simulating trades…
            </div>
          )}

          {!result && !mutation.isPending && (
            <div className="bg-card border border-border rounded-[14px] p-10 text-center text-text-3 text-sm">
              Configure a strategy above and run a backtest to see results.
            </div>
          )}
        </>
      )}
    </main>
  );
}

function Spinner() {
  return <div className="w-5 h-5 border-2 border-border border-t-green rounded-full animate-spin shrink-0" />;
}
