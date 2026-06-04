import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchTrades, type Trade, type Bot } from "../api/client";

const fmtTime = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtQty = new Intl.NumberFormat("en-US", { minimumFractionDigits: 4, maximumFractionDigits: 6 });

export function TradesTable() {
  const qc = useQueryClient();
  const { data: trades = [], isLoading } = useQuery<Trade[]>({
    queryKey: ["trades"],
    queryFn: () => fetchTrades({ limit: 50 }),
    staleTime: 30_000,
  });

  const bots = qc.getQueryData<Bot[]>(["bots"]) ?? [];
  const botName = (botId: number) => bots.find((b) => b.id === botId)?.name ?? `#${botId}`;

  return (
    <div className="bg-card border border-border rounded-[14px] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h3 className="font-semibold text-sm text-text-1">Recent trades</h3>
        <span className="font-mono text-xs text-text-3">{trades.length}</span>
      </div>

      <div className="overflow-auto max-h-72 flex-1">
        {isLoading ? (
          <div className="p-6 text-text-3 text-sm text-center">Loading…</div>
        ) : trades.length === 0 ? (
          <div className="p-6 text-text-3 text-sm text-center">No trades yet</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="data-label px-5 py-3 text-left font-normal">Opened</th>
                <th className="data-label px-4 py-3 text-left font-normal">Bot</th>
                <th className="data-label px-4 py-3 text-left font-normal">Symbol</th>
                <th className="data-label px-4 py-3 text-left font-normal">Direction</th>
                <th className="data-label px-4 py-3 text-right font-normal">Entry / Qty</th>
                <th className="data-label px-5 py-3 text-right font-normal">PnL</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => (
                <tr key={t.id} className="border-b border-border/50 hover:bg-surface/50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
                    {fmtTime.format(new Date(t.openedAt))}
                  </td>
                  <td className="px-4 py-3 text-xs text-text-2 whitespace-nowrap">
                    {botName(t.botId)}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-2">{t.symbol}</td>
                  <td className={`px-4 py-3 text-xs font-semibold ${t.side === "BUY" ? "text-green" : "text-red"}`}>
                    {t.side === "BUY" ? "Long" : "Short"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="font-mono text-xs text-text-1">{fmtUsd.format(t.entryPrice)}</div>
                    <div className="font-mono text-xs text-text-3">{fmtQty.format(t.qty)}</div>
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className={`font-mono text-sm font-medium tabular-nums ${
                      t.pnlUsd === null ? "text-text-3" :
                      t.pnlUsd >= 0 ? "text-green" : "text-red"
                    }`}>
                      {t.pnlUsd === null
                        ? "—"
                        : `${t.pnlUsd >= 0 ? "+" : ""}${fmtUsd.format(t.pnlUsd)}`}
                    </div>
                    {(t.feeOpenUsd !== null || t.feeCloseUsd !== null) && (
                      <div className="font-mono text-[10px] text-text-3 mt-0.5" title="Total fees paid">
                        fee {fmtUsd.format((t.feeOpenUsd ?? 0) + (t.feeCloseUsd ?? 0))}
                      </div>
                    )}
                    {t.pnlSource === "EXEC_FALLBACK" && (
                      <span className="inline-flex mt-0.5 items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-border/40 text-text-3 border border-border" title="Locally estimated from fill price — WS order event missed.">
                        est.
                      </span>
                    )}
                    {t.pnlSource === "BYBIT_REST" && (
                      <span className="inline-flex mt-0.5 items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-border/40 text-text-3 border border-border" title="Sourced from Bybit closedPnL REST endpoint.">
                        rest
                      </span>
                    )}
                    {t.pnlSource === "BYBIT_REST_GROUPED" && (
                      <span className="inline-flex mt-0.5 items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-border/40 text-text-3 border border-border" title="PnL is a proportional share of a grouped Bybit closedPnL entry (multiple bot trades aggregated into one Bybit position).">
                        rest-grouped
                      </span>
                    )}
                    {t.pnlSource === "BYBIT_LIQUIDATION" && (
                      <span className="inline-flex mt-0.5 items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-red/10 text-red border border-red/20" title="Position was force-closed by the exchange.">
                        liquidated
                      </span>
                    )}
                    {t.pnlSource === "PHANTOM" && (
                      <span className="inline-flex mt-0.5 items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium bg-border/40 text-text-3 border border-border" title="Position recorded locally but no execution on Bybit — counted as 0 PnL.">
                        phantom
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
