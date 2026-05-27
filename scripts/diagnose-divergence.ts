#!/usr/bin/env tsx
/**
 * Diagnose the gap between the equity curve and the closed-trades PnL table.
 *
 * Usage:
 *   npx tsx scripts/diagnose-divergence.ts
 *   npx tsx scripts/diagnose-divergence.ts --from 2026-05-23T13:00:00Z --to 2026-05-23T15:00:00Z
 *   npx tsx scripts/diagnose-divergence.ts --symbol XRPUSDT
 */
import dotenv from "dotenv";
import { resolve } from "path";

dotenv.config({ path: resolve(__dirname, "../apps/bot/.env") });

function parseArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

const fromArg = parseArg("--from");
const toArg = parseArg("--to");
const symbolArg = parseArg("--symbol");

// Default window: last 4 hours
const now = Date.now();
const fromMs = fromArg ? new Date(fromArg).getTime() : now - 4 * 60 * 60 * 1000;
const toMs = toArg ? new Date(toArg).getTime() : now;

function fmt(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
}
function fmtUsd(n: number): string {
  return (n >= 0 ? "+" : "") + n.toFixed(4) + " USD";
}

async function main() {
  const { BybitClient } = await import("../apps/bot/src/exchange/bybit.js");
  const { prisma } = await import("../apps/bot/src/db.js");

  const bybit = new BybitClient();

  console.log("=== Divergence Diagnostic ===");
  console.log(`Window: ${fmt(fromMs)}  →  ${fmt(toMs)}`);
  if (symbolArg) console.log(`Symbol filter: ${symbolArg}`);
  console.log();

  // ─── 1. DB queries ─────────────────────────────────────────────────────────

  const fromDate = new Date(fromMs);
  const toDate = new Date(toMs);

  const snapshots = await prisma.balanceSnapshot.findMany({
    where: { takenAt: { gte: fromDate, lte: toDate } },
    orderBy: { takenAt: "asc" },
  });

  const closedTrades = await prisma.trade.findMany({
    where: {
      status: "CLOSED",
      closedAt: { gte: fromDate, lte: toDate },
      ...(symbolArg ? { symbol: symbolArg } : {}),
    },
    orderBy: { closedAt: "asc" },
  });

  const openAtStart = await prisma.trade.findMany({
    where: {
      openedAt: { lte: fromDate },
      OR: [{ closedAt: null }, { closedAt: { gte: fromDate } }],
      ...(symbolArg ? { symbol: symbolArg } : {}),
    },
  });

  console.log("── DB: BalanceSnapshots ──");
  if (snapshots.length === 0) {
    console.log("  No snapshots found in window.");
  } else {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    console.log(`  First: ${fmt(first.takenAt.getTime())}  equity=${first.equityUsd.toFixed(4)}  avail=${first.availableUsd.toFixed(4)}`);
    console.log(`  Last:  ${fmt(last.takenAt.getTime())}  equity=${last.equityUsd.toFixed(4)}  avail=${last.availableUsd.toFixed(4)}`);
    const deltaEquity = last.equityUsd - first.equityUsd;
    const deltaAvail = last.availableUsd - first.availableUsd;
    console.log(`  Δ equity:    ${fmtUsd(deltaEquity)}`);
    console.log(`  Δ available: ${fmtUsd(deltaAvail)}`);
  }
  console.log();

  console.log("── DB: Open trades at window start ──");
  if (openAtStart.length === 0) {
    console.log("  None.");
  } else {
    for (const t of openAtStart) {
      console.log(`  #${t.id} ${t.symbol} ${t.side} qty=${t.qty} entry=${t.entryPrice} opened=${fmt(t.openedAt.getTime())} status=${t.status}`);
    }
  }
  console.log();

  console.log("── DB: Closed trades in window ──");
  let sumLocalPnl = 0;
  if (closedTrades.length === 0) {
    console.log("  None.");
  } else {
    for (const t of closedTrades) {
      const pnl = t.pnlUsd ?? 0;
      sumLocalPnl += pnl;
      console.log(`  #${t.id} ${t.symbol} ${t.side} qty=${t.qty} entry=${t.entryPrice} exit=${t.exitPrice ?? "?"} pnl=${fmtUsd(pnl)} closed=${t.closedAt ? fmt(t.closedAt.getTime()) : "?"}`);
    }
    console.log(`  Σ local pnlUsd: ${fmtUsd(sumLocalPnl)}`);
  }
  console.log();

  // ─── 2. Bybit REST queries ──────────────────────────────────────────────────

  console.log("── Bybit: ClosedPnL ──");
  let sumBybitPnl = 0;
  let sumBybitOpenFee = 0;
  let sumBybitCloseFee = 0;
  try {
    const closedPnlRows = await bybit.getClosedPnL({
      ...(symbolArg ? { symbol: symbolArg } : {}),
      startTime: fromMs,
      endTime: toMs,
    });
    if (closedPnlRows.length === 0) {
      console.log("  No closed-pnl rows found.");
    } else {
      for (const r of closedPnlRows) {
        sumBybitPnl += r.closedPnl;
        sumBybitOpenFee += r.openFee;
        sumBybitCloseFee += r.closeFee;
        console.log(`  orderId=${r.orderId} ${r.symbol} ${r.side} qty=${r.qty} entryPx=${r.avgEntryPrice} exitPx=${r.avgExitPrice} pnl=${fmtUsd(r.closedPnl)} openFee=${r.openFee.toFixed(4)} closeFee=${r.closeFee.toFixed(4)}`);
      }
      console.log(`  Σ closedPnl: ${fmtUsd(sumBybitPnl)}`);
      console.log(`  Σ openFee:   ${fmtUsd(sumBybitOpenFee)}`);
      console.log(`  Σ closeFee:  ${fmtUsd(sumBybitCloseFee)}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }
  console.log();

  console.log("── Bybit: ExecutionList ──");
  let sumExecFee = 0;
  try {
    const execs = await bybit.getExecutionList({
      ...(symbolArg ? { symbol: symbolArg } : {}),
      startTime: fromMs,
      endTime: toMs,
    });
    if (execs.length === 0) {
      console.log("  No executions found.");
    } else {
      for (const e of execs) {
        sumExecFee += e.execFee;
        console.log(`  orderId=${e.orderId} ${e.symbol} ${e.side} price=${e.execPrice} qty=${e.execQty} fee=${e.execFee.toFixed(4)} closedSize=${e.closedSize} time=${fmt(e.execTime)}`);
      }
      console.log(`  Σ execFee: ${fmtUsd(sumExecFee)}`);
    }
  } catch (err) {
    console.log(`  ERROR: ${(err as Error).message}`);
  }
  console.log();

  // ─── 3. Gap decomposition ───────────────────────────────────────────────────

  if (snapshots.length >= 2) {
    const first = snapshots[0];
    const last = snapshots[snapshots.length - 1];
    const deltaEquity = last.equityUsd - first.equityUsd;
    const gap = deltaEquity - sumBybitPnl;
    const localVsBybit = sumLocalPnl - sumBybitPnl;

    console.log("── Gap Decomposition ──");
    console.log(`  Δ equity (from snapshots):          ${fmtUsd(deltaEquity)}`);
    console.log(`  Σ Bybit closedPnl (before fees):    ${fmtUsd(sumBybitPnl)}`);
    console.log(`  Σ Bybit fees (open+close):          ${fmtUsd(-(sumBybitOpenFee + sumBybitCloseFee))}`);
    console.log(`  Σ Bybit pnl net of fees:            ${fmtUsd(sumBybitPnl - sumBybitOpenFee - sumBybitCloseFee)}`);
    console.log(`  Unexplained residual:               ${fmtUsd(gap + sumBybitOpenFee + sumBybitCloseFee)}`);
    console.log(`    (residual ≈ unrealized PnL change + funding ± rounding)`);
    console.log();
    console.log(`  Local pnlUsd vs Bybit closedPnl:    ${fmtUsd(localVsBybit)}`);
    console.log(`    (positive = local is optimistic vs exchange; expected due to missing fees/fill-price drift)`);
  }

  console.log();
  console.log("── Current Positions ──");
  const symbols = symbolArg
    ? [symbolArg]
    : [...new Set([...openAtStart.map((t) => t.symbol)])];
  if (symbols.length === 0) {
    console.log("  No symbols to check.");
  } else {
    for (const sym of symbols) {
      try {
        const positions = await bybit.getPositions(sym);
        for (const p of positions) {
          if (p.size === 0) continue;
          console.log(`  ${p.symbol} ${p.side} size=${p.size} entry=${p.entryPrice} unrealisedPnl=${fmtUsd(p.unrealisedPnl)}`);
        }
      } catch (err) {
        console.log(`  ${sym}: ERROR ${(err as Error).message}`);
      }
    }
  }

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error("[error]", err);
  process.exit(1);
});
