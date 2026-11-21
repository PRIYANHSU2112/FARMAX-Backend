import { describe, expect, it } from 'vitest';

import { newJournalNo } from '../../src/features/ledger/ledger.service.js';
import { rupees, toBalanceView } from '../../src/features/ledger/ledger.types.js';

describe('ledger helpers', () => {
  it('formats paise as rupees exactly (no floating point)', () => {
    expect(rupees(0n)).toBe('0.00');
    expect(rupees(5n)).toBe('0.05');
    expect(rupees(12_489_265n)).toBe('124892.65');
    expect(rupees(9_007_199_254_740_993n)).toBe('90071992547409.93');
    expect(rupees(-150n)).toBe('-1.50');
  });

  it('journal numbers are WJ-yymmdd-8 hex and unique enough', () => {
    const many = new Set(Array.from({ length: 1_000 }, newJournalNo));
    expect(many.size).toBe(1_000);
    for (const n of many) expect(n).toMatch(/^WJ-\d{6}-[0-9A-F]{8}$/);
  });

  it('a customer without an account has ₹0 and ACTIVE', () => {
    expect(toBalanceView(null)).toEqual({
      balancePaise: 0,
      balance: '0.00',
      currency: 'INR',
      status: 'ACTIVE',
      frozenReason: null,
      week: { creditsPaise: 0, credits: '0.00', changePercent: null },
    });
  });
});
