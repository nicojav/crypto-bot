import { useQuery } from "@tanstack/react-query";
import { fetchPositions, type Position } from "../api/client";

const fmtTime = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtPrice = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 });
const fmtQty = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 });

function PnlBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-text-3">—</span>;
  const positive = value >= 0;
  return (
    <span className={`font-mono font-medium tabular-nums ${positive ? "text-green" : "text-red"}`}>
      {positive ? "+" : ""}{fmtUsd.format(value)}
    </span>
  );
}

function PositionRow({ pos }: { pos: Position }) {
  const isLong = pos.side === "BUY";
  const isClosing = pos.status === "CLOSING";
  const entryDisplay = pos.entryFillPrice ?? pos.entryPrice;

  return (
    <tr className="border-b border-border/50 hover:bg-surface/50 transition-colors">
      <td className="px-5 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
        {fmtTime.format(new Date(pos.openedAt))}
      </td>
      <td className="px-4 py-3 font-mono text-xs text-text-2">{pos.symbol}</td>
      <td className={`px-4 py-3 text-xs font-semibold ${isLong ? "text-green" : "text-red"}`}>
        {isLong ? "Long" : "Short"}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="font-mono text-xs text-text-1">{fmtPrice.format(entryDisplay)}</div>
        <div className="font-mono text-xs text-text-3">{fmtQty.format(pos.qty)}</div>
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-text-2">
        {pos.markPrice !== null ? fmtPrice.format(pos.markPrice) : "—"}
      </td>
      <td className="px-5 py-3 text-right text-sm">
        <PnlBadge value={pos.unrealisedPnl} />
        {(pos.feeOpenUsd ?? 0) > 0 && (
          <div className="font-mono text-[10px] text-text-3 mt-0.5">fee {fmtUsd.format(pos.feeOpenUsd!)}</div>
        )}
      </td>
      <td className="px-4 py-3">
        {isClosing ? (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-yellow-500/10 text-yellow-400 border border-yellow-500/20">
            closing
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-green/10 text-green border border-green/20">
            open
          </span>
        )}
      </td>
    </tr>
  );
}

export function OpenPositions() {
  const { data: positions = [], isLoading } = useQuery<Position[]>({
    queryKey: ["positions"],
    queryFn: fetchPositions,
    staleTime: 5_000,
    refetchInterval: 10_000,
  });

  if (!isLoading && positions.length === 0) return null;

  return (
    <div className="bg-card border border-border rounded-[14px] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-sm text-text-1">Open positions</h3>
          {positions.length > 0 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-mono font-medium bg-green/10 text-green border border-green/20">
              {positions.length}
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-text-3">live · 10s refresh</span>
      </div>

      <div className="overflow-auto">
        {isLoading ? (
          <div className="p-6 text-text-3 text-sm text-center">Loading…</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="data-label px-5 py-3 text-left font-normal">Opened</th>
                <th className="data-label px-4 py-3 text-left font-normal">Symbol</th>
                <th className="data-label px-4 py-3 text-left font-normal">Direction</th>
                <th className="data-label px-4 py-3 text-right font-normal">Entry / Qty</th>
                <th className="data-label px-4 py-3 text-right font-normal">Mark</th>
                <th className="data-label px-5 py-3 text-right font-normal">Unrealized PnL</th>
                <th className="data-label px-4 py-3 text-left font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => (
                <PositionRow key={pos.tradeId} pos={pos} />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
