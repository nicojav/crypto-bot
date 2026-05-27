import { useQuery } from "@tanstack/react-query";
import { fetchEquitySummary, type EquitySummary } from "../api/client";

const todayMidnight = () => new Date(new Date().setHours(0, 0, 0, 0)).toISOString();

const fmtUsd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  signDisplay: "always",
});

function Stat({ label, value, dimmed }: { label: string; value: number; dimmed?: boolean }) {
  const isPos = value >= 0;
  return (
    <div className="flex items-center gap-1.5 text-[11px] font-mono">
      <span className="text-text-3">{label}</span>
      <span className={dimmed ? "text-text-3" : isPos ? "text-green" : "text-red"}>
        {fmtUsd.format(value)}
      </span>
    </div>
  );
}

function Divider() {
  return <div className="w-px h-3 bg-border mx-1" />;
}

export function EquityBreakdown() {
  const { data } = useQuery<EquitySummary>({
    queryKey: ["equitySummary", "today"],
    queryFn: () => fetchEquitySummary({ from: todayMidnight() }),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (!data || data.tradeCount === 0) return null;

  const netRealized = data.sumRealizedPnlUsd - data.sumFeeUsd;
  const hasFunding = Math.abs(data.sumFundingUsd) > 0.001;
  const unexplained = Math.abs(data.residualUsd) > 0.01 ? data.residualUsd : null;

  return (
    <div className="flex items-center gap-1 px-4 py-2.5 bg-surface border border-border rounded-xl overflow-x-auto whitespace-nowrap">
      <span className="text-[10px] text-text-3 font-medium uppercase tracking-wider mr-2">Today</span>
      <Stat label="Δ equity" value={data.deltaEquityUsd} />
      <Divider />
      <Stat label="realized" value={data.sumRealizedPnlUsd} />
      <Divider />
      <Stat label="fees" value={-data.sumFeeUsd} />
      {hasFunding && (
        <>
          <Divider />
          <Stat label="funding" value={data.sumFundingUsd} />
        </>
      )}
      <Divider />
      <Stat label="net" value={netRealized} />
      {unexplained !== null && (
        <>
          <Divider />
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            <span className="text-text-3">unexplained</span>
            <span className="text-text-3" title="Likely: unrealized PnL change + funding">{fmtUsd.format(unexplained)}</span>
          </div>
        </>
      )}
      <span className="text-[10px] text-text-3 ml-2">{data.tradeCount} trade{data.tradeCount !== 1 ? "s" : ""}</span>
    </div>
  );
}
