/** Pure stock rules (no I/O): unit-tested directly. */

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * THE lock order for stock rows: (warehouseId, variantId), plain code-point compare. Every code
 * path that updates several stock rows in one transaction sorts with this, so they never deadlock.
 */
export const byLockOrder = (
  a: { warehouseId: string; variantId: string },
  b: { warehouseId: string; variantId: string },
): number => cmp(a.warehouseId, b.warehouseId) || cmp(a.variantId, b.variantId);

export interface LevelQty {
  onHand: number;
  reserved: number;
  safetyStock: number;
}

/** Units that may be promised to a new order: never negative, never safety stock. */
export const sellableOf = (l: LevelQty): number => Math.max(0, l.onHand - l.reserved - l.safetyStock);

/**
 * Low-stock alert on a threshold CROSSING only (dedup):
 *   sellable ≤ reorderLevel and not alerted → alert once, flag on
 *   sellable > reorderLevel and alerted     → reset silently (the next drop alerts again)
 * reorderLevel 0 disables alerts (and clears a stale flag).
 */
export const lowStockCrossing = (
  sellable: number,
  reorderLevel: number,
  alerted: boolean,
): { alert: boolean; flag: boolean } => {
  if (reorderLevel <= 0) return { alert: false, flag: false };
  const low = sellable <= reorderLevel;
  if (low && !alerted) return { alert: true, flag: true };
  if (!low && alerted) return { alert: false, flag: false };
  return { alert: false, flag: alerted };
};

export interface NetworkLevel extends LevelQty {
  warehouseId: string;
  reorderLevel: number;
}

/** Network availability of one variant over the allocatable warehouses. */
export const networkAvailability = (
  levels: readonly NetworkLevel[],
  allocatable: ReadonlySet<string>,
): { availableQty: number; inStock: boolean; lowStock: boolean } => {
  let availableQty = 0;
  let threshold = 0;
  for (const l of levels) {
    if (!allocatable.has(l.warehouseId)) continue;
    availableQty += sellableOf(l);
    threshold += l.reorderLevel;
  }
  return { availableQty, inStock: availableQty > 0, lowStock: threshold > 0 && availableQty <= threshold };
};
