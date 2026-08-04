import { useState } from "react";
import { Link } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { runBacktest, type BacktestRunResult } from "../api/client";
import { BacktestConfig, type BacktestRunConfig } from "../components/backtest/BacktestConfig";
import { BacktestKeyStats } from "../components/backtest/BacktestKeyStats";
import { BacktestEquityChart } from "../components/backtest/BacktestEquityChart";
import { BacktestTradesTable } from "../components/backtest/BacktestTradesTable";
import { BacktestAnalysis } from "../components/backtest/BacktestAnalysis";
import { BacktestChart } from "../components/backtest/BacktestChart";

type Tab = "performance" | "trades" | "analysis" | "chart";
const TABS: { key: Tab; label: string }[] = [
  { key: "performance", label: "Performance" },
  { key: "trades", label: "List of trades" },
  { key: "analysis", label: "Trades analysis" },
  { key: "chart", label: "Chart" },
];

export default function BacktestPage() {
  const [tab, setTab] = useState<Tab>("performance");
  const [lastConfig, setLastConfig] = useState<BacktestRunConfig | null>(null);
  const [result, setResult] = useState<BacktestRunResult | null>(null);

  const mutation = useMutation({
    mutationFn: runBacktest,
    onSuccess: setResult,
  });

  function handleRun(config: BacktestRunConfig) {
    setLastConfig(config);
    mutation.mutate(config);
  }

  return (
    <main className="max-w-[1440px] mx-auto px-6 py-6 space-y-4">
      <div className="flex items-center gap-3">
        <Link to="/" className="text-text-3 hover:text-text-1 transition-colors text-sm">← Dashboard</Link>
        <h1 className="font-semibold text-lg text-text-1">Backtest</h1>
      </div>

      <BacktestConfig onRun={handleRun} isRunning={mutation.isPending} />

      {mutation.isError && (
        <div className="bg-red/10 border border-red/20 rounded-xl px-4 py-3 text-sm text-red">
          {(mutation.error as Error).message}
        </div>
      )}

      {result && lastConfig && (
        <>
          <BacktestKeyStats stats={result.stats} />

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
        </>
      )}

      {!result && !mutation.isPending && (
        <div className="bg-card border border-border rounded-[14px] p-10 text-center text-text-3 text-sm">
          Configure a strategy above and run a backtest to see results.
        </div>
      )}
    </main>
  );
}
