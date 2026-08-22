import type { FC } from "react";

import type { BacktestStats } from "../../api/client";
import { Tooltip } from "../ui/Tooltip";

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtRatio = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = (v: number) => `${v >= 0 ? "+" : ""}${fmtUsd.format(v)}`;
const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");
const ratioColor = (v: number) => (v > 0 ? "text-green" : v < 0 ? "text-red" : "text-text-1");

function Tile({ label, help, value, sub, color = "text-text-1" }: { label: string; help: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="bg-card border border-border rounded-[14px] p-4">
      <Tooltip text={help} triggerClassName="data-label mb-2 inline-block cursor-help border-b border-dotted border-text-3/60">
        {label}
      </Tooltip>
      <div className={`font-mono text-xl font-semibold tabular-nums ${color}`}>{value}</div>
      {sub && <div className="font-mono text-xs text-text-3 mt-1 tabular-nums">{sub}</div>}
    </div>
  );
}

export const BacktestKeyStats: FC<{ stats: BacktestStats }> = ({ stats }) => (
  <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
    <Tile
      label="Total PnL"
      help="Net profit or loss over the whole backtest window, after fees, slippage, and funding."
      value={signed(stats.totalPnlUsd)}
      sub={`${stats.totalPnlPct >= 0 ? "+" : ""}${fmtPct.format(stats.totalPnlPct)}%`}
      color={pnlColor(stats.totalPnlUsd)}
    />
    <Tile
      label="Max drawdown"
      help="The largest peak-to-trough decline in equity at any point in the backtest — including swings that happened within a single bar, not just at candle closes."
      value={fmtUsd.format(stats.maxDrawdownUsd)}
      sub={`${fmtPct.format(stats.maxDrawdownPct)}%`}
      color="text-red"
    />
    <Tile
      label="Profitable trades"
      help="Share of closed trades that made money (win rate)."
      value={`${fmtPct.format(stats.winRatePct)}%`}
      sub={`${stats.winners}/${stats.totalTrades}`}
    />
    <Tile
      label="Profit factor"
      help="Gross profit divided by gross loss. Above 1 means the winners outweighed the losers overall; ∞ means there were no losing trades yet."
      value={stats.profitFactor === null ? "∞" : fmtPct.format(stats.profitFactor)}
    />
    <Tile
      label="Sharpe"
      help="Risk-adjusted return: average return divided by its volatility, annualized. Higher is better. Penalizes upside and downside volatility equally, so a strategy with big winning swings can score lower here than you'd expect."
      value={fmtRatio.format(stats.sharpeRatio)}
      sub="annualized"
      color={ratioColor(stats.sharpeRatio)}
    />
    <Tile
      label="Sortino"
      help="Like Sharpe, but only penalizes downside volatility — big upside swings don't count against it. A strategy with occasional large wins and small, steady losses scores higher here than under Sharpe."
      value={fmtRatio.format(stats.sortinoRatio)}
      sub="downside-only"
      color={ratioColor(stats.sortinoRatio)}
    />
    <Tile
      label="Calmar"
      help="Annualized return (CAGR) divided by max drawdown %. Answers: how much return did this strategy produce per unit of the worst drawdown you'd have had to sit through?"
      value={fmtRatio.format(stats.calmarRatio)}
      sub="CAGR / max DD"
      color={ratioColor(stats.calmarRatio)}
    />
    <Tile
      label="Exposure"
      help="Share of the backtest window spent holding an open position rather than flat. High exposure means more time at risk (and more funding paid on perpetuals); low exposure means the strategy mostly sits out."
      value={`${fmtPct.format(stats.exposurePct)}%`}
      sub="of window in a position"
    />
  </div>
);
