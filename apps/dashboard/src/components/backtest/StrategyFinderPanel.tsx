import { useEffect, useMemo, useState, type FC } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  fetchBacktestStrategies,
  fetchBacktestPine,
  fetchBots,
  startAutoOptimize,
  getAutoOptimizeRun,
  listAutoOptimizeRuns,
  cancelAutoOptimizeRun,
  deleteAutoOptimizeRun,
  type BacktestTimeframe,
  type AutoOptimizeRun,
  type AutoOptimizeRunSummary,
  type AutoOptimizeCellResult,
  type Bot,
} from "../../api/client";
import { Select } from "../ui/Select";
import { Field, FIELD_HEADER_CLASS } from "../ui/Field";
import { Tooltip } from "../ui/Tooltip";

const TIMEFRAMES: { value: BacktestTimeframe; label: string }[] = [
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "4h", label: "4h" },
  { value: "1d", label: "1d" },
  { value: "1w", label: "1w" },
];

const SUGGESTED_SYMBOLS = ["BTCUSDT", "XRPUSDT", "SOLUSDT", "ETHUSDT", "DOGEUSDT"];

const toDateInput = (d: Date) => d.toISOString().slice(0, 10);
const defaultFrom = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 3); return toDateInput(d); };
const defaultTo = () => toDateInput(new Date());

