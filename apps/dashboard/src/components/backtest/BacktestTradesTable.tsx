import { useMemo, useState, type FC } from "react";
import type { BacktestTrade } from "../../api/client";
import { fmtTime, fmtUsd, fmtQty } from "../tradeBadges";

type SortKey = "num" | "entryTime" | "entryPrice" | "qty" | "pnl";
type SortDir = "asc" | "desc";

const signedUsd = (v: number) => `${v >= 0 ? "+" : ""}${fmtUsd.format(v)}`;
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");

const EXIT_REASON_LABEL: Record<string, string> = {
  tp: "Take profit",
  sl: "Stop loss",
  reversal: "Reversal",
  windowEnd: "Window end",
};

function exportCsv(trades: BacktestTrade[]) {
  const cols: [string, (t: BacktestTrade, i: number) => string | number][] = [
    ["trade", (_t, i) => i + 1],
    ["side", (t) => (t.side === "BUY" ? "Long" : "Short")],
    ["entryTime", (t) => new Date(t.entryTime).toISOString()],
    ["exitTime", (t) => new Date(t.exitTime).toISOString()],
    ["entryPrice", (t) => t.entryPrice],
    ["exitPrice", (t) => t.exitPrice],
    ["qty", (t) => t.qty],
    ["sizeUsd", (t) => t.sizeUsd],
    ["feeUsd", (t) => t.feeUsd],
    ["netPnlUsd", (t) => t.pnlUsd],
    ["returnPct", (t) => t.pnlPct],
    ["barsHeld", (t) => t.barsHeld],
    ["exitReason", (t) => t.exitReason],
  ];
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [cols.map(([h]) => h).join(","), ...trades.map((t, i) => cols.map(([, f]) => esc(f(t, i))).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `backtest-trades-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

export const BacktestTradesTable: FC<{ trades: BacktestTrade[] }> = ({ trades }) => {
  const [sortKey, setSortKey] = useState<SortKey>("num");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

  const indexed = useMemo(() => trades.map((t, i) => ({ ...t, num: i + 1 })), [trades]);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: typeof indexed[number], b: typeof indexed[number]): number => {
      switch (sortKey) {
        case "entryPrice": return (a.entryPrice - b.entryPrice) * dir;
        case "qty": return (a.qty - b.qty) * dir;
        case "pnl": return (a.pnlUsd - b.pnlUsd) * dir;
        case "entryTime": return (a.entryTime - b.entryTime) * dir;
        case "num":
        default: return (a.num - b.num) * dir;
      }
    };
    return [...indexed].sort(cmp);
  }, [indexed, sortKey, sortDir]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  return (
    <div className="bg-card border border-border rounded-[14px] overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h3 className="font-semibold text-sm text-text-1">List of trades</h3>
        <button
          onClick={() => exportCsv(trades)}
          disabled={trades.length === 0}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-surface border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export CSV
        </button>
      </div>

      <div className="overflow-x-auto">
        {trades.length === 0 ? (
          <div className="p-10 text-text-3 text-sm text-center">No trades in this window</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <SortTh label="#" col="num" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="pl-5" />
                <th className="data-label px-4 py-3 text-left font-normal">Type</th>
                <SortTh label="Opened" col="entryTime" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                <th className="data-label px-4 py-3 text-left font-normal">Closed</th>
                <SortTh label="Entry" col="entryPrice" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                <th className="data-label px-4 py-3 text-right font-normal">Exit</th>
                <SortTh label="Size" col="qty" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                <th className="data-label px-4 py-3 text-left font-normal">Reason</th>
                <SortTh label="Net PnL" col="pnl" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" className="pr-5" />
                <th className="data-label px-4 py-3 text-right font-normal pr-5">Return</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((t) => (
                <tr key={t.num} className="border-b border-border/50 hover:bg-surface/50 transition-colors">
                  <td className="pl-5 py-3 font-mono text-xs text-text-3">{t.num}</td>
                  <td className={`px-4 py-3 text-xs font-semibold ${t.side === "BUY" ? "text-green" : "text-red"}`}>
                    {t.side === "BUY" ? "Long" : "Short"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-2 whitespace-nowrap">{fmtTime.format(new Date(t.entryTime))}</td>
                  <td className="px-4 py-3 font-mono text-xs text-text-2 whitespace-nowrap">{fmtTime.format(new Date(t.exitTime))}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-1">{fmtUsd.format(t.entryPrice)}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-2">{fmtUsd.format(t.exitPrice)}</td>
                  <td className="px-4 py-3 text-right font-mono text-xs text-text-3">{fmtQty.format(t.qty)}</td>
                  <td className="px-4 py-3 text-xs text-text-3">{EXIT_REASON_LABEL[t.exitReason] ?? t.exitReason}</td>
                  <td className="pr-5 py-3 text-right">
                    <span className={`font-mono text-sm font-medium tabular-nums ${pnlColor(t.pnlUsd)}`}>{signedUsd(t.pnlUsd)}</span>
                  </td>
                  <td className="pr-5 py-3 text-right">
                    <span className={`font-mono text-xs tabular-nums ${pnlColor(t.pnlPct)}`}>{signedPct(t.pnlPct)}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

function SortTh({
  label, col, sortKey, sortDir, onClick, align = "left", className = "",
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir;
  onClick: (c: SortKey) => void; align?: "left" | "right"; className?: string;
}) {
  const active = sortKey === col;
  return (
    <th className={`data-label px-4 py-3 font-normal ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button
        onClick={() => onClick(col)}
        className={`inline-flex items-center gap-1 hover:text-text-1 transition-colors ${active ? "text-text-1" : ""} ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <span className={`text-[9px] ${active ? "opacity-70" : "opacity-0"}`}>{sortDir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}
