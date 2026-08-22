import { useState, type FC } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { fetchStorageStats, previewPruneCandles, pruneCandles, type PruneCandlesResult } from "../api/client";
import { Field } from "./ui/Field";

const fmtGb = (bytes: number) => `${(bytes / 1_073_741_824).toFixed(2)} GB`;
const fmtDate = (ms: number | null) => (ms == null ? "—" : new Date(ms).toLocaleDateString());
const fmtCount = new Intl.NumberFormat("en-US");

export const STORAGE_STATS_QUERY_KEY = ["storage", "stats"] as const;

export const StoragePanel: FC = () => {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: STORAGE_STATS_QUERY_KEY,
    queryFn: fetchStorageStats,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  const [olderThanDays, setOlderThanDays] = useState("365");
  const [symbol, setSymbol] = useState("");
  const [preview, setPreview] = useState<PruneCandlesResult | null>(null);

  const previewMutation = useMutation({
    mutationFn: () => previewPruneCandles({ olderThanDays: Number(olderThanDays) || 365, symbol: symbol.trim() || undefined }),
    onSuccess: (result) => setPreview(result),
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to preview prune"),
  });

  const pruneMutation = useMutation({
    mutationFn: () => pruneCandles({ olderThanDays: Number(olderThanDays) || 365, symbol: symbol.trim() || undefined }),
    onSuccess: (result) => {
      toast.success(`Deleted ${result.candles} candles and ${result.fundingRates} funding rate rows`);
      setPreview(null);
      void qc.invalidateQueries({ queryKey: STORAGE_STATS_QUERY_KEY });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to prune"),
  });

  if (!data) return null;

  const isCritical = data.percentUsed >= data.criticalThresholdPct;
  const barColor = isCritical ? "bg-red" : data.percentUsed >= data.criticalThresholdPct * 0.8 ? "bg-amber" : "bg-green";

  return (
    <div className="bg-card border border-border rounded-[14px] overflow-hidden">
      <div className="px-5 py-4 border-b border-border">
        <h3 className="text-sm font-semibold text-text-1">Storage</h3>
        <p className="text-xs text-text-3 mt-1">
          The bot's SQLite database, on a single {fmtGb(data.volumeSizeBytes)} disk shared with live trading data.
          Candle and funding-rate caches grow with every backtest — prune what you no longer need below.
        </p>
      </div>

      <div className="px-5 py-4 space-y-3 border-b border-border">
        <div className="flex items-center justify-between text-xs font-mono">
          <span className="text-text-2">{fmtGb(data.dbSizeBytes)} / {fmtGb(data.volumeSizeBytes)}</span>
          <span className={isCritical ? "text-red font-semibold" : "text-text-3"}>{data.percentUsed.toFixed(1)}%</span>
        </div>
        <div className="h-2 bg-surface rounded-full overflow-hidden">
          <div className={`h-full transition-all duration-300 ${barColor}`} style={{ width: `${Math.min(100, data.percentUsed)}%` }} />
        </div>
      </div>

      <div className="px-5 py-4 grid grid-cols-2 gap-4 border-b border-border">
        <div>
          <div className="data-label mb-1">Candles</div>
          <div className="text-sm font-mono text-text-1">{fmtCount.format(data.candles.rowCount)} rows</div>
          <div className="text-xs text-text-3 mt-0.5">{fmtDate(data.candles.oldest)} – {fmtDate(data.candles.newest)}</div>
        </div>
        <div>
          <div className="data-label mb-1">Funding rates</div>
          <div className="text-sm font-mono text-text-1">{fmtCount.format(data.fundingRates.rowCount)} rows</div>
          <div className="text-xs text-text-3 mt-0.5">{fmtDate(data.fundingRates.oldest)} – {fmtDate(data.fundingRates.newest)}</div>
        </div>
      </div>

      <div className="px-5 py-4 space-y-3">
        <div className="data-label">Prune old backtest data</div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Older than" type="number" min="1" value={olderThanDays} onChange={(v) => { setOlderThanDays(v); setPreview(null); }} hint="days" />
          <Field label="Symbol" value={symbol} onChange={(v) => { setSymbol(v); setPreview(null); }} placeholder="all symbols" />
        </div>

        {preview && (
          <div className="bg-surface border border-border rounded-xl px-4 py-3 text-sm text-text-2">
            This will delete <strong className="text-text-1">{fmtCount.format(preview.candles)}</strong> candle rows and{" "}
            <strong className="text-text-1">{fmtCount.format(preview.fundingRates)}</strong> funding rate rows.
          </div>
        )}

        <div className="flex justify-end gap-2">
          {!preview ? (
            <button
              onClick={() => previewMutation.mutate()}
              disabled={previewMutation.isPending}
              className="text-xs font-medium px-3 py-2 rounded-lg bg-surface border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors disabled:opacity-40"
            >
              {previewMutation.isPending ? "Checking…" : "Preview"}
            </button>
          ) : (
            <>
              <button
                onClick={() => setPreview(null)}
                className="text-xs font-medium px-3 py-2 rounded-lg bg-surface border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => pruneMutation.mutate()}
                disabled={pruneMutation.isPending || (preview.candles === 0 && preview.fundingRates === 0)}
                className="text-xs font-semibold px-3 py-2 rounded-lg bg-red/15 border border-red/40 text-red hover:bg-red/25 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {pruneMutation.isPending ? "Deleting…" : "Confirm delete"}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
