import { describe, expect, it } from 'vitest';

import { planAllocation } from '../../src/features/reservations/reservations.allocation.js';

const A = { warehouseId: 'a', hasColdChain: true };
const B = { warehouseId: 'b', hasColdChain: true };
const AMBIENT_ONLY = { warehouseId: 'c', hasColdChain: false };

const stock = (m: Record<string, number>) => (w: string, v: string) => m[`${w}|${v}`] ?? 0;
const line = (variantId: string, qty: number, coldChain = false) => ({ variantId, qty, coldChain });

describe('planAllocation', () => {
  it('prefers the first warehouse that can fill every line', () => {
    const plan = planAllocation(
      [line('x', 3), line('y', 2)],
      [A, B],
      stock({ 'a|x': 3, 'a|y': 5, 'b|x': 9, 'b|y': 9 }),
      true,
    );
    expect(plan).toEqual({
      ok: true,
      split: false,
      allocations: [
        { warehouseId: 'a', variantId: 'x', qty: 3 },
        { warehouseId: 'a', variantId: 'y', qty: 2 },
      ],
    });
  });

  it('skips a better-priority warehouse that cannot fill the whole order', () => {
    const plan = planAllocation(
      [line('x', 3), line('y', 2)],
      [A, B],
      stock({ 'a|x': 3, 'a|y': 1, 'b|x': 3, 'b|y': 2 }),
      true,
    );
    expect(plan.ok && plan.allocations.every((a) => a.warehouseId === 'b')).toBe(true);
  });

  it('splits one variant across warehouses: 5 + 7 for an order of 12', () => {
    const plan = planAllocation([line('x', 12)], [A, B], stock({ 'a|x': 5, 'b|x': 10 }), true);
    expect(plan).toEqual({
      ok: true,
      split: true,
      allocations: [
        { warehouseId: 'a', variantId: 'x', qty: 5 },
        { warehouseId: 'b', variantId: 'x', qty: 7 },
      ],
    });
  });

  it('refuses to split when split allocation is off (available = best single warehouse)', () => {
    const plan = planAllocation([line('x', 12)], [A, B], stock({ 'a|x': 5, 'b|x': 10 }), false);
    expect(plan).toEqual({ ok: false, shortfall: [{ variantId: 'x', requested: 12, available: 10 }] });
  });

  it('reports the network total when even a split cannot fill the line', () => {
    const plan = planAllocation([line('x', 20)], [A, B], stock({ 'a|x': 5, 'b|x': 10 }), true);
    expect(plan).toEqual({ ok: false, shortfall: [{ variantId: 'x', requested: 20, available: 15 }] });
  });

  it('allocates cold-chain lines only to cold-chain warehouses', () => {
    const plan = planAllocation(
      [line('vax', 4, true)],
      [AMBIENT_ONLY, A],
      stock({ 'c|vax': 100, 'a|vax': 4 }),
      true,
    );
    expect(plan.ok && plan.allocations).toEqual([{ warehouseId: 'a', variantId: 'vax', qty: 4 }]);
    const none = planAllocation([line('vax', 4, true)], [AMBIENT_ONLY], stock({ 'c|vax': 100 }), true);
    expect(none).toEqual({ ok: false, shortfall: [{ variantId: 'vax', requested: 4, available: 0 }] });
  });

  it('never uses stock that is not sellable (safety stock is already excluded by the caller)', () => {
    const plan = planAllocation([line('x', 1)], [A], stock({ 'a|x': 0 }), true);
    expect(plan.ok).toBe(false);
  });

  it('with no candidates every line is short', () => {
    expect(planAllocation([line('x', 1)], [], stock({}), true)).toEqual({
      ok: false,
      shortfall: [{ variantId: 'x', requested: 1, available: 0 }],
    });
  });
});
