import { useEffect, useRef, useState, type FC } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchBacktestStrategies, fetchBacktestPine, fetchBots, type BacktestTimeframe, type BacktestStrategyParam, type Bot } from "../../api/client";
import { Select } from "../ui/Select";
import { Field } from "../ui/Field";
import { BacktestOptimizePanel } from "./BacktestOptimizePanel";

// One-click suggestions for the free-text symbol field — not a constraint, any symbol can be typed.
const SUGGESTED_SYMBOLS = ["BTCUSDT", "XRPUSDT", "SOLUSDT", "ETHUSDT", "DOGEUSDT"];

export interface BacktestRunConfig {
  strategyId: string;
  params: Record<string, number>;
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string;
  to: string;
  initialCapital: number;
  maxPositionUsd: number;
  leverage: number;
  feeBps: number;
  slippageBps: number;
  fillModel: "signalClose" | "nextOpen";
}

const TIMEFRAMES: { value: BacktestTimeframe; label: string }[] = [
  { value: "5m", label: "5 minutes" },
  { value: "15m", label: "15 minutes" },
  { value: "4h", label: "4 hours" },
  { value: "1d", label: "1 day" },
  { value: "1w", label: "1 week" },
];

const toDateInput = (d: Date) => d.toISOString().slice(0, 10);
const defaultFrom = () => { const d = new Date(); d.setFullYear(d.getFullYear() - 5); return toDateInput(d); };
const defaultTo = () => toDateInput(new Date());

// A "load these params into the form" request from another panel (e.g. Strategy Finder).
// `token` is bumped by the caller on every load so the effect below re-applies even when
// the exact same strategy/symbol is loaded twice in a row.
export interface BacktestConfigPrefill {
  token: number;
  strategyId: string;
  params: Record<string, number>;
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string; // ISO
  to: string; // ISO
}

interface BacktestConfigProps {
  onRun: (config: BacktestRunConfig) => void;
  isRunning: boolean;
  prefill?: BacktestConfigPrefill | null;
}

