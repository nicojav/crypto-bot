import type { FC } from "react";
import { BarChart, Bar, Cell, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, ReferenceLine } from "recharts";
import type { BacktestStats } from "../../api/client";

const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const fmtPct = new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signedUsd = (v: number) => `${v >= 0 ? "+" : ""}${fmtUsd.format(v)}`;
const signedPct = (v: number) => `${v >= 0 ? "+" : ""}${fmtPct.format(v)}%`;
const pnlColor = (v: number) => (v >= 0 ? "text-green" : "text-red");

function Stat({ label, value, color = "text-text-1" }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div className="data-label mb-1.5">{label}</div>
      <div className={`font-mono text-sm font-medium tabular-nums ${color}`}>{value}</div>
    </div>
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function HistogramTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as { rangeStart: number; rangeEnd: number; count: number };
  return (
    <div className="bg-card border border-border rounded-xl px-3.5 py-2.5 text-xs shadow-xl">
      <div className="text-text-2">{d.rangeStart.toFixed(1)}% to {d.rangeEnd.toFixed(1)}%</div>
      <div className="font-mono text-text-1 mt-1">{d.count} trade{d.count === 1 ? "" : "s"}</div>
    </div>
  );
}

export const BacktestAnalysis: FC<{ stats: BacktestStats }> = ({ stats }) => {
  const histogramData = stats.returnsHistogram.map((b) => ({ ...b, mid: (b.rangeStart + b.rangeEnd) / 2 }));
  const donutData = [
    { name: "Winners", value: stats.winners, color: "#34d399" },
    { name: "Losers", value: stats.losers, color: "#f87171" },
    { name: "Breakevens", value: stats.breakevens, color: "#fbbf24" },
  ].filter((d) => d.value > 0);

  return (
    <div className="bg-card border border-border rounded-[14px] p-5">
      <h3 className="font-semibold text-sm text-text-1 mb-5">Trades analysis</h3>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6">
        <Stat label="Average PnL" value={`${signedUsd(stats.avgPnlUsd)} · ${signedPct(stats.avgPnlPct)}`} color={pnlColor(stats.avgPnlUsd)} />
        <Stat label="Avg bars in trade" value={stats.avgBarsHeld.toFixed(1)} />
        <Stat label="Largest profit" value={signedUsd(stats.largestProfitUsd)} color="text-green" />
        <Stat label="Largest loss" value={signedUsd(stats.largestLossUsd)} color="text-red" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-8">
        <div>
          <div className="data-label mb-3">Returns distribution</div>
          <div className="h-48">
            {histogramData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-text-3 text-sm">No trades</div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={histogramData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  <CartesianGrid vertical={false} stroke="#2a2a2e" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="mid"
                    tickFormatter={(v: number) => `${v.toFixed(0)}%`}
                    tick={{ fill: "#45454e", fontSize: 11, fontFamily: "IBM Plex Mono" }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <YAxis tick={{ fill: "#45454e", fontSize: 11, fontFamily: "IBM Plex Mono" }} axisLine={false} tickLine={false} width={28} allowDecimals={false} />
                  <ReferenceLine x={0} stroke="#3a3a42" strokeWidth={1} />
                  {stats.avgLossPct !== 0 && <ReferenceLine x={stats.avgLossPct} stroke="#f87171" strokeDasharray="3 3" strokeOpacity={0.6} />}
                  {stats.avgProfitPct !== 0 && <ReferenceLine x={stats.avgProfitPct} stroke="#34d399" strokeDasharray="3 3" strokeOpacity={0.6} />}
                  <Tooltip content={<HistogramTooltip />} cursor={{ fill: "#1e1e22" }} />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {histogramData.map((bin) => (
                      <Cell key={`${bin.rangeStart}`} fill={bin.rangeStart >= 0 ? "#34d399" : "#f87171"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="flex items-center gap-4 mt-2">
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm bg-red" />
              <span className="text-[11px] text-text-3 font-mono">Losers · avg {signedPct(stats.avgLossPct)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <div className="w-2.5 h-2.5 rounded-sm bg-green" />
              <span className="text-[11px] text-text-3 font-mono">Winners · avg {signedPct(stats.avgProfitPct)}</span>
            </div>
          </div>
        </div>

        <div>
          <div className="data-label mb-3">Trades distribution</div>
          <div className="flex items-center gap-5">
            <div className="w-32 h-32 relative shrink-0">
              {donutData.length === 0 ? (
                <div className="w-full h-full flex items-center justify-center text-text-3 text-xs">No trades</div>
              ) : (
                <>
                  <PieChart width={128} height={128}>
                    <Pie data={donutData} dataKey="value" nameKey="name" cx={64} cy={64} innerRadius={40} outerRadius={62} paddingAngle={donutData.length > 1 ? 2 : 0} stroke="none">
                      {donutData.map((d) => <Cell key={d.name} fill={d.color} />)}
                    </Pie>
                  </PieChart>
                  <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                    <span className="font-mono text-lg font-semibold text-text-1">{stats.totalTrades}</span>
                    <span className="text-[10px] text-text-3">total</span>
                  </div>
                </>
              )}
            </div>
            <div className="space-y-2">
              {donutData.map((d) => (
                <div key={d.name} className="flex items-center gap-2 text-xs">
                  <div className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: d.color }} />
                  <span className="text-text-2">{d.name}</span>
                  <span className="font-mono text-text-1">{d.value}</span>
                  <span className="font-mono text-text-3">{fmtPct.format((d.value / stats.totalTrades) * 100)}%</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
