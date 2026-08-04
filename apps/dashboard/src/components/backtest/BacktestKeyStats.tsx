import type { FC } from "react";
import type { BacktestStats } from "../../api/client";

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => `${v >= 0 ? "+" : ""}${fmtUsd.format(v)}`;
const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");

function Tile({ label, value, sub, color = "text-text-1" }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-card border border-border rounded-[14px] p-4">
      <div className="data-label mb-2">{label}</div>
      <div className={`font-mono text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="font-mono text-xs text-text-3 mt-1 tabular-nums">{sub}</div>}
    </div>
  );
}

export const BacktestKeyStats: FC<{ stats: BacktestStats }> = ({ stats }) => (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <Tile
      label="Total PnL"
      value={signed(stats.totalPnlUsd)}
      sub={`${stats.totalPnlPct >= 0 ? "+" : ""}${fmtPct.format(stats.totalPnlPct)}%`}
      color={pnlColor(stats.totalPnlUsd)}
    />
    <Tile
      label="Max drawdown"
      value={fmtUsd.format(stats.maxDrawdownUsd)}
      sub={`${fmtPct.format(stats.maxDrawdownPct)}%`}
      color="text-red"
    />
    <Tile
      label="Profitable trades"
      value={`${fmtPct.format(stats.winRatePct)}%`}
      sub={`${stats.winners}/${stats.totalTrades}`}
    />
    <Tile
      label="Profit factor"
      value={stats.profitFactor === null ? "∞" : fmtPct.format(stats.profitFactor)}
    />
  </div>
);
