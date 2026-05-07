import type { FC } from "react";

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

interface HeaderProps {
  equityUsd: number | null;
  todayPnl: number | null;
  anyBotEnabled: boolean;
  onKillSwitch: () => void;
}

export const Header: FC<HeaderProps> = ({ equityUsd, todayPnl, anyBotEnabled, onKillSwitch }) => {
  const pnlPositive = todayPnl !== null && todayPnl >= 0;

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-base/90 backdrop-blur-md">
      <div className="max-w-[1440px] mx-auto px-6 h-16 flex items-center justify-between gap-6">

        {/* Logo */}
        <div className="flex items-center gap-3 shrink-0">
          <div className="w-7 h-7 rounded-lg bg-green/15 flex items-center justify-center">
            <div className="w-2.5 h-2.5 rounded-full bg-green" />
          </div>
          <span className="font-semibold text-sm text-text-1 tracking-tight">
            CryptoBot
          </span>
        </div>

        {/* Equity */}
        <div className="flex items-baseline gap-3">
          {equityUsd !== null ? (
            <>
              <span className="font-mono text-xl font-medium text-text-1 tabular-nums">
                {usd.format(equityUsd)}
              </span>
              {todayPnl !== null && (
                <span className={`font-mono text-sm tabular-nums ${pnlPositive ? "text-green" : "text-red"}`}>
                  {pnlPositive ? "+" : ""}{usd.format(todayPnl)} today
                </span>
              )}
            </>
          ) : (
            <span className="text-text-3 font-mono text-sm">No equity data</span>
          )}
        </div>

        {/* Kill switch */}
        <button
          onClick={onKillSwitch}
          className={[
            "shrink-0 flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all duration-200 select-none",
            anyBotEnabled
              ? "bg-red/90 text-white animate-kill-pulse hover:bg-red"
              : "bg-surface text-text-2 border border-border hover:border-border-bright hover:text-text-1",
          ].join(" ")}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className="shrink-0">
            <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
          </svg>
          Kill all bots
        </button>
      </div>
    </header>
  );
};
