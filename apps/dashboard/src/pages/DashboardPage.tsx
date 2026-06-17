import { useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchBots, fetchSignals, patchBot, type Bot } from "../api/client";
import { BotCard } from "../components/BotCard";
import { CreateBotDialog } from "../components/CreateBotDialog";
import { EquityChart } from "../components/EquityChart";
import { EquityBreakdown } from "../components/EquityBreakdown";
import { OpenPositions } from "../components/OpenPositions";
import { SignalsTable } from "../components/SignalsTable";
import { TradesTable } from "../components/TradesTable";
import { useState } from "react";

export default function DashboardPage() {
  const qc = useQueryClient();
  const [createBotOpen, setCreateBotOpen] = useState(false);

  const { data: bots = [], isError: botsError, error: botsErrorMsg } = useQuery({
    queryKey: ["bots"],
    queryFn: fetchBots,
    staleTime: 30_000,
  });

  // Build a per-bot mismatch count from the global signals feed
  const { data: signals = [] } = useQuery({
    queryKey: ["signals"],
    queryFn: () => fetchSignals({ limit: 100 }),
    staleTime: 30_000,
  });

  const mismatchByBot = useMemo(() => {
    const map = new Map<number, number>();
    for (const s of signals) {
      if (s.status === "REJECTED" && s.rejectionReason && /symbol mismatch/i.test(s.rejectionReason)) {
        map.set(s.botId, (map.get(s.botId) ?? 0) + 1);
      }
    }
    return map;
  }, [signals]);

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
    <>
      <main className="max-w-[1440px] mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Bots */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h2 className="font-semibold text-text-1">Bots</h2>
            <div className="flex items-center gap-3">
              <span className="text-text-2 text-xs">{bots.length} configured</span>
              <button
                onClick={() => setCreateBotOpen(true)}
                className="text-xs font-medium px-3 py-1.5 rounded-lg bg-green text-white hover:bg-green-dim transition-colors"
              >
                + New Bot
              </button>
            </div>
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
                  mismatchCount={mismatchByBot.get(bot.id) ?? 0}
                  onToggle={(id, enabled) => toggleBot.mutate({ id, enabled })}
                  onToggleDryRun={(id, dryRun) => toggleDryRun.mutate({ id, dryRun })}
                />
              ))}
            </div>
          )}
        </section>

        {/* Equity chart */}
        <EquityBreakdown />
        <EquityChart />

        {/* Open positions (hidden when empty) */}
        <OpenPositions />

        {/* Signals + Trades */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <SignalsTable />
          <TradesTable />
        </div>
      </main>

      <CreateBotDialog
        open={createBotOpen}
        onClose={() => setCreateBotOpen(false)}
      />
    </>
  );
}
