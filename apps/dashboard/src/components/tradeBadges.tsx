// Shared trade formatters and the pnlSource → badge pill, used by both the compact
// dashboard card (TradesTable) and the detailed /trades page (TradesPage).

export const fmtTime = new Intl.DateTimeFormat("en-US", {
  month: "short", day: "numeric",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

export const fmtUsd = new Intl.NumberFormat("en-US", {
  style: "currency", currency: "USD", minimumFractionDigits: 2,
});

export const fmtQty = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 4, maximumFractionDigits: 6,
});

const NEUTRAL = "bg-border/40 text-text-3 border border-border";
const DANGER = "bg-red/10 text-red border border-red/20";

// Every non-default pnlSource that earns a visible badge. BYBIT_WS is the expected
// happy-path source and intentionally renders no badge.
export const PNL_SOURCE_BADGE: Record<string, { label: string; title: string; cls: string }> = {
  EXEC_FALLBACK: {
    label: "est.",
    title: "Locally estimated from fill price — WS order event missed.",
    cls: NEUTRAL,
  },
  BYBIT_REST: {
    label: "rest",
    title: "Sourced from Bybit closedPnL REST endpoint.",
    cls: NEUTRAL,
  },
  BYBIT_REST_GROUPED: {
    label: "rest-grouped",
    title: "PnL is a proportional share of a grouped Bybit closedPnL entry (multiple bot trades aggregated into one Bybit position).",
    cls: NEUTRAL,
  },
  BYBIT_REST_GROUPED_QTY_FIX: {
    label: "rest-grouped",
    title: "Proportional share of a grouped Bybit closedPnL entry, with a quantity-mismatch correction applied.",
    cls: NEUTRAL,
  },
  BYBIT_LIQUIDATION: {
    label: "liquidated",
    title: "Position was force-closed by the exchange.",
    cls: DANGER,
  },
  PHANTOM: {
    label: "phantom",
    title: "Position recorded locally but no execution on Bybit — counted as 0 PnL.",
    cls: NEUTRAL,
  },
};

export function PnlSourceBadge({ source, className = "" }: { source: string | null; className?: string }) {
  const badge = source ? PNL_SOURCE_BADGE[source] : undefined;
  if (!badge) return null;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[9px] font-medium ${badge.cls} ${className}`}
      title={badge.title}
    >
      {badge.label}
    </span>
  );
}

export const totalFee = (t: { feeOpenUsd: number | null; feeCloseUsd: number | null }) =>
  (t.feeOpenUsd ?? 0) + (t.feeCloseUsd ?? 0);

export const hasFee = (t: { feeOpenUsd: number | null; feeCloseUsd: number | null }) =>
  t.feeOpenUsd !== null || t.feeCloseUsd !== null;
