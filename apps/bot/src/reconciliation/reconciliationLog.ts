import type { PrismaClient } from "../generated/prisma/client.js";

/**
 * Persistent audit trail for reconciliation anomalies. Console logs are ephemeral —
 * Railway's log retention doesn't reach back far enough to forensically investigate an
 * issue reported days later (confirmed while investigating recurring qty drift: `railway
 * logs --since ...` returned nothing for events 2-5 days old). Every notable anomaly
 * (dropped fill, qty drift detected/fixed, phantom promotion, unmatched closedPnl lookup)
 * should call this alongside its console.warn/log, so a later investigation can query
 * ReconciliationEvent directly instead of hoping the logs are still around.
 */
export type ReconciliationEventType =
  | "FILL_DROPPED"
  | "QTY_DRIFT_DETECTED"
  | "QTY_DRIFT_FIXED"
  | "PHANTOM_PROMOTED"
  | "NO_CLOSEDPNL_MATCH"
  | "AMBIGUOUS_CLOSEDPNL_MATCH";

export interface ReconciliationEventParams {
  type: ReconciliationEventType;
  message: string;
  tradeId?: number;
  symbol?: string;
  details?: Record<string, unknown>;
}

export async function logReconciliationEvent(db: PrismaClient, params: ReconciliationEventParams): Promise<void> {
  try {
    await db.reconciliationEvent.create({
      data: {
        type: params.type,
        tradeId: params.tradeId ?? null,
        symbol: params.symbol ?? null,
        message: params.message,
        detailsJson: params.details ? JSON.stringify(params.details) : null,
      },
    });
  } catch (err) {
    // Never let audit logging break the actual reconciliation flow.
    console.error("[reconciliationLog] failed to persist event:", err);
  }
}
