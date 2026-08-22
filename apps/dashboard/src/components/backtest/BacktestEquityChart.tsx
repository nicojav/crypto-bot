import type { FC } from "react";
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from "recharts";

import type { BacktestEquityPoint } from "../../api/client";

const fmtShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "2-digit" });
const fmtFull = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

interface ChartPoint {
  time: number;
  strategy: number;
  buyHold: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as ChartPoint;
  return (
    <div className="bg-card border border-border rounded-xl px-3.5 py-3 text-sm shadow-xl">
      <div className="text-text-2 text-xs mb-2">{fmtFull.format(new Date(d.time))}</div>
      <div className="font-mono text-xs text-green">Strategy: {fmtUsd.format(d.strategy)}</div>
      <div className="font-mono text-xs text-[#60a5fa] mt-0.5">Buy &amp; hold: {fmtUsd.format(d.buyHold)}</div>
    </div>
  );
}

interface BacktestEquityChartProps {
  equityCurve: BacktestEquityPoint[];
  buyHoldCurve: BacktestEquityPoint[];
}

export const BacktestEquityChart: FC<BacktestEquityChartProps> = ({ equityCurve, buyHoldCurve }) => {
  const data: ChartPoint[] = equityCurve.map((p, i) => ({
    time: p.time,
    strategy: p.equity,
    buyHold: buyHoldCurve[i]?.equity ?? p.equity,
  }));

  const allValues = data.flatMap((d) => [d.strategy, d.buyHold]);
  const minY = allValues.length > 0 ? Math.min(...allValues) * 0.98 : 0;
  const maxY = allValues.length > 0 ? Math.max(...allValues) * 1.02 : 100;

  return (
    <div className="bg-card border border-border rounded-[14px] p-5">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-semibold text-sm text-text-1">Cumulative PnL vs. Buy &amp; Hold</h3>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <div className="w-4 h-0.5 bg-green" />
            <span className="text-[11px] text-text-3 font-mono">Strategy</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-4 border-t border-dashed border-[#60a5fa]" />
            <span className="text-[11px] text-text-3 font-mono">Buy &amp; hold</span>
          </div>
        </div>
      </div>

      <div className="h-64">
        {data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-3 text-sm">No data</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="btStrategyGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#2a2a2e" strokeDasharray="3 3" />
              <XAxis
                dataKey="time"
                tickFormatter={(v: number) => fmtShort.format(new Date(v))}
                tick={{ fill: "#45454e", fontSize: 11, fontFamily: "IBM Plex Mono" }}
                axisLine={false}
                tickLine={false}
                minTickGap={60}
              />
              <YAxis
                domain={[minY, maxY]}
                tickFormatter={(v: number) => `$${(v / 1000).toFixed(1)}k`}
                tick={{ fill: "#45454e", fontSize: 11, fontFamily: "IBM Plex Mono" }}
                axisLine={false}
                tickLine={false}
                width={54}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: "#3a3a42", strokeWidth: 1 }} />
              <Area
                type="monotone"
                dataKey="buyHold"
                stroke="#60a5fa"
                strokeWidth={1.5}
                strokeDasharray="4 3"
                fill="none"
                dot={false}
                activeDot={{ r: 3, fill: "#60a5fa", stroke: "#17171a", strokeWidth: 2 }}
              />
              <Area
                type="monotone"
                dataKey="strategy"
                stroke="#34d399"
                strokeWidth={2}
                fill="url(#btStrategyGrad)"
                dot={false}
                activeDot={{ r: 4, fill: "#34d399", stroke: "#17171a", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
};
