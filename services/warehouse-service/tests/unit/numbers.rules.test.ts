import { describe, expect, it } from 'vitest';

import {
  byWarehouse,
  countsOf,
  linesOf,
  subtractLines,
} from '../../src/features/orders/orders.rules.js';
import {
  type BoardInput,
  deltaPct,
  isStale,
  statusBoard,
} from '../../src/features/stats/stats.rules.js';
import { usedPct } from '../../src/features/warehouses/warehouses.rules.js';

describe('order read model rules', () => {
  it('groups committed lines per warehouse and sums repeated variants', () => {
    const groups = byWarehouse([
      { warehouseId: 'a', variantId: 'v1', qty: 2 },
      { warehouseId: 'b', variantId: 'v1', qty: 3 },
      { warehouseId: 'a', variantId: 'v1', qty: 1 },
      { warehouseId: 'a', variantId: 'v2', qty: 5 },
    ]);
    expect(groups.get('a')).toEqual({ v1: 3, v2: 5 });
    expect(countsOf(groups.get('a') ?? {})).toEqual({ lineCount: 2, unitCount: 8 });
    expect(linesOf([{ variantId: 'x', qty: 0 }])).toEqual({});
  });

  it('a partial release never goes below zero and drops empty lines', () => {
    expect(
      subtractLines({ v1: 3, v2: 5 }, [
        { variantId: 'v1', qty: 4 },
        { variantId: 'v2', qty: 2 },
      ]),
    ).toEqual({
      v2: 3,
    });
    expect(subtractLines({ v1: 1 }, [{ variantId: 'other', qty: 1 }])).toEqual({ v1: 1 });
  });
});

describe('stats rules', () => {
  it('deltas and capacity use', () => {
    expect(deltaPct(110, 100)).toBe(10);
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, undefined)).toBeNull();
    expect(usedPct(1500, 50_000)).toBe(3);
    expect(usedPct(10, null)).toBeNull();
  });

  it('a snapshot older than 3 refreshes is stale', () => {
    const now = new Date('2026-11-23T10:00:00Z');
    expect(isStale(new Date('2026-11-23T09:58:00Z'), now, 60)).toBe(false);
    expect(isStale(new Date('2026-11-23T09:56:00Z'), now, 60)).toBe(true);
    expect(isStale(null, now, 60)).toBe(true);
  });

  it('status board', () => {
    const now = new Date('2026-11-23T10:00:00Z');
    const base: BoardInput = {
      status: 'ACTIVE',
      today: { isOpen: true, limitedHoliday: false },
      coldZones: { total: 2, active: 1 },
      asOf: new Date('2026-11-23T09:59:30Z'),
      now,
    };
    const states = (o: Partial<BoardInput>) => statusBoard({ ...base, ...o }).map((r) => r.state);
    expect(states({})).toEqual(['OPERATIONAL', 'OPERATIONAL', 'CONNECTED']);
    expect(states({ today: { isOpen: false, limitedHoliday: false } })[0]).toBe('CLOSED_TODAY');
    expect(states({ today: { isOpen: true, limitedHoliday: true } })[0]).toBe('LIMITED');
    expect(states({ status: 'INACTIVE' })[0]).toBe('INACTIVE');
    expect(states({ coldZones: { total: 1, active: 0 } })[1]).toBe('MAINTENANCE');
    expect(states({ coldZones: { total: 0, active: 0 } })[1]).toBe('NOT_CONFIGURED');
    expect(states({ asOf: new Date('2026-11-23T09:50:00Z') })[2]).toBe('DELAYED');
    expect(states({ asOf: null })[2]).toBe('NO_DATA');
  });
});
