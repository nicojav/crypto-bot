import { type FC, useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import type { Bot } from "../api/client";
import { Switch } from "./ui/Switch";

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? "http://localhost:3000";

interface BotCardProps {
  bot: Bot;
  mismatchCount?: number;
  onToggle: (id: number, enabled: boolean) => void;
  onToggleDryRun: (id: number, dryRun: boolean) => void;
}

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const BotCard: FC<BotCardProps> = ({ bot, mismatchCount = 0, onToggle, onToggleDryRun }) => {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);

  const copyWebhook = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard.writeText(`${API_URL}/webhook/${bot.id}`).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [bot.id]);

  return (
  <div
    onClick={() => navigate(`/bots/${bot.id}`)}
    className="bg-card border border-border rounded-[14px] p-4 flex flex-col gap-4 animate-slide-up hover:border-border-bright transition-colors cursor-pointer"
  >

    {/* Top row */}
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-2.5 min-w-0">
        <div className={`w-2 h-2 rounded-full mt-0.5 shrink-0 ${bot.enabled ? "bg-green" : "bg-text-3"}`} />
        <div className="min-w-0">
          <div className="font-semibold text-sm text-text-1 truncate">{bot.name}</div>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="font-mono text-xs text-text-2">{bot.symbol}</span>
            <span className="text-text-3 text-xs">·</span>
            <span className="font-mono text-xs text-text-3">#{bot.id}</span>
            {mismatchCount > 0 && (
              <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full bg-amber/10 text-amber text-[10px] font-medium">
                ⚠ {mismatchCount} mismatch{mismatchCount > 1 ? "es" : ""}
              </span>
            )}
          </div>
        </div>
      </div>
      <button
        onClick={copyWebhook}
        aria-label="Copy webhook URL"
        title={`Copy webhook URL: ${API_URL}/webhook/${bot.id}`}
        className="w-7 h-7 rounded-lg flex items-center justify-center text-text-3 hover:text-text-1 hover:bg-surface transition-colors shrink-0"
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
    </div>

    {/* Toggles — stop propagation so they don't navigate */}
    <div className="flex flex-col gap-2.5" onClick={(e) => e.stopPropagation()}>
      <div className="flex items-center justify-between">
        <span className="text-sm text-text-2">Enabled</span>
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
