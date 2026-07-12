import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { fetchTrades, fetchBots, type Trade, type Bot } from "../api/client";
import { Select } from "../components/ui/Select";
import { fmtTime, fmtUsd, fmtQty, PnlSourceBadge, PNL_SOURCE_BADGE, totalFee, hasFee } from "../components/tradeBadges";

const fmtFull = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric", year: "numeric",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const fmtPct = new Intl.NumberFormat("en-US", { style: "percent", minimumFractionDigits: 0, maximumFractionDigits: 0 });

type SortKey = "openedAt" | "symbol" | "entryPrice" | "qty" | "pnl";
type SortDir = "asc" | "desc";

const PAGE = 200;
const MAX_LIMIT = 500;

// Convert a native date-input value (YYYY-MM-DD, local) to an ISO instant.
const dayStart = (d: string) => (d ? new Date(`${d}T00:00:00`).toISOString() : undefined);
const dayEnd = (d: string) => (d ? new Date(`${d}T23:59:59.999`).toISOString() : undefined);

const signedUsd = (v: number) => `${v >= 0 ? "+" : ""}${fmtUsd.format(v)}`;
const pnlColor = (v: number | null) => (v === null ? "text-text-3" : v >= 0 ? "text-green" : "text-red");

export default function TradesPage() {
  // Server-side filters (drive the query)
  const [botId, setBotId] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [limit, setLimit] = useState(PAGE);

  // Client-side filters
  const [symbol, setSymbol] = useState("all");
  const [side, setSide] = useState("all");
  const [status, setStatus] = useState("all");
  const [source, setSource] = useState("all");
  const [search, setSearch] = useState("");

  const [sortKey, setSortKey] = useState<SortKey>("openedAt");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const { data: bots = [] } = useQuery<Bot[]>({ queryKey: ["bots"], queryFn: fetchBots, staleTime: 30_000 });
  const botName = (id: number) => bots.find((b) => b.id === id)?.name ?? `#${id}`;

  const { data: trades = [], isLoading } = useQuery<Trade[]>({
    queryKey: ["trades", { botId, from, to, limit }],
    queryFn: () => fetchTrades({
      botId: botId === "all" ? undefined : Number(botId),
      from: dayStart(from),
      to: dayEnd(to),
      limit,
    }),
    staleTime: 30_000,
  });

  const symbols = useMemo(
    () => [...new Set(bots.map((b) => b.symbol))].sort(),
    [bots],
  );

  // pnlSource values actually present in the current result set
  const sources = useMemo(() => {
    const set = new Set<string>();
    for (const t of trades) set.add(t.pnlSource ?? "none");
    return [...set].sort();
  }, [trades]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = trades.filter((t) => {
      if (symbol !== "all" && t.symbol !== symbol) return false;
      if (side !== "all" && t.side !== side) return false;
      if (status !== "all" && t.status !== status) return false;
      if (source !== "all" && (t.pnlSource ?? "none") !== source) return false;
      if (q) {
        const hay = `${t.symbol} ${botName(t.botId)} ${t.exchangeOrderId} ${t.id}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    const cmp = (a: Trade, b: Trade): number => {
      switch (sortKey) {
        case "symbol": return a.symbol.localeCompare(b.symbol) * dir;
        case "entryPrice": return (a.entryPrice - b.entryPrice) * dir;
        case "qty": return (a.qty - b.qty) * dir;
        case "pnl": {
          // Nulls always sort to the bottom regardless of direction.
          if (a.pnlUsd === null && b.pnlUsd === null) return 0;
          if (a.pnlUsd === null) return 1;
          if (b.pnlUsd === null) return -1;
          return (a.pnlUsd - b.pnlUsd) * dir;
        }
        case "openedAt":
        default:
          return (new Date(a.openedAt).getTime() - new Date(b.openedAt).getTime()) * dir;
      }
    };
    return [...rows].sort(cmp);
  // botName depends on bots, which is stable enough for this memo
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, bots, symbol, side, status, source, search, sortKey, sortDir]);

  const stats = useMemo(() => {
    let pnl = 0, fees = 0, wins = 0, resolved = 0;
    for (const t of filtered) {
      if (t.pnlUsd !== null) { pnl += t.pnlUsd; resolved++; if (t.pnlUsd > 0) wins++; }
      if (hasFee(t)) fees += totalFee(t);
    }
    return {
      count: filtered.length,
      resolved,
      winRate: resolved ? wins / resolved : null,
      pnl, fees,
      avg: resolved ? pnl / resolved : null,
    };
  }, [filtered]);

  function toggleSort(key: SortKey) {
    if (key === sortKey) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir(key === "symbol" ? "asc" : "desc"); }
  }

  function toggleRow(id: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  function resetFilters() {
    setBotId("all"); setFrom(""); setTo("");
    setSymbol("all"); setSide("all"); setStatus("all"); setSource("all");
    setSearch(""); setLimit(PAGE);
  }

  function exportCsv() {
    const cols: [string, (t: Trade) => string | number | null][] = [
      ["id", (t) => t.id],
      ["openedAt", (t) => t.openedAt],
      ["closedAt", (t) => t.closedAt ?? ""],
      ["bot", (t) => botName(t.botId)],
      ["symbol", (t) => t.symbol],
      ["side", (t) => (t.side === "BUY" ? "Long" : "Short")],
      ["status", (t) => t.status],
      ["qty", (t) => t.qty],
      ["entryPrice", (t) => t.entryPrice],
      ["entryFillPrice", (t) => t.entryFillPrice ?? ""],
      ["exitPrice", (t) => t.exitPrice ?? ""],
      ["exitFillPrice", (t) => t.exitFillPrice ?? ""],
      ["pnlUsd", (t) => t.pnlUsd ?? ""],
      ["realizedPnlUsd", (t) => t.realizedPnlUsd ?? ""],
      ["feeOpenUsd", (t) => t.feeOpenUsd ?? ""],
      ["feeCloseUsd", (t) => t.feeCloseUsd ?? ""],
      ["pnlSource", (t) => t.pnlSource ?? ""],
      ["exchangeOrderId", (t) => t.exchangeOrderId],
      ["signalId", (t) => t.signalId],
    ];
    const esc = (v: string | number | null) => {
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      cols.map(([h]) => h).join(","),
      ...filtered.map((t) => cols.map(([, f]) => esc(f(t))).join(",")),
    ];
    const blob = new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trades-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  const sourceLabel = (s: string) =>
    s === "none" ? "—" : PNL_SOURCE_BADGE[s]?.label ?? s.toLowerCase();

  const activeFilters = botId !== "all" || from || to || symbol !== "all" ||
    side !== "all" || status !== "all" || source !== "all" || search.trim();

  return (
    <main className="max-w-[1440px] mx-auto px-6 py-6 space-y-4">
      {/* Title row */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Link to="/" className="text-text-3 hover:text-text-1 transition-colors text-sm">← Dashboard</Link>
          <h1 className="font-semibold text-lg text-text-1">Trades</h1>
          <span className="font-mono text-xs text-text-3">{stats.count}</span>
        </div>
        <button
          onClick={exportCsv}
          disabled={filtered.length === 0}
          className="text-xs font-medium px-3 py-1.5 rounded-lg bg-surface border border-border text-text-2 hover:text-text-1 hover:border-border-bright transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Export CSV
        </button>
      </div>

      {/* Filter bar */}
      <div className="bg-card border border-border rounded-[14px] p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7 gap-3">
          <Ctl label="Bot">
            <Select value={botId} onChange={setBotId} options={[
              { value: "all", label: "All bots" },
              ...bots.map((b) => ({ value: String(b.id), label: b.name })),
            ]} />
          </Ctl>
          <Ctl label="Symbol">
            <Select value={symbol} onChange={setSymbol} options={[
              { value: "all", label: "All symbols" },
              ...symbols.map((s) => ({ value: s, label: s })),
            ]} />
          </Ctl>
          <Ctl label="Direction">
            <Select value={side} onChange={setSide} options={[
              { value: "all", label: "All" },
              { value: "BUY", label: "Long" },
              { value: "SELL", label: "Short" },
            ]} />
          </Ctl>
          <Ctl label="Status">
            <Select value={status} onChange={setStatus} options={[
              { value: "all", label: "All" },
              { value: "OPEN", label: "Open" },
              { value: "CLOSING", label: "Closing" },
              { value: "CLOSED", label: "Closed" },
            ]} />
          </Ctl>
          <Ctl label="PnL source">
            <Select value={source} onChange={setSource} options={[
              { value: "all", label: "All sources" },
              ...sources.map((s) => ({ value: s, label: sourceLabel(s) })),
            ]} />
          </Ctl>
          <Ctl label="From">
            <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} className={inputCls} />
          </Ctl>
          <Ctl label="To">
            <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={inputCls} />
          </Ctl>
        </div>
        <div className="flex items-center gap-3 mt-3">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search symbol, bot, or order id…"
            className={`${inputCls} flex-1 min-w-0`}
          />
          {activeFilters && (
            <button onClick={resetFilters} className="text-xs text-text-3 hover:text-text-1 transition-colors whitespace-nowrap">
              Reset filters
            </button>
          )}
        </div>
      </div>

      {/* Summary stats */}
      <div className="flex items-center flex-wrap gap-x-1 gap-y-2 px-4 py-2.5 bg-surface border border-border rounded-xl">
        <StatChip label="trades" value={String(stats.count)} />
        <Divider />
        <StatChip label="win rate" value={stats.winRate === null ? "—" : fmtPct.format(stats.winRate)}
          hint={stats.resolved ? `${stats.resolved} resolved` : undefined} />
        <Divider />
        <StatChip label="net PnL" value={stats.resolved ? signedUsd(stats.pnl) : "—"} color={pnlColor(stats.resolved ? stats.pnl : null)} />
        <Divider />
        <StatChip label="fees" value={signedUsd(-stats.fees)} color="text-text-3" />
        <Divider />
        <StatChip label="avg" value={stats.avg === null ? "—" : signedUsd(stats.avg)} color={pnlColor(stats.avg)} />
      </div>

      {/* Table */}
      <div className="bg-card border border-border rounded-[14px] overflow-hidden">
        <div className="overflow-x-auto">
          {isLoading ? (
            <div className="p-10 text-text-3 text-sm text-center">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="p-10 text-text-3 text-sm text-center">
              {trades.length === 0 ? "No trades yet" : "No trades match these filters"}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="w-8" />
                  <SortTh label="Opened" col="openedAt" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} className="pl-1 pr-4" />
                  <th className="data-label px-4 py-3 text-left font-normal">Bot</th>
                  <SortTh label="Symbol" col="symbol" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} />
                  <th className="data-label px-4 py-3 text-left font-normal">Dir</th>
                  <SortTh label="Entry" col="entryPrice" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <th className="data-label px-4 py-3 text-right font-normal">Exit</th>
                  <SortTh label="Qty" col="qty" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" />
                  <th className="data-label px-4 py-3 text-right font-normal">Fees</th>
                  <th className="data-label px-4 py-3 text-left font-normal">Status</th>
                  <SortTh label="PnL" col="pnl" sortKey={sortKey} sortDir={sortDir} onClick={toggleSort} align="right" className="pr-5" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => {
                  const open = expanded.has(t.id);
                  return (
                    <Fragment key={t.id}>
                      <tr
                        onClick={() => toggleRow(t.id)}
                        className={`border-b ${open ? "border-border/20" : "border-border/50"} hover:bg-surface/50 transition-colors cursor-pointer`}
                      >
                        <td className="pl-4 text-text-3 text-[10px] select-none">{open ? "▲" : "▼"}</td>
                        <td className="pl-1 pr-4 py-3 font-mono text-xs text-text-2 whitespace-nowrap">
                          {fmtTime.format(new Date(t.openedAt))}
                        </td>
                        <td className="px-4 py-3 text-xs text-text-2 whitespace-nowrap">{botName(t.botId)}</td>
                        <td className="px-4 py-3 font-mono text-xs text-text-2">{t.symbol}</td>
                        <td className={`px-4 py-3 text-xs font-semibold ${t.side === "BUY" ? "text-green" : "text-red"}`}>
                          {t.side === "BUY" ? "Long" : "Short"}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-text-1">{fmtUsd.format(t.entryPrice)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-text-2">
                          {t.exitPrice === null ? "—" : fmtUsd.format(t.exitPrice)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-text-3">{fmtQty.format(t.qty)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-text-3">
                          {hasFee(t) ? fmtUsd.format(totalFee(t)) : "—"}
                        </td>
                        <td className="px-4 py-3">
                          <StatusPill status={t.status} />
                        </td>
                        <td className="pr-5 pl-4 py-3 text-right whitespace-nowrap">
                          <span className={`font-mono text-sm font-medium tabular-nums ${pnlColor(t.pnlUsd)}`}>
                            {t.pnlUsd === null ? "—" : signedUsd(t.pnlUsd)}
                          </span>
                          <PnlSourceBadge source={t.pnlSource} className="ml-1.5 align-middle" />
                        </td>
                      </tr>
                      {open && (
                        <tr className="border-b border-border/50 bg-surface/30">
                          <td colSpan={11} className="px-5 py-4">
                            <TradeDetail t={t} botName={botName(t.botId)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Load more */}
        {!isLoading && trades.length >= limit && limit < MAX_LIMIT && (
          <div className="border-t border-border p-3 text-center">
            <button
              onClick={() => setLimit((l) => Math.min(l + PAGE, MAX_LIMIT))}
              className="text-xs font-medium text-text-2 hover:text-text-1 transition-colors"
            >
              Load more ({trades.length} loaded, up to {MAX_LIMIT})
            </button>
          </div>
        )}
      </div>
    </main>
  );
}

const inputCls =
  "w-full bg-surface border border-border rounded-xl px-3 py-2 text-sm font-mono text-text-1 placeholder:text-text-3 focus:outline-none focus:border-border-bright transition-colors";

function Ctl({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 min-w-0">
      <label className="data-label">{label}</label>
      {children}
    </div>
  );
}

function SortTh({
  label, col, sortKey, sortDir, onClick, align = "left", className = "",
}: {
  label: string; col: SortKey; sortKey: SortKey; sortDir: SortDir;
  onClick: (c: SortKey) => void; align?: "left" | "right"; className?: string;
}) {
  const active = sortKey === col;
  return (
    <th className={`data-label px-4 py-3 font-normal ${align === "right" ? "text-right" : "text-left"} ${className}`}>
      <button
        onClick={() => onClick(col)}
        className={`inline-flex items-center gap-1 hover:text-text-1 transition-colors ${active ? "text-text-1" : ""} ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {label}
        <span className={`text-[9px] ${active ? "opacity-70" : "opacity-0"}`}>{sortDir === "asc" ? "▲" : "▼"}</span>
      </button>
    </th>
  );
}

const STATUS_PILL: Record<string, string> = {
  OPEN: "bg-amber/10 text-amber",
  CLOSING: "bg-amber/10 text-amber",
  CLOSED: "bg-surface text-text-3",
};

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium ${STATUS_PILL[status] ?? "bg-surface text-text-3"}`}>
      {status.toLowerCase()}
    </span>
  );
}

function Divider() {
  return <div className="w-px h-3 bg-border mx-2" />;
}

function StatChip({ label, value, hint, color = "text-text-1" }: { label: string; value: string; hint?: string; color?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 text-[11px] font-mono">
      <span className="text-text-3">{label}</span>
      <span className={color}>{value}</span>
      {hint && <span className="text-text-3 text-[10px]">({hint})</span>}
    </div>
  );
}

function Detail({ label, value, mono = true }: { label: string; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 min-w-0">
      <span className="data-label">{label}</span>
      <span className={`text-xs text-text-2 truncate ${mono ? "font-mono" : ""}`}>{value}</span>
    </div>
  );
}

function TradeDetail({ t, botName }: { t: Trade; botName: string }) {
  const price = (v: number | null) => (v === null ? "—" : fmtUsd.format(v));
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-3">
      <Detail label="Bot" value={botName} mono={false} />
      <Detail label="Opened" value={fmtFull.format(new Date(t.openedAt))} />
      <Detail label="Closed" value={t.closedAt ? fmtFull.format(new Date(t.closedAt)) : "—"} />
      <Detail label="PnL source" value={t.pnlSource ? <PnlSourceBadge source={t.pnlSource} /> : "—"} mono={false} />

      <Detail label="Entry price" value={fmtUsd.format(t.entryPrice)} />
      <Detail label="Entry fill" value={price(t.entryFillPrice)} />
      <Detail label="Exit price" value={price(t.exitPrice)} />
      <Detail label="Exit fill" value={price(t.exitFillPrice)} />

      <Detail label="Realized PnL" value={<span className={pnlColor(t.realizedPnlUsd)}>{t.realizedPnlUsd === null ? "—" : signedUsd(t.realizedPnlUsd)}</span>} />
      <Detail label="Fee open" value={t.feeOpenUsd === null ? "—" : fmtUsd.format(t.feeOpenUsd)} />
      <Detail label="Fee close" value={t.feeCloseUsd === null ? "—" : fmtUsd.format(t.feeCloseUsd)} />
      <Detail label="Total fee" value={hasFee(t) ? fmtUsd.format(totalFee(t)) : "—"} />

      <Detail label="Take profit" value={price(t.takeProfitPrice)} />
      <Detail label="Stop loss" value={price(t.stopLossPrice)} />
      <Detail label="TP/SL set" value={t.tpslSet ? "yes" : "no"} />
      <Detail label="Qty" value={fmtQty.format(t.qty)} />

      <Detail label="Order id" value={t.exchangeOrderId || "—"} />
      <Detail label="Signal id" value={`#${t.signalId}`} />
      <Detail label="Trade id" value={`#${t.id}`} />
    </div>
  );
}
