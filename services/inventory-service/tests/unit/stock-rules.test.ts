import { describe, expect, it } from 'vitest';

import { requestHash } from '../../src/middleware/http.js';
import {
  byLockOrder,
  lowStockCrossing,
  networkAvailability,
  sellableOf,
} from '../../src/features/stock/stock.rules.js';

describe('sellableOf', () => {
  it('excludes reserved and safety stock and never goes negative', () => {
    expect(sellableOf({ onHand: 100, reserved: 20, safetyStock: 10 })).toBe(70);
    expect(sellableOf({ onHand: 5, reserved: 0, safetyStock: 10 })).toBe(0);
  });
});

describe('lowStockCrossing (alert once per dip)', () => {
  it('alerts on the way down, stays quiet while low, resets above, alerts again', () => {
    let flag = false;
    const step = (sellable: number) => {
      const r = lowStockCrossing(sellable, 10, flag);
      flag = r.flag;
      return r.alert;
    };
    expect([step(50), step(10), step(8), step(3), step(11), step(9)]).toEqual([
      false,
      true,
      false,
      false,
      false,
      true,
    ]);
  });

  it('reorderLevel 0 disables alerts and clears a stale flag', () => {
    expect(lowStockCrossing(0, 0, true)).toEqual({ alert: false, flag: false });
  });
});

describe('networkAvailability', () => {
  const levels = [
    { warehouseId: 'a', onHand: 10, reserved: 2, safetyStock: 1, reorderLevel: 5 },
    { warehouseId: 'b', onHand: 4, reserved: 0, safetyStock: 0, reorderLevel: 5 },
    { warehouseId: 'off', onHand: 999, reserved: 0, safetyStock: 0, reorderLevel: 5 },
  ];
  it('sums only allocatable warehouses; lowStock against the summed thresholds', () => {
    expect(networkAvailability(levels, new Set(['a', 'b']))).toEqual({
      availableQty: 11,
      inStock: true,
      lowStock: false,
    });
    expect(networkAvailability(levels, new Set(['b']))).toEqual({
      availableQty: 4,
      inStock: true,
      lowStock: true,
    });
    expect(networkAvailability(levels, new Set())).toEqual({
      availableQty: 0,
      inStock: false,
      lowStock: false,
    });
  });
});

describe('byLockOrder', () => {
  it('orders by warehouse then variant with a plain code-point compare', () => {
    const rows = [
      { warehouseId: 'b', variantId: 'a' },
      { warehouseId: 'a', variantId: 'z' },
      { warehouseId: 'a', variantId: '-' },
    ];
    expect([...rows].sort(byLockOrder)).toEqual([
      { warehouseId: 'a', variantId: '-' },
      { warehouseId: 'a', variantId: 'z' },
      { warehouseId: 'b', variantId: 'a' },
    ]);
  });
});

describe('requestHash', () => {
  it('ignores key order and undefined fields, but not values', () => {
    const a = requestHash({ x: 1, lines: [{ v: 'a', q: 2 }], note: undefined });
    const b = requestHash({ lines: [{ q: 2, v: 'a' }], x: 1 });
    expect(a).toBe(b);
    expect(requestHash({ x: 2 })).not.toBe(requestHash({ x: 1 }));
  });
});
