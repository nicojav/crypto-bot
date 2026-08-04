import { useEffect, useRef, type FC } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { fetchBacktestCandles, type BacktestMarker, type BacktestTimeframe } from "../../api/client";

interface BacktestChartProps {
  symbol: string;
  timeframe: BacktestTimeframe;
  from: string;
  to: string;
  markers: BacktestMarker[];
}

const toSeconds = (ms: number): UTCTimestamp => Math.floor(ms / 1000) as UTCTimestamp;

export const BacktestChart: FC<BacktestChartProps> = ({ symbol, timeframe, from, to, markers }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: ["backtest", "candles", symbol, timeframe, from, to],
    queryFn: () => fetchBacktestCandles({ symbol, timeframe, from, to }),
    staleTime: 60_000,
  });

  // Create the chart once per mount.
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      layout: { background: { color: "#17171a" }, textColor: "#8a8a95", fontFamily: "IBM Plex Mono" },
      grid: { vertLines: { color: "#2a2a2e" }, horzLines: { color: "#2a2a2e" } },
      rightPriceScale: { borderColor: "#2a2a2e" },
      timeScale: { borderColor: "#2a2a2e" },
      crosshair: { mode: 0 },
      autoSize: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#34d399",
      downColor: "#f87171",
      borderVisible: false,
      wickUpColor: "#34d399",
      wickDownColor: "#f87171",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Push candle data whenever the fetched window changes.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !data) return;
    series.setData(
      data.candles.map((c) => ({
        time: toSeconds(c.openTime),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [data]);

  // Overlay entry/exit markers, clipped to the visible candle window.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !data || data.candles.length === 0) return;

    const minTime = data.candles[0]!.openTime;
    const maxTime = data.candles[data.candles.length - 1]!.openTime;

    const seriesMarkers: SeriesMarker<Time>[] = markers
      .filter((m) => m.time >= minTime && m.time <= maxTime)
      .sort((a, b) => a.time - b.time)
      .map((m) => {
        if (m.kind === "long") {
          return { time: toSeconds(m.time), position: "belowBar", shape: "arrowUp", color: "#34d399", text: "Long" };
        }
        if (m.kind === "short") {
          return { time: toSeconds(m.time), position: "aboveBar", shape: "arrowDown", color: "#f87171", text: "Short" };
        }
        const exitColor = m.exitReason === "tp" ? "#34d399" : m.exitReason === "sl" ? "#f87171" : "#fbbf24";
        return { time: toSeconds(m.time), position: "inBar", shape: "circle", color: exitColor, text: "Exit" };
      });

    const plugin = createSeriesMarkers(series, seriesMarkers);
    return () => plugin.detach();
  }, [data, markers]);

  return (
    <div className="bg-card border border-border rounded-[14px] p-5">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-sm text-text-1">
          {symbol} · {timeframe} chart
        </h3>
        {data?.truncated && (
          <span className="text-[11px] text-amber font-mono">
            Showing most recent {data.candles.length.toLocaleString()} of {data.totalAvailable.toLocaleString()} candles — narrow the date range for full detail
          </span>
        )}
      </div>
      <div className="relative h-[420px]">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center text-text-3 text-sm z-10 bg-card/60">Loading candles…</div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
};
