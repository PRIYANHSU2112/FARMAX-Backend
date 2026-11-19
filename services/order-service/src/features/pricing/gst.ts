import { type BasisPoints, type Paise, divRoundHalfUp } from './money.js';
import type { GstGroup } from './pricing.types.js';

/**
 * Phase D — GST per line on the post-discount taxable value, rounded half-up to the paisa [R3].
 * Intra-state: CGST = SGST = round(taxable × rate/2). Inter-state: IGST = round(taxable × rate).
 */
export function gstFor(
  taxable: Paise,
  rate: BasisPoints,
  interState: boolean,
): { cgst: Paise; sgst: Paise; igst: Paise } {
  if (interState) return { cgst: 0, sgst: 0, igst: divRoundHalfUp(taxable * rate, 10_000) };
  const half = divRoundHalfUp(taxable * rate, 20_000);
  return { cgst: half, sgst: half, igst: 0 };
}

/** Groups by HSN + rate as the SUM of already-rounded line amounts (no re-rounding) [R3]. */
export function groupByHsn(
  rows: readonly {
    hsnCode: string;
    rate: BasisPoints;
    taxable: Paise;
    cgst: Paise;
    sgst: Paise;
    igst: Paise;
  }[],
): GstGroup[] {
  const groups = new Map<string, GstGroup>();
  for (const r of rows) {
    const key = `${r.hsnCode}|${String(r.rate)}`;
    const g = groups.get(key) ?? {
      hsnCode: r.hsnCode,
      rate: r.rate,
      taxable: 0,
      cgst: 0,
      sgst: 0,
      igst: 0,
    };
    g.taxable += r.taxable;
    g.cgst += r.cgst;
    g.sgst += r.sgst;
    g.igst += r.igst;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => a.rate - b.rate || a.hsnCode.localeCompare(b.hsnCode));
}
