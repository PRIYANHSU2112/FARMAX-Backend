/** Pure order read-model rules (no I/O; unit-tested). */

export const FULFILMENT_STATUSES = ['NEW', 'ALLOCATED', 'DELIVERED', 'CANCELLED'] as const;
export type FulfilmentStatus = (typeof FULFILMENT_STATUSES)[number];

/** Still to be fulfilled by the warehouse (blocks deactivation). */
export const OPEN_STATUSES: FulfilmentStatus[] = ['NEW', 'ALLOCATED'];

/** variantId → qty held at one warehouse. */
export type Lines = Record<string, number>;

/** Sum of qty per variant (lines may repeat a variant). */
export function linesOf(raw: readonly { variantId: string; qty: number }[]): Lines {
  const out: Lines = {};
  for (const l of raw) if (l.qty > 0) out[l.variantId] = (out[l.variantId] ?? 0) + l.qty;
  return out;
}

/** Lines left after a partial release (never below zero; empty variants dropped). */
export function subtractLines(
  lines: Lines,
  release: readonly { variantId: string; qty: number }[],
): Lines {
  const out: Lines = { ...lines };
  for (const r of release) out[r.variantId] = (out[r.variantId] ?? 0) - r.qty;
  return Object.fromEntries(Object.entries(out).filter(([, qty]) => qty > 0));
}

export const countsOf = (lines: Lines): { lineCount: number; unitCount: number } => {
  const qtys = Object.values(lines);
  return { lineCount: qtys.length, unitCount: qtys.reduce((n, q) => n + q, 0) };
};

/** Group committed reservation lines by warehouse. */
export function byWarehouse(
  raw: readonly { warehouseId: string; variantId: string; qty: number }[],
): Map<string, Lines> {
  const groups = new Map<string, { variantId: string; qty: number }[]>();
  for (const l of raw) groups.set(l.warehouseId, [...(groups.get(l.warehouseId) ?? []), l]);
  return new Map([...groups].map(([w, ls]) => [w, linesOf(ls)]));
}
