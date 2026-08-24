import { useState, type FC } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  runBacktestOptimize,
  type BacktestStrategyParam,
  type BacktestOptimizeResult,
  type OptimizeSweepParam,
  type BacktestTimeframe,
} from "../../api/client";

const MAX_COMBINATIONS = 500;
const MAX_SWEPT_PARAMS = 3;

export interface OptimizeRunConfigBase {
  strategyId: string;
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string; // ISO
  to: string; // ISO
  initialCapital: number;
  maxPositionUsd: number;
  leverage: number;
  feeBps: number;
  slippageBps: number;
  fillModel: "signalClose" | "nextOpen";
}

interface Range {
  min: number;
  max: number;
  step: number;
}

interface BacktestOptimizePanelProps {
  sweepableParams: BacktestStrategyParam[];
  baseParams: Record<string, number>;
  runConfigBase: OptimizeRunConfigBase;
  onApplyParams: (params: Record<string, number>) => void;
}

function stepsFor(r: Range): number {
  if (r.step <= 0 || r.max < r.min) return 1;
  return Math.round((r.max - r.min) / r.step) + 1;
}

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${fmtPct.format(v)}%`;
const signedUsd = (v: number) => `${v >= 0 ? "+" : ""}${fmtUsd.format(v)}`;
const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");

export const BacktestOptimizePanel: FC<BacktestOptimizePanelProps> = ({ sweepableParams, baseParams, runConfigBase, onApplyParams }) => {
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [ranges, setRanges] = useState<Record<string, Range>>({});

  const mutation = useMutation({ mutationFn: runBacktestOptimize });

  const sweptNames = [...selected];
  const sweep: OptimizeSweepParam[] = sweptNames
    .map((name) => ranges[name])
    .filter((r): r is Range => r != null)
    .map((r, i) => ({ param: sweptNames[i]!, min: r.min, max: r.max, step: r.step }));

  const totalCombinations = sweep.length === 0 ? 0 : sweep.reduce((total, s) => total * stepsFor(s), 1);
  const overCap = totalCombinations > MAX_COMBINATIONS;

  function toggleParam(param: BacktestStrategyParam) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(param.name)) {
        next.delete(param.name);
      } else if (next.size < MAX_SWEPT_PARAMS) {
        next.add(param.name);
        setRanges((r) => ({ ...r, [param.name]: { min: param.min, max: param.max, step: param.step } }));
      }
      return next;
    });
  }

  function updateRange(name: string, patch: Partial<Range>) {
    setRanges((prev) => ({ ...prev, [name]: { ...prev[name]!, ...patch } }));
  }

  function handleRunOptimize() {
    if (sweep.length === 0 || overCap) return;
    mutation.mutate({
      strategyId: runConfigBase.strategyId,
      baseParams,
      sweep,
      symbol: runConfigBase.symbol,
      timeframe: runConfigBase.timeframe,
      from: runConfigBase.from,
      to: runConfigBase.to,
      initialCapital: runConfigBase.initialCapital,
      maxPositionUsd: runConfigBase.maxPositionUsd,
      leverage: runConfigBase.leverage,
      feeBps: runConfigBase.feeBps,
      slippageBps: runConfigBase.slippageBps,
      fillModel: runConfigBase.fillModel,
    });
  }

  function handleApply(result: BacktestOptimizeResult) {
    onApplyParams(result.params);
    toast.success("Parameters applied — ready to run");
  }

  return (
    <div className="border-t border-border pt-4">
      <button
        onClick={() => setExpanded((v) => !v)}
        className="flex items-center gap-1.5 text-sm font-medium text-text-2 hover:text-text-1 transition-colors"
      >
        <span className={`text-[10px] transition-transform ${expanded ? "rotate-90" : ""}`}>▸</span>
        Optimize parameters
      </button>

      {expanded && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-text-3">
            Pick up to {MAX_SWEPT_PARAMS} numeric params to sweep — everything else stays at the value set above.
            Results are ranked by Total PnL%, excluding combinations with too few trades to be meaningful.
          </p>

          <div className="space-y-2">
            {sweepableParams.map((p) => {
              const checked = selected.has(p.name);
              const range = ranges[p.name];
              const disabled = !checked && selected.size >= MAX_SWEPT_PARAMS;
              return (
                <div key={p.name} className="flex flex-wrap items-center gap-2.5 bg-surface border border-border rounded-xl px-3 py-2.5">
                  <label className="flex items-center gap-2 w-40 shrink-0 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleParam(p)}
                      className="accent-green"
                    />
                    <span className={`text-sm truncate ${disabled ? "text-text-3" : "text-text-2"}`}>{p.label}</span>
                  </label>
                  {checked && range && (
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <RangeInput value={range.min} onChange={(v) => updateRange(p.name, { min: v })} />
                      <span className="text-text-3">→</span>
                      <RangeInput value={range.max} onChange={(v) => updateRange(p.name, { max: v })} />
                      <span className="text-text-3">step</span>
                      <RangeInput value={range.step} onChange={(v) => updateRange(p.name, { step: v })} />
                      <span className="text-text-3">({stepsFor(range)} values)</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flex items-center justify-between flex-wrap gap-3">
            <span className={`text-xs font-mono ${overCap ? "text-red" : "text-text-3"}`}>
              {sweep.length === 0
                ? "Select at least one param to sweep"
                : overCap
                  ? `${totalCombinations} combinations — exceeds the ${MAX_COMBINATIONS} cap, narrow the range/step`
                  : `${totalCombinations} combination${totalCombinations === 1 ? "" : "s"}`}
            </span>
            <button
              onClick={handleRunOptimize}
              disabled={sweep.length === 0 || overCap || mutation.isPending || !runConfigBase.from || !runConfigBase.to}
              title={!runConfigBase.from || !runConfigBase.to ? "Pick a valid From/To date range" : undefined}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-green text-base hover:bg-green/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {mutation.isPending ? "Optimizing…" : "Run optimization"}
            </button>
          </div>

          {mutation.isError && (
            <div className="bg-red/10 border border-red/20 rounded-xl px-4 py-3 text-sm text-red">
              {(mutation.error).message}
            </div>
          )}

          {mutation.data && (
            <OptimizeResultsTable
              sweptParamNames={sweptNames}
              response={mutation.data}
              onApply={handleApply}
            />
          )}
        </div>
      )}
    </div>
  );
};

const RangeInput: FC<{ value: number; onChange: (v: number) => void }> = ({ value, onChange }) => (
  <input
    type="number"
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
    className="w-20 bg-card border border-border rounded-lg px-2 py-1 text-text-1 focus:outline-none focus:border-border-bright transition-colors"
  />
);

const OptimizeResultsTable: FC<{
  sweptParamNames: string[];
  response: { totalCombinations: number; evaluatedCombinations: number; filteredOutCount: number; results: BacktestOptimizeResult[] };
  onApply: (result: BacktestOptimizeResult) => void;
}> = ({ sweptParamNames, response, onApply }) => {
  if (response.results.length === 0) {
    return (
      <div className="p-6 text-center text-text-3 text-sm bg-surface border border-border rounded-xl">
        No combination produced enough trades to rank. Try widening the sweep range or lowering the minimum trade count.
      </div>
    );
  }

  return (
    <div className="bg-surface border border-border rounded-xl overflow-hidden">
      <div className="px-4 py-2.5 text-xs text-text-3 border-b border-border">
        Evaluated {response.evaluatedCombinations} of {response.totalCombinations} combinations
        {response.filteredOutCount > 0 && ` — ${response.filteredOutCount} excluded for too few trades`}
        , showing top {response.results.length}.
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border">
              <th className="data-label px-4 py-2.5 text-left font-normal">#</th>
              {sweptParamNames.map((name) => (
                <th key={name} className="data-label px-4 py-2.5 text-right font-normal">{name}</th>
              ))}
              <th className="data-label px-4 py-2.5 text-right font-normal">PnL %</th>
              <th className="data-label px-4 py-2.5 text-right font-normal">PnL $</th>
              <th className="data-label px-4 py-2.5 text-right font-normal">Win rate</th>
              <th className="data-label px-4 py-2.5 text-right font-normal">Profit factor</th>
              <th className="data-label px-4 py-2.5 text-right font-normal">Max DD</th>
              <th className="data-label px-4 py-2.5 text-right font-normal">Trades</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {response.results.map((r, i) => (
              <tr key={i} className="border-b border-border/50 hover:bg-card/50 transition-colors">
                <td className="px-4 py-2.5 font-mono text-xs text-text-3">{i + 1}</td>
                {sweptParamNames.map((name) => (
                  <td key={name} className="px-4 py-2.5 text-right font-mono text-xs text-text-1">{r.params[name]}</td>
                ))}
                <td className={`px-4 py-2.5 text-right font-mono text-xs font-medium ${pnlColor(r.stats.totalPnlPct)}`}>{signedPct(r.stats.totalPnlPct)}</td>
                <td className={`px-4 py-2.5 text-right font-mono text-xs ${pnlColor(r.stats.totalPnlUsd)}`}>{signedUsd(r.stats.totalPnlUsd)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-text-2">{fmtPct.format(r.stats.winRatePct)}%</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-text-2">{r.stats.profitFactor === null ? "∞" : fmtPct.format(r.stats.profitFactor)}</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-red">{fmtPct.format(r.stats.maxDrawdownPct)}%</td>
                <td className="px-4 py-2.5 text-right font-mono text-xs text-text-3">{r.stats.totalTrades}</td>
                <td className="pr-4 py-2.5 text-right">
                  <button
                    onClick={() => onApply(r)}
                    className="text-xs font-medium px-2.5 py-1 rounded-lg bg-card border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors whitespace-nowrap"
                  >
                    Use these params
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};
