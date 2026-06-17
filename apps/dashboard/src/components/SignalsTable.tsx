import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSignals, type Signal } from "../api/client";
import { friendlyReason } from "../utils/rejectionSummary";

const fmtTime = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

const STATUS_STYLE: Record<string, string> = {
  EXECUTED: "bg-green/10 text-green",
  REJECTED:  "bg-red/10 text-red",
  DUPLICATE: "bg-surface text-text-3",
  PENDING:   "bg-amber/10 text-amber",
};

const ACTION_COLOR: Record<string, string> = {
  BUY:   "text-green",
  SELL:  "text-red",
  CLOSE: "text-amber",
};

export function SignalsTable() {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data: signals = [], isLoading } = useQuery<Signal[]>({
    queryKey: ["signals"],
    queryFn: () => fetchSignals({ limit: 50 }),
    staleTime: 30_000,
  });

  function toggle(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="bg-card border border-border rounded-[14px] flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border">
        <h3 className="font-semibold text-sm text-text-1">Recent signals</h3>
        <span className="font-mono text-xs text-text-3">{signals.length}</span>
      </div>

      <div className="overflow-auto max-h-72 flex-1">
        {isLoading ? (
          <div className="p-6 text-text-3 text-sm text-center">Loading…</div>
        ) : signals.length === 0 ? (
          <div className="p-6 text-text-3 text-sm text-center">No signals yet</div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border">
                <th className="data-label px-5 py-3 text-left font-normal">Time</th>
                <th className="data-label px-4 py-3 text-left font-normal">Symbol</th>
                <th className="data-label px-4 py-3 text-left font-normal">Action</th>
                <th className="data-label px-5 py-3 text-right font-normal">Status</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => {
                const isExpanded = expanded.has(s.id);
                const hasReason = s.status === "REJECTED" && Boolean(s.rejectionReason);
                const friendly = hasReason ? friendlyReason(s.rejectionReason!) : null;
                return (
                  <>
                    <tr
                      key={s.id}
                      className={`border-b ${isExpanded ? "border-border/20" : "border-border/50"} hover:bg-surface/50 transition-colors`}
                    >
                      <td className="px-5 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
                        {fmtTime.format(new Date(s.receivedAt))}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-text-2">{s.symbol}</td>
                      <td className={`px-4 py-3 font-semibold text-xs ${ACTION_COLOR[s.action] ?? "text-text-2"}`}>
                        {s.action}
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          onClick={() => hasReason && toggle(s.id)}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[s.status] ?? "bg-surface text-text-3"} ${hasReason ? "cursor-pointer" : "cursor-default"}`}
                          title={hasReason && !isExpanded ? s.rejectionReason ?? undefined : undefined}
                        >
                          {s.status.toLowerCase()}
                          {hasReason && (
                            <span className="opacity-50 text-[10px]">{isExpanded ? "▲" : "▼"}</span>
                          )}
                        </button>
                      </td>
                    </tr>
                    {hasReason && isExpanded && (
                      <tr key={`${s.id}-detail`} className="border-b border-border/50 bg-red/[0.03]">
                        <td colSpan={4} className="px-5 pb-3 pt-1">
                          {friendly && (
                            <div className="flex items-start gap-1.5 mb-2 text-xs text-amber">
                              <span className="mt-px shrink-0">⚠</span>
                              <span>{friendly}</span>
                            </div>
                          )}
                          <div className="px-3 py-2 rounded-lg bg-red/5 border border-red/15 text-xs font-mono text-red/70 break-all">
                            {s.rejectionReason}
                          </div>
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
