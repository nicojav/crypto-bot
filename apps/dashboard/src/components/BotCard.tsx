import type { FC } from "react";
import type { Bot } from "../api/client";

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  colorOn?: "green" | "amber";
}

const Toggle: FC<ToggleProps> = ({ checked, onChange, colorOn = "green" }) => {
  const trackOn = colorOn === "green" ? "bg-green" : "bg-amber";
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={[
        "inline-flex items-center h-6 w-11 rounded-full px-[3px] transition-colors duration-200 shrink-0 focus:outline-none cursor-pointer",
        checked ? trackOn : "bg-border",
      ].join(" ")}
    >
      <span
        className={[
          "block h-[18px] w-[18px] rounded-full bg-white shadow transition-transform duration-200",
          checked ? "translate-x-[17px]" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
};

interface BotCardProps {
  bot: Bot;
  onToggle: (id: number, enabled: boolean) => void;
  onToggleDryRun: (id: number, dryRun: boolean) => void;
  onEdit: (bot: Bot) => void;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const BotCard: FC<BotCardProps> = ({ bot, onToggle, onToggleDryRun, onEdit }) => (
  <div className="bg-card border border-border rounded-[14px] p-4 flex flex-col gap-4 animate-slide-up hover:border-border-bright transition-colors">

    {/* Top row */}
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-2.5">
        <div className={`w-2 h-2 rounded-full mt-0.5 shrink-0 ${bot.enabled ? "bg-green" : "bg-text-3"}`} />
        <div>
          <div className="font-semibold text-sm text-text-1">{bot.name}</div>
          <div className="font-mono text-xs text-text-2 mt-0.5">{bot.symbol}</div>
        </div>
      </div>
      <button
        onClick={() => onEdit(bot)}
        aria-label="Edit bot"
        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-surface transition-colors"
      >
        <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
          <path d="M9 2l2 2-6.5 6.5L2 11l.5-2.5L9 2z" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    </div>

    {/* Toggles */}
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-2">Live trading</span>
        <Toggle checked={bot.enabled} onChange={(v) => onToggle(bot.id, v)} colorOn="green" />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-2">Dry run</span>
        <Toggle checked={bot.dryRun} onChange={(v) => onToggleDryRun(bot.id, v)} colorOn="amber" />
      </div>
    </div>

    {/* Stats */}
    <div className="border-t border-border pt-3 flex items-center justify-between">
      <div>
        <div className="data-label mb-0.5">Open positions</div>
        <div className={`font-mono text-sm font-medium ${bot.openTradeCount > 0 ? "text-text-1" : "text-text-3"}`}>
          {bot.openTradeCount}
        </div>
      </div>
      <div className="text-right">
        <div className="data-label mb-0.5">Max size</div>
        <div className="font-mono text-sm text-text-2">{usd.format(bot.maxPositionUsd)}</div>
      </div>
    </div>
  </div>
);
