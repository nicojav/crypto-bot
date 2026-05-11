import { type FC, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createBot } from "../api/client";
import { Switch } from "./ui/Switch";
import { Field } from "./ui/Field";

interface CreateBotDialogProps {
  open: boolean;
  onClose: () => void;
}

export const CreateBotDialog: FC<CreateBotDialogProps> = ({ open, onClose }) => {
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [dryRun, setDryRun] = useState(true);
  const [maxPosition, setMaxPosition] = useState("100");
  const [maxLeverage, setMaxLeverage] = useState("10");
  const [dailyLossLimit, setDailyLossLimit] = useState("-500");
  const qc = useQueryClient();

  const reset = () => {
    setName("");
    setSymbol("");
    setDryRun(true);
    setMaxPosition("100");
    setMaxLeverage("10");
    setDailyLossLimit("-500");
  };

  const create = useMutation({
    mutationFn: () =>
      createBot({
        name: name.trim(),
        symbol: symbol.trim().toUpperCase(),
        dryRun,
        maxPositionUsd: parseFloat(maxPosition),
        maxLeverage: parseInt(maxLeverage, 10),
        dailyLossLimitUsd: parseFloat(dailyLossLimit),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      toast.success("Bot created");
      reset();
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const isValid =
    name.trim().length > 0 &&
    symbol.trim().length > 0 &&
    !isNaN(parseFloat(maxPosition)) && parseFloat(maxPosition) > 0 &&
    !isNaN(parseInt(maxLeverage, 10)) && parseInt(maxLeverage, 10) >= 1 &&
    !isNaN(parseFloat(dailyLossLimit));

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) { reset(); onClose(); } }}
    >
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm mx-4 animate-slide-up overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-center justify-between border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-1">New Bot</h2>
            <p className="text-sm text-text-2 mt-0.5">Configure and deploy a trading bot</p>
          </div>
          <button
            onClick={() => { reset(); onClose(); }}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-surface transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 flex flex-col gap-4">
          <Field label="Bot name" value={name} onChange={setName} placeholder="BTC EMA Cross" />
          <Field label="Symbol" value={symbol} onChange={setSymbol} placeholder="BTCUSDT" />

          {/* Dry-run toggle */}
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-text-2">Dry-run mode</p>
              <p className="text-xs text-text-3 mt-0.5">Simulate trades — no real orders sent</p>
            </div>
            <Switch checked={dryRun} onChange={setDryRun} colorOn="green" />
          </div>

          <Field label="Max position (USD)" value={maxPosition} onChange={setMaxPosition} type="number" min="0.01" step="1" />
          <Field label="Max leverage" value={maxLeverage} onChange={setMaxLeverage} type="number" min="1" step="1" />
          <Field label="Daily loss limit (USD)" value={dailyLossLimit} onChange={setDailyLossLimit} type="number" step="1" hint="Negative, e.g. −500" />

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => { reset(); onClose(); }}
              className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium text-text-2 hover:border-border-bright hover:text-text-1 transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={!isValid || create.isPending}
              onClick={() => create.mutate()}
              className="flex-1 py-2.5 rounded-xl bg-green text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-dim transition-colors"
            >
              {create.isPending ? "Creating…" : "Create bot"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

