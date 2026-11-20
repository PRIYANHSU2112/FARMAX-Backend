import { describe, expect, it } from 'vitest';

import {
  planCancellation,
  refundFor,
  shareOf,
} from '../../../src/features/orders/orders.cancellation.js';

const line = (lineNo: number, qty: number, lineTotalPaise: number, cancelledQty = 0) => ({
  lineNo,
  variantId: `v${String(lineNo)}`,
  qty,
  cancelledQty,
  lineTotalPaise,
});

describe('shareOf', () => {
  it('unit-by-unit shares add up to exactly the line total (leftover paise on the last unit)', () => {
    const total = 1000; // ₹10.00 for 3 units
    const parts = [1, 2, 3].map((n) => shareOf(total, 3, n) - shareOf(total, 3, n - 1));
    expect(parts).toEqual([333, 333, 334]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
  });
});

describe('planCancellation', () => {
  const lines = [line(1, 3, 1000), line(2, 2, 15_792)];

  it('no lines = cancel everything still active (full)', () => {
    const p = planCancellation(lines);
    expect(p).toMatchObject({ ok: true, full: true, itemsRefundPaise: 16_792 });
  });

  it('partial: refunds only the cancelled units; cancelling the rest later completes the total', () => {
    const first = planCancellation(lines, [{ variantId: 'v1', qty: 1 }]);
    expect(first).toMatchObject({ ok: true, full: false, itemsRefundPaise: 333 });
    const rest = planCancellation(
      [line(1, 3, 1000, 1), line(2, 2, 15_792)],
      [
        { variantId: 'v1', qty: 2 },
        { variantId: 'v2', qty: 2 },
      ],
    );
    expect(rest).toMatchObject({ ok: true, full: true, itemsRefundPaise: 667 + 15_792 });
  });

  it('refuses more than is still active, unknown items and an empty request on a fully cancelled order', () => {
    expect(planCancellation(lines, [{ variantId: 'v1', qty: 4 }]).ok).toBe(false);
    expect(planCancellation(lines, [{ variantId: 'nope', qty: 1 }]).ok).toBe(false);
    expect(planCancellation([line(1, 3, 1000, 3)]).ok).toBe(false);
  });
});

describe('refundFor', () => {
  it('full cancel refunds everything still refundable (incl. freight); partial never more than refundable', () => {
    expect(
      refundFor({
        full: true,
        itemsRefundPaise: 100,
        refundablePaise: 5_000,
        feePercent: 0,
        chargeFee: false,
      }),
    ).toEqual({ gross: 5_000, fee: 0, net: 5_000 });
    expect(
      refundFor({
        full: false,
        itemsRefundPaise: 9_000,
        refundablePaise: 5_000,
        feePercent: 0,
        chargeFee: false,
      }).net,
    ).toBe(5_000);
  });

  it('fee only when charged, half-up, never above the refund', () => {
    expect(
      refundFor({
        full: false,
        itemsRefundPaise: 1_005,
        refundablePaise: 9_999,
        feePercent: 10,
        chargeFee: true,
      }),
    ).toEqual({ gross: 1_005, fee: 101, net: 904 });
    expect(
      refundFor({
        full: false,
        itemsRefundPaise: 1_005,
        refundablePaise: 9_999,
        feePercent: 10,
        chargeFee: false,
      }).fee,
    ).toBe(0);
  });

  it('nothing paid → nothing to refund', () => {
    expect(
      refundFor({
        full: true,
        itemsRefundPaise: 0,
        refundablePaise: 0,
        feePercent: 5,
        chargeFee: true,
      }),
    ).toEqual({ gross: 0, fee: 0, net: 0 });
  });
});
