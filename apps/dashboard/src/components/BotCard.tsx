import { type FC, useState, useCallback } from "react";
import type { Bot } from "../api/client";
import { Switch } from "./ui/Switch";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";

interface BotCardProps {
  bot: Bot;
  onToggle: (id: number, enabled: boolean) => void;
  onToggleDryRun: (id: number, dryRun: boolean) => void;
  onEdit: (bot: Bot) => void;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const BotCard: FC<BotCardProps> = ({ bot, onToggle, onToggleDryRun, onEdit }) => {
  const [copied, setCopied] = useState(false);

  const copyWebhook = useCallback(() => {
    void navigator.clipboard.writeText(`${API_URL}/webhook/${bot.id}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bot.id]);

  return (
  <div className="bg-card border border-border rounded-[14px] p-4 flex flex-col gap-4 animate-slide-up hover:border-border-bright transition-colors">

    {/* Top row */}
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-2.5">
        <div className={`w-2 h-2 rounded-full mt-0.5 shrink-0 ${bot.enabled ? "bg-green" : "bg-text-3"}`} />
        <div>
          <div className="font-semibold text-sm text-text-1">{bot.name}</div>
          <div className="font-mono text-xs text-text-2 mt-0.5">{bot.symbol} · <span className="text-text-3">#{bot.id}</span></div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button
          onClick={copyWebhook}
          aria-label="Copy webhook URL"
          title={`Copy webhook URL: ${API_URL}/webhook/${bot.id}`}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-surface transition-colors"
        >
          {copied ? (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <path d="M2 7l3 3 6-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
              <rect x="4.5" y="1" width="7.5" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M1 4.5h3M1 4.5v7a1.5 1.5 0 001.5 1.5H8.5v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          )}
        </button>
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
    </div>

    {/* Toggles */}
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-2">Live trading</span>
        <Switch checked={bot.enabled} onChange={(v) => onToggle(bot.id, v)} colorOn="green" />
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-2">Dry run</span>
        <Switch checked={bot.dryRun} onChange={(v) => onToggleDryRun(bot.id, v)} colorOn="amber" />
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
};
