/** Maps known Bybit / bot rejection reasons to a plain-English one-liner. Returns null for unknowns. */
export function friendlyReason(raw: string): string | null {
  if (/30208|30209/.test(raw))
    return "TP/SL rejected by Bybit price band — entry retried naked";
  if (/10001/.test(raw))
    return "Bybit parameter error — TP/SL may have been dropped, entry retried naked";
  if (/symbol mismatch/i.test(raw))
    return "Alert is sending the wrong symbol to this bot";
  if (/daily loss limit/i.test(raw))
    return "Daily loss limit reached for today";
  if (/duplicate.*(BUY|SELL)/i.test(raw))
    return "Position already open on this side";
  if (/bot is disabled/i.test(raw))
    return "Kill switch is active";
  if (/below minQty/i.test(raw))
    return "Order size too small for this symbol";
  if (/no open position/i.test(raw))
    return "No position to close";
  if (/reduce-only close failed/i.test(raw))
    return "Exchange failed to close the existing position";
  return null;
}
