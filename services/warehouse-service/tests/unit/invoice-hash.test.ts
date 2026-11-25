import { describe, expect, it } from 'vitest';

import {
  invoiceLinesHash,
  invoiceLinesOf,
} from '../../src/features/fulfilment/fulfilment.rules.js';

describe('D-61 invoice lines hash (shared with order-service: same test vector there)', () => {
  it('matches the fixed vector, ignores order and qty 0', () => {
    expect(
      invoiceLinesHash([
        { lineNo: 2, qty: 5 },
        { lineNo: 1, qty: 3 },
        { lineNo: 7, qty: 0 },
      ]),
    ).toBe('44f745929bc6fe3b');
  });

  it('bills order line + packed qty; a packed line without an order line blocks the invoice', () => {
    expect(
      invoiceLinesOf([
        { orderLineNo: 1, packedQty: 3 },
        { orderLineNo: 2, packedQty: 0 },
      ]),
    ).toEqual([{ lineNo: 1, qty: 3 }]);
    expect(invoiceLinesOf([{ orderLineNo: null, packedQty: 1 }])).toBeNull();
    expect(invoiceLinesOf([{ orderLineNo: null, packedQty: 0 }])).toEqual([]);
  });
});
