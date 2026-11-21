import { describe, expect, it } from 'vitest';

import { changePercent } from '../../src/features/ledger/ledger.types.js';
import {
  cashbackFor,
  instrumentLabel,
  istDayStart,
  outcomeState,
} from '../../src/features/topups/topups.types.js';

const RULE = { percentBps: 1_000, maxPaise: 5_000 }; // 10 %, max ₹50

describe('first-top-up cashback', () => {
  it('10 % capped at ₹50, paid as points (10 paise each, floored)', () => {
    expect(cashbackFor(1_000_000n, RULE, 10)).toEqual({ paise: 5_000n, points: 500 }); // ₹10,000
    expect(cashbackFor(20_000n, RULE, 10)).toEqual({ paise: 2_000n, points: 200 }); // ₹200
    expect(cashbackFor(10_005n, RULE, 10)).toEqual({ paise: 1_000n, points: 100 });
    expect(cashbackFor(10_099n, RULE, 10)).toEqual({ paise: 1_009n, points: 100 });
    expect(cashbackFor(1_000_000n, { percentBps: 0, maxPaise: 5_000 }, 10)).toEqual({
      paise: 0n,
      points: 0,
    });
  });
});

describe('weekly change', () => {
  it('is exact to 2 decimals from integer paise; null without a base', () => {
    expect(changePercent(11_521_045n, 10_626_327n)).toBe('8.41');
    expect(changePercent(100n, 200n)).toBe('-50.00');
    expect(changePercent(100n, 100n)).toBe('0.00');
    expect(changePercent(500n, 0n)).toBeNull();
  });
});

describe('IST day window (daily top-up limit)', () => {
  it('starts at 00:00 IST = 18:30 UTC the day before', () => {
    expect(istDayStart(new Date('2026-11-21T10:00:00Z')).toISOString()).toBe(
      '2026-11-20T18:30:00.000Z',
    );
    // 23:59 IST on the 20th is still the 20th.
    expect(istDayStart(new Date('2026-11-20T18:29:00Z')).toISOString()).toBe(
      '2026-11-19T18:30:00.000Z',
    );
  });
});

describe('payment status → top-up outcome', () => {
  it('maps every payment-service status', () => {
    expect(outcomeState('CAPTURED')).toBe('CAPTURED');
    expect(outcomeState('PARTIALLY_REFUNDED')).toBe('CAPTURED');
    expect(outcomeState('REFUNDED')).toBe('CAPTURED');
    expect(outcomeState('FAILED')).toBe('FAILED');
    expect(outcomeState('EXPIRED')).toBe('EXPIRED');
    expect(outcomeState('CANCELLED')).toBe('EXPIRED');
    expect(outcomeState('PENDING')).toBe('OPEN');
    expect(outcomeState('CREATED')).toBe('OPEN');
  });

  it('labels the instrument with masked data only', () => {
    const none = {
      paidMethod: null,
      bank: null,
      cardLast4: null,
      cardNetwork: null,
      vpaMasked: null,
    };
    expect(instrumentLabel({ ...none, cardLast4: '4821', cardNetwork: 'Visa' })).toBe(
      'Visa (**4821)',
    );
    expect(instrumentLabel({ ...none, vpaMasked: 've***@okhdfc' })).toBe('UPI ve***@okhdfc');
    expect(instrumentLabel({ ...none, bank: 'HDFC' })).toBe('HDFC (Net Banking)');
    expect(instrumentLabel(none)).toBeNull();
  });
});
