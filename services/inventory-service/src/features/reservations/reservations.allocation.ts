/**
 * Pure warehouse allocation (no I/O; unit-tested). Candidates come best-first (coverage priority,
 * then warehouse priority, then code). Cold-chain lines only go to cold-chain warehouses.
 *
 * 1. Single warehouse first: the first candidate that can fill EVERY line in full.
 * 2. Split (only when allowed): per variant, walk the candidates and take min(sellable, remaining),
 *    e.g. A has 5, B has 10, order 12 → A:5 + B:7.
 * 3. Otherwise: a shortfall per variant (available = the most one warehouse has without split,
 *    the network total with split).
 */

export interface AllocCandidate {
  warehouseId: string;
  hasColdChain: boolean;
}

export interface AllocLine {
  variantId: string;
  qty: number;
  coldChain: boolean;
}

export interface Allocation {
  warehouseId: string;
  variantId: string;
  qty: number;
}

export interface Shortfall {
  variantId: string;
  requested: number;
  available: number;
}

export type AllocationPlan =
  | { ok: true; allocations: Allocation[]; split: boolean }
  | { ok: false; shortfall: Shortfall[] };

export type SellableFn = (warehouseId: string, variantId: string) => number;

const eligible = (c: AllocCandidate, l: AllocLine): boolean => !l.coldChain || c.hasColdChain;

export function planAllocation(
  lines: readonly AllocLine[],
  candidates: readonly AllocCandidate[],
  sellable: SellableFn,
  allowSplit: boolean,
): AllocationPlan {
  const single = candidates.find((c) =>
    lines.every((l) => eligible(c, l) && sellable(c.warehouseId, l.variantId) >= l.qty),
  );
  if (single !== undefined)
    return {
      ok: true,
      split: false,
      allocations: lines.map((l) => ({
        warehouseId: single.warehouseId,
        variantId: l.variantId,
        qty: l.qty,
      })),
    };

  if (!allowSplit)
    return {
      ok: false,
      shortfall: lines.map((l) => ({
        variantId: l.variantId,
        requested: l.qty,
        available: Math.max(
          0,
          ...candidates.filter((c) => eligible(c, l)).map((c) => sellable(c.warehouseId, l.variantId)),
        ),
      })),
    };

  const allocations: Allocation[] = [];
  const shortfall: Shortfall[] = [];
  for (const l of lines) {
    let remaining = l.qty;
    let available = 0;
    for (const c of candidates) {
      if (!eligible(c, l)) continue;
      const has = Math.max(0, sellable(c.warehouseId, l.variantId));
      available += has;
      const take = Math.min(has, remaining);
      if (take > 0) {
        allocations.push({ warehouseId: c.warehouseId, variantId: l.variantId, qty: take });
        remaining -= take;
      }
    }
    if (remaining > 0) shortfall.push({ variantId: l.variantId, requested: l.qty, available });
  }
  if (shortfall.length > 0) return { ok: false, shortfall };
  const warehouses = new Set(allocations.map((a) => a.warehouseId));
  return { ok: true, allocations, split: warehouses.size > 1 };
}
