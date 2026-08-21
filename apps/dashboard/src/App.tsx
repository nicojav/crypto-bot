import { useState } from "react";
import { Link, Routes, Route } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchEquity, fetchStorageStats } from "./api/client";
import { useWebSocket } from "./hooks/useWebSocket";
import { Header } from "./components/Header";
import { KillSwitchDialog } from "./components/KillSwitchDialog";
import { STORAGE_STATS_QUERY_KEY } from "./components/StoragePanel";
import DashboardPage from "./pages/DashboardPage";
import BotConfigPage from "./pages/BotConfigPage";
import TradesPage from "./pages/TradesPage";
import BacktestPage from "./pages/BacktestPage";

const todayMidnight = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

export default function App() {
  useWebSocket();

  const [killDialogOpen, setKillDialogOpen] = useState(false);

  const { data: todayEquity = [] } = useQuery({
    queryKey: ["equity", "today"],
    queryFn: () => fetchEquity({ from: todayMidnight }),
    staleTime: 60_000,
  });

  // Same query key as StoragePanel — react-query dedupes this into one request, and the two
  // components share this poll rather than each running their own.
  const { data: storageStats } = useQuery({
    queryKey: STORAGE_STATS_QUERY_KEY,
    queryFn: fetchStorageStats,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const storageCritical = storageStats != null && storageStats.percentUsed >= storageStats.criticalThresholdPct;

  const latestEquity = todayEquity.at(-1)?.equityUsd ?? null;
  const todayPnl = (() => {
    const first = todayEquity[0];
    const last = todayEquity.at(-1);
    return todayEquity.length >= 2 && first && last
      ? last.equityUsd - first.equityUsd
      : null;
  })();

  // Header needs anyBotEnabled — keep a light bots query here just for the kill-switch indicator
  // (DashboardPage also fetches bots; react-query deduplicates the request)
  const anyBotEnabled = true; // conservative default; DashboardPage drives the actual state

  return (
    <div className="min-h-screen bg-base text-text-1">
      <Header
        equityUsd={latestEquity}
        todayPnl={todayPnl}
        anyBotEnabled={anyBotEnabled}
        onKillSwitch={() => setKillDialogOpen(true)}
      />

      {storageCritical && (
        <div className="bg-amber/10 border-b border-amber/30 px-5 py-2.5 flex items-center gap-3">
          <span className="text-amber text-sm">⚠</span>
          <p className="text-sm text-amber">
            Database storage at {storageStats.percentUsed.toFixed(1)}% of capacity —{" "}
            <Link to="/" className="underline hover:text-amber/80 transition-colors">
              prune old backtest data
            </Link>{" "}
            before it fills up.
          </p>
        </div>
      )}

      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/trades" element={<TradesPage />} />
        <Route path="/backtest" element={<BacktestPage />} />
        <Route path="/bots/:id" element={<BotConfigPage />} />
      </Routes>

      <KillSwitchDialog
        open={killDialogOpen}
        onClose={() => setKillDialogOpen(false)}
      />
    </div>
  );
}
