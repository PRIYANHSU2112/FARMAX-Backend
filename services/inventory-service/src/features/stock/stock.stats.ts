import { sellableOf } from './stock.rules.js';

/** One stock level row as the stats read needs it. */
export interface StatsLevel {
  warehouseId: string;
  variantId: string;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
}

/** What the variant projection knows (root category, pack weight). */
export interface StatsFacts {
  rootCategoryId: string | null;
  weightGrams: number | null;
}

export interface CategoryStats {
  /** Root catalog category; null = variant not (yet) classified. */
  rootCategoryId: string | null;
  skuCount: number;
  onHand: number;
  reserved: number;
  available: number;
}

/** Per-warehouse stock figures for warehouse-service (D-56 P3, plan §8.1). */
export interface WarehouseStats {
  warehouseId: string;
  onHand: number;
  reserved: number;
  damaged: number;
  /** Sellable = Σ max(0, onHand − reserved − safetyStock). */
  available: number;
  /** Variants physically present (onHand + damaged > 0). */
  skuCount: number;
  /** Σ (onHand + damaged) × weightGrams / 1000 over variants with a known weight (2 dp). */
  usedKg: string;
  weighedUnits: number;
  unweighedUnits: number;
  unweighedSkus: number;
  /** weighedUnits ÷ physical units × 100 (1 dp); 100 when nothing is stored. */
  weightKnownPct: number;
  categories: CategoryStats[];
}

/**
 * Pure aggregation (unit-tested). Weight maths in integer grams (no float drift), then kg with 2
 * decimals; a NULL or 0 weight is never guessed: those units are counted as unweighed.
 */
export function aggregateStats(
  levels: readonly StatsLevel[],
  facts: ReadonlyMap<string, StatsFacts>,
): WarehouseStats[] {
  interface Acc {
    s: Omit<WarehouseStats, 'usedKg' | 'weightKnownPct' | 'categories'>;
    grams: bigint;
    cats: Map<string, CategoryStats>;
  }
  const byWarehouse = new Map<string, Acc>();
  for (const l of levels) {
    let acc = byWarehouse.get(l.warehouseId);
    if (acc === undefined) {
      acc = {
        s: {
          warehouseId: l.warehouseId,
          onHand: 0,
          reserved: 0,
          damaged: 0,
          available: 0,
          skuCount: 0,
          weighedUnits: 0,
          unweighedUnits: 0,
          unweighedSkus: 0,
        },
        grams: 0n,
        cats: new Map(),
      };
      byWarehouse.set(l.warehouseId, acc);
    }
    const f = facts.get(l.variantId);
    const available = sellableOf(l);
    const physical = l.onHand + l.damaged;
    acc.s.onHand += l.onHand;
    acc.s.reserved += l.reserved;
    acc.s.damaged += l.damaged;
    acc.s.available += available;
    if (physical > 0) {
      acc.s.skuCount += 1;
      const grams = f?.weightGrams ?? 0;
      if (grams > 0) {
        acc.grams += BigInt(physical) * BigInt(grams);
        acc.s.weighedUnits += physical;
      } else {
        acc.s.unweighedUnits += physical;
        acc.s.unweighedSkus += 1;
      }
    }
    const key = f?.rootCategoryId ?? '';
    const cat = acc.cats.get(key) ?? {
      rootCategoryId: f?.rootCategoryId ?? null,
      skuCount: 0,
      onHand: 0,
      reserved: 0,
      available: 0,
    };
    if (physical > 0) cat.skuCount += 1;
    cat.onHand += l.onHand;
    cat.reserved += l.reserved;
    cat.available += available;
    acc.cats.set(key, cat);
  }
  return [...byWarehouse.values()].map(({ s, grams, cats }) => {
    const physical = s.weighedUnits + s.unweighedUnits;
    // grams → kg with 2 decimals, rounded half up (integer maths).
    const centiKg = (grams + 5n) / 10n;
    return {
      ...s,
      usedKg: `${(centiKg / 100n).toString()}.${(centiKg % 100n).toString().padStart(2, '0')}`,
      weightKnownPct: physical === 0 ? 100 : Math.round((s.weighedUnits / physical) * 1000) / 10,
      categories: [...cats.values()].sort((a, b) => b.onHand - a.onHand),
    };
  });
}
