import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { fetchEquity } from "../api/client";

type Timeframe = "24h" | "7d" | "30d" | "all";

const TF_LABELS: { key: Timeframe; label: string }[] = [
  { key: "24h", label: "24H" },
  { key: "7d", label: "7D" },
  { key: "30d", label: "30D" },
  { key: "all", label: "All" },
];

function fromForTf(tf: Timeframe): string | undefined {
  if (tf === "all") return undefined;
  const ms = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 }[tf];
  return new Date(Date.now() - ms).toISOString();
}

const fmtShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fmtFull = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const fmtUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function CustomTooltip({ active, payload }: any) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload as { takenAt: string; equityUsd: number; availableUsd: number };
  return (
    <div className="bg-card border border-border rounded-xl px-3.5 py-3 text-sm shadow-xl">
      <div className="text-text-2 text-xs mb-2">{fmtFull.format(new Date(d.takenAt))}</div>
      <div className="font-mono font-medium text-text-1">{fmtUsd.format(d.equityUsd)}</div>
      <div className="font-mono text-xs text-text-2 mt-0.5">Available: {fmtUsd.format(d.availableUsd)}</div>
    </div>
  );
}

export function EquityChart() {
  const [tf, setTf] = useState<Timeframe>("24h");
  const from = fromForTf(tf);

  const { data = [], isLoading } = useQuery({
    queryKey: ["equity", tf],
    queryFn: () => fetchEquity({ from }),
    staleTime: 60_000,
  });

  const minY = data.length > 0 ? Math.min(...data.map((d) => d.equityUsd)) * 0.995 : 0;
  const maxY = data.length > 0 ? Math.max(...data.map((d) => d.equityUsd)) * 1.005 : 100;

  return (
    <div className="bg-card border border-border rounded-[14px] p-5">
      <div className="flex items-center justify-between mb-5">
        <h3 className="font-semibold text-sm text-text-1">Equity curve</h3>
        <div className="flex items-center gap-1 bg-surface rounded-lg p-1">
          {TF_LABELS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTf(key)}
              className={[
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                tf === key
                  ? "bg-card text-text-1 shadow-sm"
                  : "text-text-2 hover:text-text-1",
              ].join(" ")}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="h-52">
        {isLoading ? (
          <div className="h-full flex items-center justify-center text-text-3 text-sm">Loading…</div>
        ) : data.length === 0 ? (
          <div className="h-full flex items-center justify-center text-text-3 text-sm">No data in this range</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="equityGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#34d399" stopOpacity={0.15} />
                  <stop offset="100%" stopColor="#34d399" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="#2a2a2e" strokeDasharray="3 3" />
              <XAxis
                dataKey="takenAt"
                tickFormatter={(v: string) => fmtShort.format(new Date(v))}
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
                dataKey="equityUsd"
                stroke="#34d399"
                strokeWidth={2}
                fill="url(#equityGrad)"
                dot={false}
                activeDot={{ r: 4, fill: "#34d399", stroke: "#17171a", strokeWidth: 2 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
