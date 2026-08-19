import type { FC } from "react";

import type { BacktestRunResult } from "../../api/client";

const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${fmtPct.format(v)}%`;

const FILL_MODEL_LABEL: Record<string, string> = {
  signalClose: "signal close",
  nextOpen: "next bar open",
};

// Renders whichever of compareFillModel/sensitivityCheck were requested — both are opt-in, so
// most of the time neither is present and this renders nothing.
export const BacktestComparisonNotes: FC<{ result: BacktestRunResult }> = ({ result }) => {
  const { fillModelComparison, sensitivityComparison } = result;
  if (!fillModelComparison && !sensitivityComparison) return null;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      {fillModelComparison && (
        <ComparisonCard
          label={`vs. ${FILL_MODEL_LABEL[fillModelComparison.fillModel] ?? fillModelComparison.fillModel} fill`}
          primaryPct={result.stats.totalPnlPct}
          comparisonPct={fillModelComparison.stats.totalPnlPct}
        />
      )}
      {sensitivityComparison && (
        <ComparisonCard
          label={`at 2x slippage (${sensitivityComparison.slippageBps}bps) and 2x fees (${sensitivityComparison.feeBps}bps)`}
          primaryPct={result.stats.totalPnlPct}
          comparisonPct={sensitivityComparison.stats.totalPnlPct}
        />
      )}
    </div>
  );
};

const ComparisonCard: FC<{ label: string; primaryPct: number; comparisonPct: number }> = ({ label, primaryPct, comparisonPct }) => {
  const gap = comparisonPct - primaryPct;
  const survives = comparisonPct >= 0;
  return (
    <div className="bg-card border border-border rounded-xl px-4 py-3">
      <div className="text-xs text-text-3">{label}</div>
      <div className="flex items-baseline gap-2 mt-1">
        <span className={`font-mono text-sm font-semibold tabular-nums ${survives ? "text-green" : "text-red"}`}>
          {signedPct(comparisonPct)}
        </span>
        <span className="text-xs text-text-3 font-mono tabular-nums">({signedPct(gap)} vs. primary)</span>
      </div>
    </div>
  );
};
