import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchBots, fetchEquity, patchBot, type Bot } from "./api/client";
import { useWebSocket } from "./hooks/useWebSocket";
import { Header } from "./components/Header";
import { BotCard } from "./components/BotCard";
import { KillSwitchDialog } from "./components/KillSwitchDialog";
import { EditBotDialog } from "./components/EditBotDialog";
import { EquityChart } from "./components/EquityChart";
import { SignalsTable } from "./components/SignalsTable";
import { TradesTable } from "./components/TradesTable";

const todayMidnight = new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

export default function App() {
  useWebSocket();

  const qc = useQueryClient();
  const [killDialogOpen, setKillDialogOpen] = useState(false);
  const [editBot, setEditBot] = useState<Bot | null>(null);

  const { data: bots = [], isError: botsError, error: botsErrorMsg } = useQuery({
    queryKey: ["bots"],
    queryFn: fetchBots,
    staleTime: 30_000,
  });

  const { data: todayEquity = [] } = useQuery({
    queryKey: ["equity", "today"],
    queryFn: () => fetchEquity({ from: todayMidnight }),
    staleTime: 60_000,
  });

  const latestEquity = todayEquity.at(-1)?.equityUsd ?? null;
  const todayPnl = (() => {
    const first = todayEquity[0];
    const last = todayEquity.at(-1);
    return todayEquity.length >= 2 && first && last
      ? last.equityUsd - first.equityUsd
      : null;
  })();

  const anyBotEnabled = bots.some((b) => b.enabled);

  const toggleBot = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      patchBot(id, { enabled }),
    onMutate: async ({ id, enabled }) => {
      await qc.cancelQueries({ queryKey: ["bots"] });
      const prev = qc.getQueryData<Bot[]>(["bots"]);
      qc.setQueryData<Bot[]>(["bots"], (old) =>
        old?.map((b) => (b.id === id ? { ...b, enabled } : b)) ?? [],
      );
      return { prev };
    },
    onError: (_err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["bots"], ctx.prev);
      toast.error("Failed to update bot");
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["bots"] }); },
  });

  const toggleDryRun = useMutation({
    mutationFn: ({ id, dryRun }: { id: number; dryRun: boolean }) =>
      patchBot(id, { dryRun }),
    onMutate: async ({ id, dryRun }) => {
      await qc.cancelQueries({ queryKey: ["bots"] });
      const prev = qc.getQueryData<Bot[]>(["bots"]);
      qc.setQueryData<Bot[]>(["bots"], (old) =>
        old?.map((b) => (b.id === id ? { ...b, dryRun } : b)) ?? [],
      );
      return { prev };
    },
    onError: (_err: Error, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(["bots"], ctx.prev);
      toast.error("Failed to update bot");
    },
    onSettled: () => { void qc.invalidateQueries({ queryKey: ["bots"] }); },
  });

  return (
    <div className="min-h-screen bg-base text-text-1">
      <Header
        equityUsd={latestEquity}
        todayPnl={todayPnl}
        anyBotEnabled={anyBotEnabled}
        onKillSwitch={() => setKillDialogOpen(true)}
      />

      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Bots */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-text-1">Bots</h2>
            <span className="text-text-2 text-xs">{bots.length} configured</span>
          </div>
          {botsError ? (
            <div className="bg-card border border-red/20 rounded-[14px] p-6 text-red text-sm text-center">
              {(botsErrorMsg as Error)?.message ?? "Failed to load bots"} — is the bot server running?
            </div>
          ) : bots.length === 0 ? (
            <div className="bg-card border border-border rounded-[14px] p-6 text-text-3 text-sm text-center">
              No bots configured
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
              {bots.map((bot) => (
                <BotCard
                  key={bot.id}
                  bot={bot}
                  onToggle={(id, enabled) => toggleBot.mutate({ id, enabled })}
                  onToggleDryRun={(id, dryRun) => toggleDryRun.mutate({ id, dryRun })}
                  onEdit={setEditBot}
                />
              ))}
            </div>
          )}
        </section>

        {/* Equity chart */}
        <EquityChart />

        {/* Signals + Trades */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SignalsTable />
          <TradesTable />
        </div>
      </main>

      <KillSwitchDialog
        open={killDialogOpen}
        onClose={() => setKillDialogOpen(false)}
      />

      {editBot && (
        <EditBotDialog
          bot={editBot}
          onClose={() => setEditBot(null)}
        />
      )}
    </div>
  );
}
