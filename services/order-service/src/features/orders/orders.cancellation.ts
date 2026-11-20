/**
 * Pure cancellation math (no I/O; unit-tested). Refunds come from the amounts the buyer actually
 * paid per line (`lineTotal`: after every offer, incl. GST), so promotions never need re-pricing.
 *
 * Per-unit share of a line: share(n) = floor(lineTotal × n / qty), and share(qty) = lineTotal, so
 * cancelling a line unit by unit always adds up to EXACTLY its total (leftover paise land on the
 * last unit). Freight is refunded only when the whole order is cancelled (it is then the rest of
 * what was paid).
 */

export interface CancelLine {
  lineNo: number;
  variantId: string;
  qty: number;
  cancelledQty: number;
  lineTotalPaise: number;
}

export interface CancelItem {
  lineNo: number;
  variantId: string;
  qty: number;
  refundPaise: number;
}

export type CancelPlan =
  | { ok: true; full: boolean; items: CancelItem[]; itemsRefundPaise: number }
  | { ok: false; issues: { path: string; message: string }[] };

export const shareOf = (lineTotalPaise: number, qty: number, n: number): number =>
  n >= qty ? lineTotalPaise : Math.floor((lineTotalPaise * n) / qty);

/** `requested` undefined / empty = cancel everything still active. */
export function planCancellation(
  lines: readonly CancelLine[],
  requested?: readonly { variantId: string; qty: number }[],
): CancelPlan {
  const active = lines.filter((l) => l.qty - l.cancelledQty > 0);
  const want =
    requested === undefined || requested.length === 0
      ? active.map((l) => ({ variantId: l.variantId, qty: l.qty - l.cancelledQty }))
      : requested;
  const issues: { path: string; message: string }[] = [];
  const items: CancelItem[] = [];
  want.forEach((w, i) => {
    const line = lines.find((l) => l.variantId === w.variantId);
    const left = line === undefined ? 0 : line.qty - line.cancelledQty;
    if (line === undefined)
      issues.push({ path: `body.lines[${String(i)}].variantId`, message: 'is not in this order' });
    else if (w.qty < 1 || w.qty > left)
      issues.push({
        path: `body.lines[${String(i)}].qty`,
        message: `must be 1–${String(left)} (still active)`,
      });
    else
      items.push({
        lineNo: line.lineNo,
        variantId: line.variantId,
        qty: w.qty,
        refundPaise:
          shareOf(line.lineTotalPaise, line.qty, line.cancelledQty + w.qty) -
          shareOf(line.lineTotalPaise, line.qty, line.cancelledQty),
      });
  });
  if (issues.length > 0) return { ok: false, issues };
  if (items.length === 0)
    return { ok: false, issues: [{ path: 'body.lines', message: 'nothing left to cancel' }] };
  const remaining = new Map(active.map((l) => [l.variantId, l.qty - l.cancelledQty]));
  for (const it of items) remaining.set(it.variantId, (remaining.get(it.variantId) ?? 0) - it.qty);
  const full = [...remaining.values()].every((q) => q <= 0);
  return { ok: true, full, items, itemsRefundPaise: items.reduce((n, i) => n + i.refundPaise, 0) };
}

/**
 * What the buyer gets back. Full cancel → everything still refundable (incl. freight); partial →
 * the cancelled items' share, never more than is still refundable. Fee (% of the refund, half-up)
 * only for buyers after the free window.
 */
export function refundFor(o: {
  full: boolean;
  itemsRefundPaise: number;
  refundablePaise: number;
  feePercent: number;
  chargeFee: boolean;
}): { gross: number; fee: number; net: number } {
  const gross = Math.max(
    0,
    Math.min(o.refundablePaise, o.full ? o.refundablePaise : o.itemsRefundPaise),
  );
  const fee = o.chargeFee ? Math.min(gross, Math.round((gross * o.feePercent) / 100)) : 0;
  return { gross, fee, net: gross - fee };
}
