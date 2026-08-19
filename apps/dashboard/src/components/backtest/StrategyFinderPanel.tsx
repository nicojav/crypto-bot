import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { createPortal } from "react-dom";
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
import { Field } from "../ui/Field";

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
  const [oosFraction, setOosFraction] = useState("0.3");
  const [minTrades, setMinTrades] = useState("10");
  const [initialCapital, setInitialCapital] = useState("10000");
  const [maxPositionUsd, setMaxPositionUsd] = useState("1000");
  const [leverage, setLeverage] = useState("5");
  const [feeBps, setFeeBps] = useState("5.5");
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

  const cellCount = strategyIds.size * symbols.length * timeframes.size;
  const canStart = !isRunning && !startMutation.isPending && symbols.length > 0 && timeframes.size > 0 && strategyIds.size > 0;

  function handleStart() {
    if (!canStart) return;
    startMutation.mutate({
      symbols,
      timeframes: [...timeframes],
      strategyIds: [...strategyIds],
      from: new Date(`${from}T00:00:00Z`).toISOString(),
      to: new Date(`${to}T23:59:59Z`).toISOString(),
      oosFraction: Number(oosFraction) || 0.3,
      minTrades: Number(minTrades) || 10,
      initialCapital: Number(initialCapital) || 10_000,
      maxPositionUsd: Number(maxPositionUsd) || 1_000,
      leverage: Number(leverage) || 5,
      feeBps: Number(feeBps) || 0,
      slippageBps: Number(slippageBps) || 0,
      fillModel,
    });
  }

  function handleLoad(r: AutoOptimizeCellResult) {
    onLoadIntoBacktest({
      strategyId: r.strategyId,
      params: r.params,
      symbol: r.symbol,
      timeframe: r.timeframe,
      from: new Date(`${from}T00:00:00Z`).toISOString(),
      to: new Date(`${to}T23:59:59Z`).toISOString(),
    });
    toast.success("Loaded into Single backtest — switch tabs to run it");
  }

  return (
    <div className="bg-card border border-border rounded-[14px] p-5 space-y-5">
      <div>
        <h2 className="font-semibold text-text-1">Strategy Finder</h2>
        <p className="text-xs text-text-3 mt-1 max-w-2xl">
          Coarse-grid search, refined around the best regions, across every selected strategy x symbol x
          timeframe. Ranked by an out-of-sample risk-adjusted score — the search never sees the last slice of
          data, so a config that only looks good in-sample gets flagged, not recommended.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        <div className="flex flex-col gap-1.5 col-span-2 sm:col-span-1">
          <label className="data-label">Symbols</label>
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
        <div className="data-label mb-2">Strategies</div>
        <div className="flex flex-wrap gap-2">
          {strategies.map((s) => (
            <button key={s.id} onClick={() => toggleStrategy(s.id)} className={chipClass(strategyIds.has(s.id))}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Field label="Out-of-sample" type="number" min="0.05" step="0.05" value={oosFraction} onChange={setOosFraction} hint="fraction held out" />
        <Field label="Min trades" type="number" min="0" value={minTrades} onChange={setMinTrades} hint="to rank a config" />
        <Field label="Initial capital" type="number" min="0" value={initialCapital} onChange={setInitialCapital} hint="USDT" />
        <Field label="Margin / trade" type="number" min="0" value={maxPositionUsd} onChange={setMaxPositionUsd} hint="USDT" />
        <Field label="Leverage" type="number" min="1" value={leverage} onChange={setLeverage} hint="x" />
        <Field label="Taker fee" type="number" min="0" step="0.1" value={feeBps} onChange={setFeeBps} hint="bps" />
        <Field label="Slippage" type="number" min="0" step="0.1" value={slippageBps} onChange={setSlippageBps} hint="bps" />
        <div className="flex flex-col gap-1.5 min-w-0">
          <label className="data-label">Fill model</label>
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
          onSelect={setRunId}
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
        <span className="text-text-3 font-mono">{run.cellsDone}/{run.cellsTotal} cells · {run.backtestsRun} backtests run</span>
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

// Themed hover tooltip — a native `title` attribute can't be styled at all (plain OS
// black-box popup, wrong font, hard corners), and the table's rounded card uses
// `overflow-hidden` for its corners, which would clip a normally-positioned absolute
// tooltip the moment it tried to escape the card. Rendered into a portal at `document.body`
// with `position: fixed` coordinates from the trigger's own bounding rect, so it always
// draws above everything regardless of any ancestor's overflow/z-index.
const Tooltip: FC<{ text: string; children: ReactNode; triggerClassName?: string }> = ({
  text,
  children,
  triggerClassName = "cursor-help border-b border-dotted border-text-3/60 pb-px",
}) => {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  function show() {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) setPos({ top: rect.top - 8, left: rect.left + rect.width / 2 });
  }
  function hide() {
    setPos(null);
  }

  return (
    <span
      ref={triggerRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      tabIndex={0}
      className={triggerClassName}
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-50 w-56 -translate-x-1/2 -translate-y-full rounded-lg border border-border bg-card px-3 py-2 text-xs font-normal normal-case leading-relaxed tracking-normal text-text-2 shadow-xl"
            style={{ top: pos.top, left: pos.left }}
          >
            {text}
            <span className="absolute left-1/2 top-full -mt-1 h-2 w-2 -translate-x-1/2 rotate-45 border-b border-r border-border bg-card" />
          </div>,
          document.body,
        )}
    </span>
  );
};

// Header label with a hover explanation.
const Th: FC<{ label: string; help?: string; align?: "left" | "right" | "center" }> = ({ label, help, align = "left" }) => (
  <th className={`data-label px-4 py-2.5 font-normal ${align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"}`}>
    {help ? <Tooltip text={help}>{label}</Tooltip> : label}
  </th>
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
        Top {results.length} ranked by out-of-sample score. IS columns show in-sample (optimized-on) performance
        for comparison — OOS is what actually validates the config.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="data-label px-4 py-2.5 text-left font-normal">#</th>
              <th className="data-label px-4 py-2.5 text-left font-normal">Strategy</th>
              <th className="data-label px-4 py-2.5 text-left font-normal">Symbol</th>
              <th className="data-label px-4 py-2.5 text-left font-normal">TF</th>
              <Th
                label="IS PnL%"
                align="right"
                help="In-sample return — performance on the exact data window the search optimized against. Almost always looks better than OOS; shown for comparison only, not to be trusted on its own."
              />
              <Th
                label="OOS PnL%"
                align="right"
                help="Out-of-sample return — performance on data the search never touched while searching. This is the number that should drive your decision, not IS PnL%."
              />
              <Th
                label="OOS Win%"
                align="right"
                help="Out-of-sample win rate — the percentage of trades that closed profitably during the untouched OOS period."
              />
              <Th
                label="OOS Max DD"
                align="right"
                help="Out-of-sample max drawdown — the largest peak-to-trough equity decline during the OOS period. Lower is safer; weigh this against how much drawdown you can actually stomach live."
              />
              <Th
                label="OOS Trades"
                align="right"
                help="Number of trades executed during the OOS validation period. Too few makes every other OOS column statistically shaky — be skeptical of results close to your Min trades setting."
              />
              <Th
                label="Fit"
                align="center"
                help="Whether the OOS score held up close to in-sample, or collapsed (flagged 'overfit') — the single fastest signal for whether a config will transfer to live trading."
              />
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {results.map((r, i) => {
              const key = `${r.strategyId}-${r.symbol}-${r.timeframe}-${i}`;
              return (
                <tr key={key} className="border-b border-border/50 hover:bg-card/50 transition-colors">
                  <td className="px-4 py-2.5 font-mono text-xs text-text-3">{i + 1}</td>
                  <td className="px-4 py-2.5 text-xs text-text-1 whitespace-nowrap">{r.strategyId}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-1">{r.symbol}</td>
                  <td className="px-4 py-2.5 font-mono text-xs text-text-2">{r.timeframe}</td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs ${pnlColor(r.isStats.totalPnlPct)}`}>{signedPct(r.isStats.totalPnlPct)}</td>
                  <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${pnlColor(r.oosStats.totalPnlPct)}`}>{signedPct(r.oosStats.totalPnlPct)}</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-text-2">{fmtPct.format(r.oosStats.winRatePct)}%</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-red">{fmtPct.format(r.oosStats.maxDrawdownPct)}%</td>
                  <td className="px-4 py-2.5 text-right font-mono text-xs text-text-3">{r.oosStats.totalTrades}</td>
                  <td className="px-4 py-2.5 text-center">
                    {r.overfitFlag ? (
                      <Tooltip text="OOS score collapsed relative to in-sample — likely won't hold up live" triggerClassName="cursor-help">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-red/15 text-red whitespace-nowrap">overfit</span>
                      </Tooltip>
                    ) : (
                      <Tooltip text="OOS score held up close to in-sample" triggerClassName="cursor-help">
                        <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-green/15 text-green whitespace-nowrap">holds up</span>
                      </Tooltip>
                    )}
                  </td>
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
        <button onClick={() => onSelect(r.id)} className="pl-3 pr-1.5 py-1.5 text-xs hover:text-text-1 transition-colors">
          <span className="font-mono">#{r.id}</span> {r.status === "running" ? `${r.cellsDone}/${r.cellsTotal}` : r.status}
        </button>
        <button onClick={() => onDelete(r.id)} title="Delete run" className="pr-2 pl-1 py-1.5 hover:text-red transition-colors">
          ×
        </button>
      </div>
    ))}
  </div>
);