// Never throws — see the identical helper in BacktestConfig.tsx. A <input type="date"> value can
// be "" mid-edit; returns "" instead of letting toISOString() throw and crash the page.
function toIsoSafe(dateStr: string, timeSuffix: string): string {
  const d = new Date(`${dateStr}${timeSuffix}`);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

// Inverse of toIsoSafe, for syncing the From/To inputs to a run's actual range (e.g. when
// selecting an older run from history). Never throws — returns null for an unparseable/missing
// ISO string so the caller can leave the existing input alone instead of clobbering it.
function fromIsoToDateInput(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : toDateInput(d);
}

const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${fmtPct.format(v)}%`;
const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");

const chipClass = (active: boolean) =>
  `px-3 py-1.5 rounded-lg text-xs border transition-colors ${
    active ? "bg-green/15 border-green/40 text-green" : "bg-surface border-border text-text-3 hover:text-text-2"
  }`;

export interface LoadIntoBacktestPayload {
  strategyId: string;
  params: Record<string, number>;
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string; // ISO
  to: string; // ISO
}

interface StrategyFinderPanelProps {
  onLoadIntoBacktest: (payload: LoadIntoBacktestPayload) => void;
}

// Automated coarse-grid search across strategy x symbol x timeframe, ranked by an
// out-of-sample risk-adjusted score (see apps/bot/src/backtest/{scoring,search}.ts) rather
// than raw in-sample PnL, which reliably surfaces curve-fit configs. Runs as a detached
// background job on the bot — this panel just starts it and polls for progress/results.
export const StrategyFinderPanel: FC<StrategyFinderPanelProps> = ({ onLoadIntoBacktest }) => {
  const { data: strategies = [] } = useQuery({ queryKey: ["backtest", "strategies"], queryFn: fetchBacktestStrategies, staleTime: Infinity });
  const { data: bots = [] } = useQuery<Bot[]>({ queryKey: ["bots"], queryFn: fetchBots, staleTime: 30_000 });
  const botSymbols = [...new Set(bots.map((b) => b.symbol))].sort();
  const symbolSuggestions = [...new Set([...botSymbols, ...SUGGESTED_SYMBOLS])].sort();

  const [symbolsInput, setSymbolsInput] = useState("BTCUSDT");
  const [timeframes, setTimeframes] = useState<Set<BacktestTimeframe>>(new Set(["1d"]));
  const [strategyIds, setStrategyIds] = useState<Set<string>>(new Set());
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [validateFraction, setValidateFraction] = useState("0.15");
  const [holdoutFraction, setHoldoutFraction] = useState("0.15");
  const [walkForwardEnabled, setWalkForwardEnabled] = useState(false);
  const [walkForwardFolds, setWalkForwardFolds] = useState("4");
  const [minTrades, setMinTrades] = useState("30");
  const [initialCapital, setInitialCapital] = useState("10000");
  const [maxPositionUsd, setMaxPositionUsd] = useState("1000");
  const [leverage, setLeverage] = useState("5");
  const [feeBps, setFeeBps] = useState("5.5");
  // Blank = same as the fee above (taker on both sides) — see the identical field in
  // BacktestConfig.tsx.
  const [entryFeeBps, setEntryFeeBps] = useState("");
  const [slippageBps, setSlippageBps] = useState("2");
  const [fillModel, setFillModel] = useState<"signalClose" | "nextOpen">("signalClose");
  const [runId, setRunId] = useState<number | null>(null);

  // Default to every strategy selected once the list loads (searching everything is the point).
  useEffect(() => {
    if (strategyIds.size === 0 && strategies.length > 0) {
      setStrategyIds(new Set(strategies.map((s) => s.id)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [strategies]);

  const symbols = useMemo(
    () => [...new Set(symbolsInput.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean))],
    [symbolsInput],
  );

  const startMutation = useMutation({
    mutationFn: startAutoOptimize,
    onSuccess: (data) => { setRunId(data.runId); toast.success(`Strategy Finder started — run #${data.runId}`); },
  });

  const runQuery = useQuery<AutoOptimizeRun>({
    queryKey: ["backtest", "optimize", "auto", runId],
    queryFn: () => getAutoOptimizeRun(runId!),
    enabled: runId != null,
    refetchInterval: (query) => (query.state.data?.status === "running" ? 1_500 : false),
  });
  const run = runQuery.data;
  const isRunning = run?.status === "running";

  const historyQuery = useQuery<AutoOptimizeRunSummary[]>({
    queryKey: ["backtest", "optimize", "auto", "history"],
    queryFn: listAutoOptimizeRuns,
    refetchInterval: isRunning ? 3_000 : false,
  });

  const cancelMutation = useMutation({
    mutationFn: cancelAutoOptimizeRun,
    // Refetch on both outcomes so the panel reflects the run's true status right away —
    // otherwise it sits stale until the next scheduled poll (up to 1.5s later), and a
    // failed cancel (e.g. the run already finished) would otherwise fail silently.
    onSuccess: () => {
      toast.success("Cancelling run…");
      void runQuery.refetch();
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to cancel run");
      void runQuery.refetch();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteAutoOptimizeRun,
    onSuccess: (_data, deletedRunId) => {
      toast.success(`Deleted run #${deletedRunId}`);
      if (runId === deletedRunId) setRunId(null); // stop polling a run that no longer exists
      void historyQuery.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to delete run"),
  });

  function toggleTimeframe(tf: BacktestTimeframe) {
    setTimeframes((prev) => {
      const next = new Set(prev);
      if (next.has(tf)) next.delete(tf); else next.add(tf);
      return next;
    });
  }

  function toggleStrategy(id: string) {
    setStrategyIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const isoFrom = toIsoSafe(from, "T00:00:00Z");
  const isoTo = toIsoSafe(to, "T23:59:59Z");
  const cellCount = strategyIds.size * symbols.length * timeframes.size;
  const canStart = !isRunning && !startMutation.isPending && symbols.length > 0 && timeframes.size > 0 && strategyIds.size > 0 && isoFrom !== "" && isoTo !== "";

  function handleStart() {
    if (!canStart) return;
    startMutation.mutate({
      symbols,
      timeframes: [...timeframes],
      strategyIds: [...strategyIds],
      from: isoFrom,
      to: isoTo,
      validateFraction: Number(validateFraction) || 0.15,
      holdoutFraction: Number(holdoutFraction) || 0.15,
      walkForwardFolds: walkForwardEnabled ? Number(walkForwardFolds) || undefined : undefined,
      minTrades: Number(minTrades) || 30,
      initialCapital: Number(initialCapital) || 10_000,
      maxPositionUsd: Number(maxPositionUsd) || 1_000,
      leverage: Number(leverage) || 5,
      feeBps: Number(feeBps) || 0,
      ...(entryFeeBps.trim() !== "" ? { entryFeeBps: Number(entryFeeBps) || 0 } : {}),
      slippageBps: Number(slippageBps) || 0,
      fillModel,
    });
  }

  function handleLoad(r: AutoOptimizeCellResult) {
    // Prefer the range the run was actually executed over (echoed by the API from its
    // configJson snapshot) — falls back to the live form inputs only for a row whose config
    // failed to parse, so Load always reflects the results on screen, not whatever the date
    // fields happen to hold at click time (see StrategyFinderPanel exploration: the form and
    // the displayed run can disagree after editing dates or switching runs from history).
    const loadFrom = run?.from ?? isoFrom;
    const loadTo = run?.to ?? isoTo;
    if (!loadFrom || !loadTo) {
      toast.error("Pick a valid From/To date range first");
      return;
    }
    onLoadIntoBacktest({
      strategyId: r.strategyId,
      params: r.params,
      symbol: r.symbol,
      timeframe: r.timeframe,
      from: loadFrom,
      to: loadTo,
    });
    toast.success("Loaded into Single backtest — switch tabs to run it");
  }

  // Selecting a run from history swaps the results table — also sync the date inputs to that
  // run's actual range so the form never disagrees with what's on screen (and so Load, which
  // falls back to the form when a run's range is unavailable, stays correct too).
  function handleSelectRun(id: number) {
    setRunId(id);
    const summary = historyQuery.data?.find((r) => r.id === id);
    const syncedFrom = fromIsoToDateInput(summary?.from);
    const syncedTo = fromIsoToDateInput(summary?.to);
    if (syncedFrom) setFrom(syncedFrom);
    if (syncedTo) setTo(syncedTo);
  }

  return (
    <div className="bg-card border border-border rounded-[14px] p-5 space-y-5">
      <div>
        <h2 className="font-semibold text-text-1">Strategy Finder</h2>
        <p className="text-xs text-text-3 mt-1 max-w-2xl">
          Coarse-grid search, refined around the best regions, across every selected strategy x symbol x
          timeframe. Configs are chosen on a validate slice the search never trained on, then reported on a
          holdout slice that never influences the choice — that holdout number is the one to trust.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5 col-span-2 sm:col-span-1">
          <div className={FIELD_HEADER_CLASS}>
            <label className="data-label">Symbols</label>
          </div>
          <input
            type="text"
            list="finder-symbol-suggestions"
            value={symbolsInput}
            onChange={(e) => setSymbolsInput(e.target.value)}
            placeholder="BTCUSDT, ETHUSDT, ..."
            className="bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors"
          />
          <datalist id="finder-symbol-suggestions">
            {symbolSuggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
        <Field label="From" type="date" value={from} onChange={setFrom} />
        <Field label="To" type="date" value={to} onChange={setTo} />
      </div>

      <div>
        <div className="data-label mb-2">Timeframes</div>
        <div className="flex flex-wrap gap-2">
          {TIMEFRAMES.map((tf) => (
            <button key={tf.value} onClick={() => toggleTimeframe(tf.value)} className={chipClass(timeframes.has(tf.value))}>
              {tf.label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <div className="data-label mb-2 flex items-center gap-1.5">
          Strategies
          <Tooltip text="Strategies with a regime/session filter (Custom MA Cross, BB Mean Reversion) or several independent enum modes (Session ORB, Session VWAP Reversion) run a wider per-branch search to keep every mode meaningfully sampled — expect those cells to take longer than a plain crossover.">
            <span className="text-text-3 cursor-help">ⓘ</span>
          </Tooltip>
        </div>
        <div className="flex flex-wrap gap-2">
          {strategies.map((s) => (
            <button key={s.id} onClick={() => toggleStrategy(s.id)} className={chipClass(strategyIds.has(s.id))}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Validate" type="number" min="0.05" step="0.05" value={validateFraction} onChange={setValidateFraction} hint="fraction used to select" />
        <Field label="Holdout" type="number" min="0.05" step="0.05" value={holdoutFraction} onChange={setHoldoutFraction} hint="fraction, never selects" />
        <Field label="Min trades" type="number" min="0" value={minTrades} onChange={setMinTrades} hint="to rank a config" />
        <Field label="Initial capital" type="number" min="0" value={initialCapital} onChange={setInitialCapital} hint="USDT" />
        <Field label="Margin / trade" type="number" min="0" value={maxPositionUsd} onChange={setMaxPositionUsd} hint="USDT" />
        <Field label="Leverage" type="number" min="1" value={leverage} onChange={setLeverage} hint="x" />
        <Field label="Fee (taker)" type="number" min="0" step="0.1" value={feeBps} onChange={setFeeBps} hint="bps · both sides" />
        <Field label="Entry fee (maker)" type="number" min="0" step="0.1" value={entryFeeBps} onChange={setEntryFeeBps} hint="bps · blank = fee" />
        <Field label="Slippage" type="number" min="0" step="0.1" value={slippageBps} onChange={setSlippageBps} hint="bps" />
        <div className="flex flex-col gap-1.5 min-w-0">
          <div className={FIELD_HEADER_CLASS}>
            <label className="data-label">Fill model</label>
          </div>
          <Select
            value={fillModel}
            onChange={(v) => setFillModel(v as "signalClose" | "nextOpen")}
            options={[
              { value: "signalClose", label: "Signal close" },
              { value: "nextOpen", label: "Next bar open" },
            ]}
          />
        </div>
      </div>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-text-2 cursor-pointer">
          <input
            type="checkbox"
            checked={walkForwardEnabled}
            onChange={(e) => setWalkForwardEnabled(e.target.checked)}
            className="accent-green"
          />
          <Tooltip text="Instead of one continuous validate-period score, splits validate into this many sequential folds and ranks configs by their mean fold score. A config that only works in one regime within the validate window can no longer hide behind a good blended average — but it costs shortlist-size × folds extra backtests, so runs take longer.">
            Walk-forward selection
          </Tooltip>
        </label>
        {walkForwardEnabled && (
          <input
            type="number"
            min="2"
            max="12"
            value={walkForwardFolds}
            onChange={(e) => setWalkForwardFolds(e.target.value)}
            className="w-16 bg-surface border border-border rounded-lg px-2 py-1 text-xs font-mono text-text-1 focus:outline-none focus:border-border-bright transition-colors"
          />
        )}
        {walkForwardEnabled && <span className="text-xs text-text-3">folds</span>}
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3 pt-1">
        <span className="text-xs font-mono text-text-3">
          {symbols.length === 0
            ? "Enter at least one symbol"
            : `${strategyIds.size} strategies × ${symbols.length} symbols × ${timeframes.size} timeframes = ${cellCount} cell${cellCount === 1 ? "" : "s"}`}
        </span>
        <button
          onClick={handleStart}
          disabled={!canStart}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-green text-base hover:bg-green/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isRunning ? "Running…" : startMutation.isPending ? "Starting…" : "Find best strategy"}
        </button>
      </div>

      {startMutation.isError && (
        <div className="bg-red/10 border border-red/20 rounded-xl px-4 py-3 text-sm text-red">
          {startMutation.error.message}
        </div>
      )}

      {run && (
        <RunProgress
          run={run}
          onCancel={() => cancelMutation.mutate(run.id)}
          cancelling={cancelMutation.isPending}
          onDelete={() => deleteMutation.mutate(run.id)}
          deleting={deleteMutation.isPending}
        />
      )}

      {run && run.results.length > 0 && <ResultsTable results={run.results} onLoad={handleLoad} />}

      {run && run.status !== "running" && run.results.length === 0 && (
        <div className="p-6 text-center text-text-3 text-sm bg-surface border border-border rounded-xl">
          No configuration produced enough qualifying trades to rank. Try a wider date range, more symbols, or a
          lower minimum trade count.
        </div>
      )}

      {historyQuery.data && historyQuery.data.length > 0 && (
        <RunHistory
          runs={historyQuery.data}
          activeRunId={runId}
          onSelect={handleSelectRun}
          onDelete={(id) => deleteMutation.mutate(id)}
        />
      )}
    </div>
  );
};

const RunProgress: FC<{
  run: AutoOptimizeRun;
  onCancel: () => void;
  cancelling: boolean;
  onDelete: () => void;
  deleting: boolean;
}> = ({ run, onCancel, cancelling, onDelete, deleting }) => {
  const pct = run.cellsTotal === 0 ? 0 : Math.round((run.cellsDone / run.cellsTotal) * 100);
  const statusColor =
    run.status === "done" ? "text-green" : run.status === "error" ? "text-red" : run.status === "cancelled" ? "text-text-3" : "text-text-2";

  return (
    <div className="bg-surface border border-border rounded-xl px-4 py-3 space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className={`font-mono font-medium uppercase tracking-wide ${statusColor}`}>Run #{run.id} — {run.status}</span>
        <span className="text-text-3 font-mono">
          {run.cellsDone}/{run.cellsTotal} cells · {run.backtestsRun} backtests run
          {run.from && run.to && ` · ${fromIsoToDateInput(run.from)} → ${fromIsoToDateInput(run.to)}`}
        </span>
      </div>
      <div className="h-1.5 bg-card rounded-full overflow-hidden">
        <div className="h-full bg-green transition-all duration-300" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex justify-end gap-3">
        {run.status === "running" ? (
          <button onClick={onCancel} disabled={cancelling} className="text-xs text-text-3 hover:text-red transition-colors disabled:opacity-40">
            {cancelling ? "Cancelling…" : "Cancel run"}
          </button>
        ) : (
          <button onClick={onDelete} disabled={deleting} className="text-xs text-text-3 hover:text-red transition-colors disabled:opacity-40">
            {deleting ? "Deleting…" : "Delete run"}
          </button>
        )}
      </div>
      {run.error && <div className="text-xs text-red">{run.error}</div>}
    </div>
  );
};

// Header label with a hover explanation — see ui/Tooltip.tsx.
const Th: FC<{ label: string; help?: string; align?: "left" | "right" | "center" }> = ({ label, help, align = "left" }) => (
  <th className={`data-label px-4 py-2.5 font-normal ${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"}`}>
    {help ? <Tooltip text={help}>{label}</Tooltip> : label}
  </th>
);

const SPLIT_LEGEND: { label: string; tone: string; desc: string }[] = [
  { label: "Train", tone: "text-text-2", desc: "Earliest ~70% of the date range — the data the search actually optimizes against. Always looks best; don't trust it alone." },
  { label: "Validate", tone: "text-text-1", desc: "Next ~15% — used to pick the winner from the shortlist. Out-of-sample relative to training, but it IS what drove the ranking, so it can still be a bit optimistic." },
  { label: "Holdout", tone: "text-green", desc: "Final ~15% (most recent data) — never touched by training or selection in any way. This is the only genuinely trustworthy number for whether this will actually work." },
  { label: "Fit", tone: "text-text-1", desc: "Holdout score ÷ train score, as a %. 100% means the edge fully held up on untouched data; 0% or below means it didn't transfer at all." },
];

const SplitLegend: FC = () => (
  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-4 py-3 border-b border-border">
    {SPLIT_LEGEND.map((item) => (
      <div key={item.label} className="space-y-1">
        <div className={`text-[11px] font-semibold uppercase tracking-wide ${item.tone}`}>{item.label}</div>
        <p className="text-[11px] leading-relaxed text-text-3">{item.desc}</p>
      </div>
    ))}
  </div>
);

const ResultsTable: FC<{ results: AutoOptimizeCellResult[]; onLoad: (r: AutoOptimizeCellResult) => void }> = ({ results, onLoad }) => {
  const [copyingKey, setCopyingKey] = useState<string | null>(null);

  async function handleCopyPine(r: AutoOptimizeCellResult, key: string) {
    setCopyingKey(key);
    try {
      const { pine } = await fetchBacktestPine(r.strategyId, r.params);
      await navigator.clipboard.writeText(pine);
      toast.success("Pine script copied to clipboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate Pine script");
    } finally {
      setCopyingKey(null);
    }
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 text-xs text-text-3 border-b border-border">
        Top {results.length} ranked by validate score.
      </div>
      <SplitLegend />
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="data-label px-4 py-2.5 text-left font-normal">#</th>
              <th className="data-label px-4 py-2.5 text-left font-normal">Strategy</th>
              <th className="data-label px-4 py-2.5 text-left font-normal">Symbol</th>
              <th className="data-label px-4 py-2.5 text-left font-normal">TF</th>
              <Th
                label="Train PnL%"
                align="right"
                help="In-sample return — performance on the exact data window the search optimized against. Almost always looks better than validate/holdout; shown for comparison only, not to be trusted on its own."
              />
              <Th
                label="Validate PnL%"
                align="right"
                help="Performance on the slice used to choose this config from a shortlist of candidates. Out-of-sample relative to training, but it IS selection data — it drove the ranking, so it can still be optimistic."
              />
              <Th
                label="Holdout PnL%"
                align="right"
                help="Performance on data that never influenced training or selection in any way. This is the number that should actually drive your decision."
              />
              <Th
                label="Holdout Win%"
                align="right"
                help="Win rate during the untouched holdout period."
              />
              <Th
                label="Holdout Max DD"
                align="right"
                help="Largest peak-to-trough equity decline during the holdout period. Lower is safer; weigh this against how much drawdown you can actually stomach live."
              />
              <Th
                label="Holdout Trades"
                align="right"
                help="Number of trades executed during the holdout period. Too few makes every other holdout column statistically shaky — be skeptical of results close to your Min trades setting."
              />
              <Th
                label="Fit"
                align="center"
                help="Holdout score ÷ train score, as a percentage. 100% means the edge fully held up on untouched data; 0% or below means it didn't transfer at all. Replaces a plain overfit/holds-up flag with the actual magnitude."
              />
              <Th
                label="Combos"
                align="right"
                help="How many distinct param combinations this cell's search actually evaluated. A winner picked out of a few thousand combos deserves more skepticism than one out of a few dozen — pure luck gets more chances to look good the wider the search."
              />
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const key = `${r.strategyId}-${r.symbol}-${r.timeframe}-${i}`;
              const fitPct = r.holdoutRatio * 100;
              const fitClass =
                fitPct >= 70 ? "bg-green/15 text-green" : fitPct >= 30 ? "bg-amber/15 text-amber" : "bg-red/15 text-red";
              const fitLabel = fitPct >= 70 ? "holds up" : fitPct >= 30 ? "caution" : "overfit";
              return (
                <tr key={key} className="border-b border-border/50 hover:bg-card/50 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-text-3">{i + 1}</td>
                  <td className="px-4 py-2.5 text-xs text-text-1 whitespace-nowrap">{r.strategyId}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-1">{r.symbol}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-2">{r.timeframe}</td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs ${pnlColor(r.trainStats.totalPnlPct)}`}>{signedPct(r.trainStats.totalPnlPct)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs ${pnlColor(r.validateStats.totalPnlPct)}`}>
                    {signedPct(r.validateStats.totalPnlPct)}
                    {r.walkForwardScores && (
                      <Tooltip
                        text={`Ranked by the mean of ${r.walkForwardScores.length} walk-forward folds, not this continuous-period number. Per-fold scores: ${r.walkForwardScores.map((s) => s.toFixed(2)).join(", ")}`}
                        triggerClassName="ml-1 text-[9px] font-semibold text-text-3 cursor-help align-super"
                      >
                        WF
                      </Tooltip>
                    )}
                  </td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${pnlColor(r.holdoutStats.totalPnlPct)}`}>{signedPct(r.holdoutStats.totalPnlPct)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-text-2">{fmtPct.format(r.holdoutStats.winRatePct)}%</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-red">{fmtPct.format(r.holdoutStats.maxDrawdownPct)}%</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-text-3">{r.holdoutStats.totalTrades}</td>
                  <td className="px-4 py-2.5 text-center">
                    <Tooltip text={`Holdout ÷ train = ${fmtPct.format(fitPct)}%`} triggerClassName="cursor-help">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded whitespace-nowrap ${fitClass}`}>
                        {fitLabel} ({fmtPct.format(fitPct)}%)
                      </span>
                    </Tooltip>
                  </td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-text-3">{r.combosEvaluated}</td>
                  <td className="pr-4 py-2.5 text-right whitespace-nowrap">
                    <button
                      onClick={() => onLoad(r)}
                      className="text-xs font-medium px-2.5 py-1 rounded-lg bg-card border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors mr-1.5"
                    >
                      Load
                    </button>
                    <button
                      onClick={() => { void handleCopyPine(r, key); }}
                      disabled={copyingKey === key}
                      className="text-xs font-medium px-2.5 py-1 rounded-lg bg-card border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors disabled:opacity-40"
                    >
                      {copyingKey === key ? "…" : "Pine"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const RunHistory: FC<{
  runs: AutoOptimizeRunSummary[];
  activeRunId: number | null;
  onSelect: (id: number) => void;
  onDelete: (id: number) => void;
}> = ({ runs, activeRunId, onSelect, onDelete }) => (
  <div className="flex flex-wrap items-center gap-1.5 pt-3 border-t border-border">
    <span className="text-xs text-text-3 mr-1">Recent runs:</span>
    {runs.slice(0, 8).map((r) => (
      <div
        key={r.id}
        className={`flex items-center rounded-lg border transition-colors ${
          r.id === activeRunId ? "bg-green/15 border-green/40 text-green" : "bg-surface border-border text-text-3"
        }`}
      >
        <button
          onClick={() => onSelect(r.id)}
          title={r.from && r.to ? `${fromIsoToDateInput(r.from)} → ${fromIsoToDateInput(r.to)}` : undefined}
          className="pl-3 pr-1.5 py-1.5 text-xs hover:text-text-1 transition-colors"
        >
          <span className="font-mono">#{r.id}</span> {r.status === "running" ? `${r.cellsDone}/${r.cellsTotal}` : r.status}
        </button>
        <button onClick={() => onDelete(r.id)} title="Delete run" className="pr-2 pl-1 py-1.5 hover:text-red transition-colors">
          ×
        </button>
      </div>
    ))}
  </div>
);
