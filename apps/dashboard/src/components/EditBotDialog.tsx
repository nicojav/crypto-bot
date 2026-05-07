import { type FC, useState, useEffect } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { patchBot, type Bot } from "../api/client";

interface EditBotDialogProps {
  bot: Bot;
  onClose: () => void;
}

export const EditBotDialog: FC<EditBotDialogProps> = ({ bot, onClose }) => {
  const [maxPosition, setMaxPosition] = useState(String(bot.maxPositionUsd));
  const [maxLeverage, setMaxLeverage] = useState(String(bot.maxLeverage));
  const [dailyLossLimit, setDailyLossLimit] = useState(String(bot.dailyLossLimitUsd));
  const qc = useQueryClient();

  useEffect(() => {
    setMaxPosition(String(bot.maxPositionUsd));
    setMaxLeverage(String(bot.maxLeverage));
    setDailyLossLimit(String(bot.dailyLossLimitUsd));
  }, [bot]);

  const save = useMutation({
    mutationFn: () =>
      patchBot(bot.id, {
        maxPositionUsd: parseFloat(maxPosition),
        maxLeverage: parseInt(maxLeverage, 10),
        dailyLossLimitUsd: parseFloat(dailyLossLimit),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["bots"] });
      toast.success("Bot updated");
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message);
    },
  });

  const isValid =
    !isNaN(parseFloat(maxPosition)) && parseFloat(maxPosition) > 0 &&
    !isNaN(parseInt(maxLeverage, 10)) && parseInt(maxLeverage, 10) >= 1 &&
    !isNaN(parseFloat(dailyLossLimit));

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm animate-fade-in"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-card border border-border rounded-2xl w-full max-w-sm mx-4 animate-slide-up overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-4 flex items-center justify-between border-b border-border">
          <div>
            <h2 className="text-base font-semibold text-text-1">{bot.name}</h2>
            <p className="text-sm text-text-2 mt-0.5">{bot.symbol} · Risk limits</p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-surface transition-colors"
          >
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M1 1l10 10M11 1L1 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {/* Form */}
        <div className="px-6 py-5 flex flex-col gap-4">
          <Field label="Max position (USD)" value={maxPosition} onChange={setMaxPosition} type="number" min="0.01" step="1" />
          <Field label="Max leverage" value={maxLeverage} onChange={setMaxLeverage} type="number" min="1" step="1" />
          <Field label="Daily loss limit (USD)" value={dailyLossLimit} onChange={setDailyLossLimit} type="number" step="1" hint="Negative value, e.g. −500" />

          <div className="flex gap-2 pt-1">
            <button
              onClick={onClose}
              className="flex-1 py-2.5 rounded-xl border border-border text-sm font-medium text-text-2 hover:border-border-bright hover:text-text-1 transition-colors"
            >
              Cancel
            </button>
            <button
              disabled={!isValid || save.isPending}
              onClick={() => save.mutate()}
              className="flex-1 py-2.5 rounded-xl bg-green text-white text-sm font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-dim transition-colors"
            >
              {save.isPending ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  min?: string;
  step?: string;
  hint?: string;
}

const Field: FC<FieldProps> = ({ label, value, onChange, type = "text", min, step, hint }) => (
  <div className="flex flex-col gap-1.5">
    <div className="flex items-center justify-between">
      <label className="text-sm font-medium text-text-2">{label}</label>
      {hint && <span className="text-xs text-text-3 font-mono">{hint}</span>}
    </div>
    <input
      type={type}
      value={value}
      min={min}
      step={step}
      onChange={(e) => onChange(e.target.value)}
      className="bg-surface border border-border rounded-xl px-4 py-2.5 text-sm font-mono text-text-1 focus:outline-none focus:border-border-bright transition-colors"
    />
  </div>
);
