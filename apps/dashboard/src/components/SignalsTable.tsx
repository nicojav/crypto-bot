import { useQuery } from "@tanstack/react-query";
import { fetchSignals, type Signal } from "../api/client";

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
  const { data: signals = [], isLoading } = useQuery<Signal[]>({
    queryKey: ["signals"],
    queryFn: () => fetchSignals({ limit: 50 }),
    staleTime: 30_000,
  });

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
              {signals.map((s) => (
                <tr key={s.id} className="border-b border-border/50 hover:bg-surface/50 transition-colors">
                  <td className="px-5 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
                    {fmtTime.format(new Date(s.receivedAt))}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-text-2">{s.symbol}</td>
                  <td className={`px-4 py-3 font-semibold text-xs ${ACTION_COLOR[s.action] ?? "text-text-2"}`}>
                    {s.action}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${STATUS_STYLE[s.status] ?? "bg-surface text-text-3"}`}>
                      {s.status.toLowerCase()}
                    </span>
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
