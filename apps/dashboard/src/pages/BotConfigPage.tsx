import { useState, useEffect, useCallback } from "react";
import { useParams, Link, useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchBot, patchBot, testSignal } from "../api/client";
import { Field } from "../components/ui/Field";
import { Switch } from "../components/ui/Switch";
import { friendlyReason } from "../utils/rejectionSummary";

// The bot's own public URL, for the webhook TradingView alerts POST to — see BotCard.tsx's
// identical constant for why this is intentionally a separate env var from api/client.ts's BASE.
const API_URL = (import.meta.env.VITE_WEBHOOK_BASE_URL as string | undefined) ?? "http://localhost:3000";

const fmtTime = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

const STATUS_STYLE: Record<string, string> = {
  EXECUTED: "bg-green/10 text-green",
  REJECTED:  "bg-red/10 text-red",
  DUPLICATE: "bg-surface text-text-3",
  PENDING:   "bg-amber/10 text-amber",
};

const ACTION_COLOR: Record<string, string> = {
  BUY:   "text-green",
  SELL:  "text-red",
  CLOSE: "text-amber",
};

export default function BotConfigPage() {
  const { id } = useParams<{ id: string }>();
  const botId = Number(id);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: bot, isLoading, isError } = useQuery({
    queryKey: ["bot", botId],
    queryFn: () => fetchBot(botId),
    enabled: !isNaN(botId),
    staleTime: 15_000,
  });

  const [expandedSignals, setExpandedSignals] = useState<Set<number>>(new Set());
  function toggleSignal(sigId: number) {
    setExpandedSignals((prev) => {
      const next = new Set(prev);
      next.has(sigId) ? next.delete(sigId) : next.add(sigId);
      return next;
    });
  }

  const [simulateTpSlError, setSimulateTpSlError] = useState(false);

  const sendTestSignal = useMutation({
    mutationFn: (action: "BUY" | "SELL") => testSignal(botId, action, simulateTpSlError),
    onSuccess: (data) => {
      void qc.invalidateQueries({ queryKey: ["signals"] });
      void qc.invalidateQueries({ queryKey: ["bot", botId] });
      toast.success(`Signal #${data.signalId} queued — check the signals feed`);
    },
    onError: (err: Error) => { toast.error(err.message); },
  });

  // Identity fields
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  // Risk fields
  const [maxPosition, setMaxPosition] = useState("");
  const [maxLeverage, setMaxLeverage] = useState("");
  const [dailyLossLimit, setDailyLossLimit] = useState("");

  useEffect(() => {
    if (!bot) return;
    setName(bot.name);
    setSymbol(bot.symbol);
    setMaxPosition(String(bot.maxPositionUsd));
    setMaxLeverage(String(bot.maxLeverage));
    setDailyLossLimit(String(bot.dailyLossLimitUsd));
  }, [bot]);

  // Webhook copy
  const webhookUrl = `${API_URL}/webhook/${botId}`;
  const [copied, setCopied] = useState(false);
  const copyWebhook = useCallback(() => {
    void navigator.clipboard.writeText(webhookUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [webhookUrl]);

  const hasOpenPositions = (bot?.openTradeCount ?? 0) > 0;
  const symbolChanged = bot && symbol.toUpperCase() !== bot.symbol;
  const identityDirty = bot && (name !== bot.name || symbolChanged);
  const identityValid = name.trim().length > 0 && symbol.trim().length > 0;

  const riskValid =
    !isNaN(parseFloat(maxPosition)) && parseFloat(maxPosition) > 0 &&
    !isNaN(parseInt(maxLeverage, 10)) && parseInt(maxLeverage, 10) >= 1 &&
    !isNaN(parseFloat(dailyLossLimit));

  const saveIdentity = useMutation({
    mutationFn: () => patchBot(botId, { name: name.trim(), symbol: symbol.toUpperCase() }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      void qc.invalidateQueries({ queryKey: ["bot", botId] });
      toast.success("Bot identity updated");
    },
    onError: (err: Error) => { toast.error(err.message); },
  });

  const saveRisk = useMutation({
    mutationFn: () => patchBot(botId, {
      maxPositionUsd: parseFloat(maxPosition),
      maxLeverage: parseInt(maxLeverage, 10),
      dailyLossLimitUsd: parseFloat(dailyLossLimit),
    }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      void qc.invalidateQueries({ queryKey: ["bot", botId] });
      toast.success("Risk limits updated");
    },
    onError: (err: Error) => { toast.error(err.message); },
  });

  const toggleEnabled = useMutation({
    mutationFn: (enabled: boolean) => patchBot(botId, { enabled }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      void qc.invalidateQueries({ queryKey: ["bot", botId] });
    },
    onError: (err: Error) => { toast.error(err.message); },
  });

  const toggleDryRun = useMutation({
    mutationFn: (dryRun: boolean) => patchBot(botId, { dryRun }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      void qc.invalidateQueries({ queryKey: ["bot", botId] });
    },
    onError: (err: Error) => { toast.error(err.message); },
  });

  if (isLoading) {
    return (
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="text-text-3 text-sm">Loading…</div>
      </main>
    );
  }

  if (isError || !bot) {
    return (
      <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        <div className="bg-card border border-red/20 rounded-[14px] p-6 text-red text-sm text-center">
          Bot not found.{" "}
          <button onClick={() => navigate("/")} className="underline">Go back</button>
        </div>
      </main>
    );
  }

  // Per-bot mismatch count from its own signal history
  const mismatchSignals = bot.signals.filter(
    (s) => s.status === "REJECTED" && s.rejectionReason && /symbol mismatch/i.test(s.rejectionReason)
  );

  return (
    <main className="max-w-3xl mx-auto px-4 sm:px-6 py-8 space-y-5">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Link to="/" className="text-text-3 hover:text-text-1 text-sm transition-colors">← Bots</Link>
        <span className="text-text-3 text-sm">/</span>
        <div className="flex items-center gap-2">
          <div className={`w-2 h-2 rounded-full ${bot.enabled ? "bg-green" : "bg-text-3"}`} />
          <span className="text-sm font-semibold text-text-1">{bot.name}</span>
          <span className="font-mono text-xs text-text-3">#{bot.id}</span>
        </div>
      </div>

      {/* Mismatch banner */}
      {mismatchSignals.length > 0 && (
        <div className="bg-amber/10 border border-amber/30 rounded-[14px] px-5 py-3 flex items-start gap-3">
          <span className="text-amber text-sm mt-0.5">⚠</span>
          <div>
            <p className="text-sm font-medium text-amber">
              {mismatchSignals.length} signal{mismatchSignals.length > 1 ? "s" : ""} rejected — symbol mismatch
            </p>
            <p className="text-xs text-text-2 mt-0.5">
              A TradingView alert is sending <strong>{mismatchSignals[0]?.rejectionReason?.match(/signal (\S+)/)?.[1] ?? "a different symbol"}</strong> to this bot, which expects <strong>{bot.symbol}</strong>. Fix the webhook URL in TradingView or update the symbol below.
            </p>
          </div>
        </div>
      )}

      {/* Identity */}
      <section className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-1">Identity</h3>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <Field label="Bot name" value={name} onChange={setName} placeholder="e.g. SOLUSDT Bot" />
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-text-2">Symbol</label>
              {hasOpenPositions && (
                <span className="text-xs text-amber font-mono">Close open positions to change</span>
              )}
            </div>
            <input
              type="text"
              value={symbol}
              onChange={(e) => setSymbol(e.target.value.toUpperCase())}
              disabled={hasOpenPositions}
              placeholder="e.g. SOLUSDT"
              className="bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => saveIdentity.mutate()}
              disabled={!identityDirty || !identityValid || saveIdentity.isPending}
              className="px-4 py-2.5 rounded-xl bg-green text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-dim transition-colors"
            >
              {saveIdentity.isPending ? "Saving…" : "Save identity"}
            </button>
          </div>
        </div>
      </section>

      {/* Webhook */}
      <section className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-1">Webhook</h3>
        </div>
        <div className="px-5 py-4 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 font-mono text-xs text-text-2 bg-surface border border-border rounded-xl px-4 py-2.5 select-all overflow-x-auto whitespace-nowrap">
              {webhookUrl}
            </span>
            <button
              onClick={copyWebhook}
              aria-label="Copy webhook URL"
              className="shrink-0 w-9 h-9 rounded-xl flex items-center justify-center bg-surface border border-border text-text-3 hover:text-text-1 hover:border-border-bright transition-colors"
            >
              {copied ? (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <path d="M2 7.5l3.5 3.5 6.5-7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              ) : (
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                  <rect x="5" y="1" width="8" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M1 5h4M1 5v7a1.5 1.5 0 001.5 1.5H9v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                </svg>
              )}
            </button>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-green">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M2 6.5l2.5 2.5 5.5-5.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            accepts <strong className="font-mono ml-0.5">{bot.symbol}</strong> signals only
          </div>
          <p className="text-xs text-text-3">
            Paste this URL into your TradingView alert's Webhook URL field. Signals with a different symbol will be rejected.
          </p>
        </div>
      </section>

      {/* Testing */}
      <section className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-1">Testing</h3>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <span className="text-sm text-text-2">Simulate TP/SL error</span>
              <p className="text-xs text-text-3 mt-0.5">
                Uses extreme TP/SL offsets to trigger Bybit's price-band check (30208/10001)
                and verify the naked-entry fallback fires.
                {bot.dryRun && (
                  <span className="text-amber"> dryRun is ON — fallback won't fire (Bybit is not called in dryRun).</span>
                )}
              </p>
            </div>
            <Switch checked={simulateTpSlError} onChange={setSimulateTpSlError} colorOn="amber" />
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => sendTestSignal.mutate("BUY")}
              disabled={sendTestSignal.isPending}
              className="flex-1 py-2 rounded-xl bg-green/10 border border-green/30 text-green text-sm font-medium hover:bg-green/20 disabled:opacity-40 transition-colors"
            >
              Test BUY
            </button>
            <button
              onClick={() => sendTestSignal.mutate("SELL")}
              disabled={sendTestSignal.isPending}
              className="flex-1 py-2 rounded-xl bg-red/10 border border-red/30 text-red text-sm font-medium hover:bg-red/20 disabled:opacity-40 transition-colors"
            >
              Test SELL
            </button>
          </div>
        </div>
      </section>

      {/* Risk limits + toggles */}
      <section className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border">
          <h3 className="text-sm font-semibold text-text-1">Risk limits</h3>
        </div>
        <div className="px-5 py-4 flex flex-col gap-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-2">Enabled</span>
            <Switch checked={bot.enabled} onChange={(v) => toggleEnabled.mutate(v)} colorOn="green" />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-text-2">Dry run</span>
            <Switch checked={bot.dryRun} onChange={(v) => toggleDryRun.mutate(v)} colorOn="amber" />
          </div>
          <div className="border-t border-border pt-4 flex flex-col gap-4">
            <Field label="Max position (USD)" value={maxPosition} onChange={setMaxPosition} type="number" min="0.01" step="1" />
            <Field label="Max leverage" value={maxLeverage} onChange={setMaxLeverage} type="number" min="1" step="1" />
            <Field label="Daily loss limit (USD)" value={dailyLossLimit} onChange={setDailyLossLimit} type="number" step="1" hint="Negative value, e.g. −500" />
          </div>
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => saveRisk.mutate()}
              disabled={!riskValid || saveRisk.isPending}
              className="px-4 py-2.5 rounded-xl bg-green text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-dim transition-colors"
            >
              {saveRisk.isPending ? "Saving…" : "Save risk limits"}
            </button>
          </div>
        </div>
      </section>

      {/* Recent signals */}
      <section className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-1">Recent signals</h3>
          <span className="font-mono text-xs text-text-3">{bot.signals.length}</span>
        </div>
        {bot.signals.length === 0 ? (
          <div className="p-6 text-text-3 text-sm text-center">No signals yet</div>
        ) : (
          <div className="overflow-auto max-h-72">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="data-label px-5 py-3 text-left font-normal">Time</th>
                  <th className="data-label px-4 py-3 text-left font-normal">Action</th>
                  <th className="data-label px-5 py-3 text-right font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {bot.signals.map((s) => {
                  const isExpanded = expandedSignals.has(s.id);
                  const hasReason = s.status === "REJECTED" && Boolean(s.rejectionReason);
                  const friendly = hasReason ? friendlyReason(s.rejectionReason!) : null;
                  return (
                    <>
                      <tr
                        key={s.id}
                        className={`border-b ${isExpanded ? "border-border/20" : "border-border/50"} hover:bg-surface/50 transition-colors`}
                      >
                        <td className="px-5 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
                          {fmtTime.format(new Date(s.receivedAt))}
                          {s.isTest && (
                            <span className="ml-1.5 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber/10 text-amber border border-amber/20 align-middle">
                              test
                            </span>
                          )}
                        </td>
                        <td className={`px-4 py-3 font-semibold text-xs ${ACTION_COLOR[s.action] ?? "text-text-2"}`}>
                          {s.action}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <button
                            onClick={() => hasReason && toggleSignal(s.id)}
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[s.status] ?? "bg-surface text-text-3"} ${hasReason ? "cursor-pointer" : "cursor-default"}`}
                            title={hasReason && !isExpanded ? s.rejectionReason ?? undefined : undefined}
                          >
                            {s.status.toLowerCase()}
                            {hasReason && (
                              <span className="opacity-50 text-[10px]">{isExpanded ? "▲" : "▼"}</span>
                            )}
                          </button>
                        </td>
                      </tr>
                      {hasReason && isExpanded && (
                        <tr key={`${s.id}-detail`} className="border-b border-border/50 bg-red/[0.03]">
                          <td colSpan={3} className="px-5 pb-3 pt-1">
                            {friendly && (
                              <div className="flex items-start gap-1.5 mb-2 text-xs text-amber">
                                <span className="mt-px shrink-0">⚠</span>
                                <span>{friendly}</span>
                              </div>
                            )}
                            <div className="px-3 py-2 rounded-lg bg-red/5 border border-red/15 text-xs font-mono text-red/70 break-all">
                              {s.rejectionReason}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Recent trades */}
      <section className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="px-5 py-4 border-b border-border flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-1">Recent trades</h3>
          <span className="font-mono text-xs text-text-3">{bot.trades.length}</span>
        </div>
        {bot.trades.length === 0 ? (
          <div className="p-6 text-text-3 text-sm text-center">No trades yet</div>
        ) : (
          <div className="overflow-auto max-h-72">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="data-label px-5 py-3 text-left font-normal">Opened</th>
                  <th className="data-label px-4 py-3 text-left font-normal">Symbol</th>
                  <th className="data-label px-4 py-3 text-left font-normal">Dir</th>
                  <th className="data-label px-5 py-3 text-right font-normal">PnL</th>
                </tr>
              </thead>
              <tbody>
                {bot.trades.map((t) => {
                  const pnl = t.realizedPnlUsd ?? t.pnlUsd ?? null;
                  return (
                    <tr key={t.id} className="border-b border-border/50 hover:bg-surface/50 transition-colors">
                      <td className="px-5 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
                        {fmtTime.format(new Date(t.openedAt))}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-2">{t.symbol}</td>
                      <td className={`px-4 py-3 font-semibold text-xs ${t.side === "BUY" ? "text-green" : "text-red"}`}>
                        {t.side === "BUY" ? "Long" : "Short"}
                      </td>
                      <td className={`px-5 py-3 text-right font-mono text-xs font-medium ${
                        pnl == null ? "text-text-3" : pnl >= 0 ? "text-green" : "text-red"
                      }`}>
                        {pnl != null ? `${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}` : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