export const BacktestConfig: FC<BacktestConfigProps> = ({ onRun, isRunning, prefill }) => {
  const { data: strategies = [] } = useQuery({ queryKey: ["backtest", "strategies"], queryFn: fetchBacktestStrategies, staleTime: Infinity });
  const { data: bots = [] } = useQuery<Bot[]>({ queryKey: ["bots"], queryFn: fetchBots, staleTime: 30_000 });
  const botSymbols = [...new Set(bots.map((b) => b.symbol))].sort();

  const [strategyId, setStrategyId] = useState("");
  const [params, setParams] = useState<Record<string, number>>({});
  const [symbol, setSymbol] = useState("BTCUSDT");
  const symbolDefaultedFromBot = useRef(false);
  const [timeframe, setTimeframe] = useState<BacktestTimeframe>("1d");
  const [isCopyingPine, setIsCopyingPine] = useState(false);
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [initialCapital, setInitialCapital] = useState("10000");
  const [maxPositionUsd, setMaxPositionUsd] = useState("1000");
  const [leverage, setLeverage] = useState("5");
  const [feeBps, setFeeBps] = useState("5.5");
  const [slippageBps, setSlippageBps] = useState("2");
  const [fillModel, setFillModel] = useState<"signalClose" | "nextOpen">("signalClose");

  // Select the first strategy/symbol once data loads, and reset params to that strategy's defaults.
  useEffect(() => {
    if (!strategyId && strategies.length > 0) {
      const first = strategies[0]!;
      setStrategyId(first.id);
      setParams(Object.fromEntries(first.params.map((p) => [p.name, p.default])));
    }
  }, [strategies, strategyId]);

  // Preselect the user's actual bot symbol once, the first time bot data arrives — never
  // again after that, so it doesn't fight the user editing/clearing the field afterward.
  useEffect(() => {
    if (!symbolDefaultedFromBot.current && botSymbols.length > 0) {
      setSymbol(botSymbols[0]!);
      symbolDefaultedFromBot.current = true;
    }
  }, [botSymbols]);

  // Apply a "load into backtest" request from the Strategy Finder panel — keyed on `token`
  // so re-loading the same result still re-applies it (params/dates may have been edited
  // since). Adjusted during render (React's recommended pattern for "state that depends on
  // a prop changing"), not in an effect: an effect would render once with stale values,
  // commit, then re-render with the prefilled ones — a visible flash and an extra render
  // pass for no benefit, since this isn't synchronizing with anything external.
  const [appliedPrefillToken, setAppliedPrefillToken] = useState<number | null>(null);
  if (prefill && prefill.token !== appliedPrefillToken) {
    setAppliedPrefillToken(prefill.token);
    setStrategyId(prefill.strategyId);
    setParams(prefill.params);
    setSymbol(prefill.symbol);
    setTimeframe(prefill.timeframe);
    setFrom(toDateInput(new Date(prefill.from)));
    setTo(toDateInput(new Date(prefill.to)));
    symbolDefaultedFromBot.current = true; // don't let the bot-symbol default clobber this afterward
  }

  const strategy = strategies.find((s) => s.id === strategyId);
  // Free-text symbol: any Bybit symbol can be typed. Datalist just offers convenient presets.
  const symbolSuggestions = [...new Set([...botSymbols, ...SUGGESTED_SYMBOLS])].sort();
  const visibleParams = (strategy?.params ?? []).filter(
    (p) => !p.showIf || params[p.showIf.param] === p.showIf.equals,
  );

  function handleStrategyChange(id: string) {
    setStrategyId(id);
    const next = strategies.find((s) => s.id === id);
    if (next) setParams(Object.fromEntries(next.params.map((p) => [p.name, p.default])));
  }

  async function handleCopyPine() {
    if (!strategy) return;
    setIsCopyingPine(true);
    try {
      const { pine } = await fetchBacktestPine(strategy.id, params);
      await navigator.clipboard.writeText(pine);
      toast.success("Pine script copied to clipboard");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to generate Pine script");
    } finally {
      setIsCopyingPine(false);
    }
  }

  // Shared execution config, reused by both "Run backtest" and the optimizer panel.
  const runConfigBase = {
    strategyId,
    symbol,
    timeframe,
    from: new Date(`${from}T00:00:00Z`).toISOString(),
    to: new Date(`${to}T23:59:59Z`).toISOString(),
    initialCapital: Number(initialCapital) || 10_000,
    maxPositionUsd: Number(maxPositionUsd) || 1_000,
    leverage: Number(leverage) || 5,
    feeBps: Number(feeBps) || 0,
    slippageBps: Number(slippageBps) || 0,
    fillModel,
  };

  function handleRun() {
    if (!strategyId || !symbol) return;
    onRun({ ...runConfigBase, params });
  }

  return (
    <div className="bg-card border border-border rounded-[14px] p-5 space-y-5">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <div className="flex flex-col gap-1.5 min-w-0 col-span-2">
          <label className="data-label">Strategy</label>
          <Select
            value={strategyId}
            onChange={handleStrategyChange}
            options={strategies.map((s) => ({ value: s.id, label: s.label }))}
          />
        </div>
        <div className="flex flex-col gap-1.5 min-w-0">
          <label className="data-label">Symbol</label>
          <input
            type="text"
            list="backtest-symbol-suggestions"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase().trim())}
            placeholder="e.g. BTCUSDT"
            className="bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors"
          />
          <datalist id="backtest-symbol-suggestions">
            {symbolSuggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5 min-w-0">
          <label className="data-label">Timeframe</label>
          <Select value={timeframe} onChange={(v) => setTimeframe(v as BacktestTimeframe)} options={TIMEFRAMES} />
        </div>
      </div>

      {strategy && (
        <div>
          <div className="data-label mb-2">{strategy.label} parameters</div>
          <p className="text-xs text-text-3 mb-3">{strategy.description}</p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
            {visibleParams.map((p) => (
              <ParamField
                key={p.name}
                param={p}
                value={params[p.name] ?? p.default}
                onChange={(v) => setParams((prev) => ({ ...prev, [p.name]: v }))}
              />
            ))}
          </div>

          <div className="mt-4">
            <BacktestOptimizePanel
              sweepableParams={visibleParams.filter((p) => !p.options)}
              baseParams={params}
              runConfigBase={runConfigBase}
              onApplyParams={(applied) => setParams((prev) => ({ ...prev, ...applied }))}
            />
          </div>
        </div>
      )}

      <div>
        <div className="data-label mb-2">Backtest window</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Field label="From" type="date" value={from} onChange={setFrom} />
          <Field label="To" type="date" value={to} onChange={setTo} />
        </div>
      </div>

      <div>
        <div className="data-label mb-2">Execution</div>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
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
                { value: "signalClose", label: "Signal close (live-bot parity)" },
                { value: "nextOpen", label: "Next bar open (TradingView parity)" },
              ]}
            />
          </div>
        </div>
      </div>

      <div className="flex justify-end items-center gap-3 pt-1">
        <button
          onClick={() => { void handleCopyPine(); }}
          disabled={!strategy?.supportsPine || isCopyingPine}
          title={strategy && !strategy.supportsPine ? `${strategy.label} doesn't support Pine export` : undefined}
          className="px-4 py-2.5 rounded-xl text-sm font-medium bg-surface border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isCopyingPine ? "Generating…" : "Copy as Pine Script"}
        </button>
        <button
          onClick={handleRun}
          disabled={isRunning || !strategyId || !symbol}
          className="px-5 py-2.5 rounded-xl text-sm font-semibold bg-green text-base hover:bg-green/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {isRunning ? "Running…" : "Run backtest"}
        </button>
      </div>
    </div>
  );
};

// Renders a numeric Field, or a Select (index ↔ label) when the param declares `options`.
const ParamField: FC<{ param: BacktestStrategyParam; value: number; onChange: (v: number) => void }> = ({ param, value, onChange }) => {
  if (param.options) {
    return (
      <div className="flex flex-col gap-1.5 min-w-0">
        <label className="data-label">{param.label}</label>
        <Select
          value={String(value)}
          onChange={(v) => onChange(Number(v))}
          options={param.options.map((label, idx) => ({ value: String(idx), label }))}
        />
      </div>
    );
  }
  return (
    <Field
      label={param.label}
      type="number"
      min={String(param.min)}
      step={String(param.step)}
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
    />
  );
};
