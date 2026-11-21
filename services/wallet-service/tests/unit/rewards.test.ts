import { describe, expect, it } from 'vitest';

import {
  addMonths,
  allocate,
  convertRefusal,
  earnPoints,
  reversalPoints,
} from '../../src/features/rewards/rewards.rules.js';

describe('reward points rules', () => {
  it('earns 1 point per ₹10 of net paid value, floored', () => {
    expect(earnPoints(4_805_000n, 1_000)).toBe(4_805n);
    expect(earnPoints(999n, 1_000)).toBe(0n);
    expect(earnPoints(1_999n, 1_000)).toBe(1n);
    expect(earnPoints(0n, 1_000)).toBe(0n);
  });

  it('reverses the refunded share, floored, never more than is left', () => {
    const lot = { earnedPts: 1_000n, basePaise: 1_000_000n, reversedPts: 0n };
    expect(reversalPoints(lot, 500_000n)).toBe(500n);
    expect(reversalPoints(lot, 333_333n)).toBe(333n);
    expect(reversalPoints({ ...lot, reversedPts: 900n }, 500_000n)).toBe(100n);
    expect(reversalPoints({ ...lot, basePaise: 0n }, 500_000n)).toBe(0n);
  });

  it('allocates FIFO and reports a shortfall', () => {
    const lots = [
      { id: 'a', remainingPts: 300n },
      { id: 'b', remainingPts: 500n },
    ];
    expect(allocate(lots, 600n)).toEqual({
      takes: [
        { lotId: 'a', points: 300n },
        { lotId: 'b', points: 300n },
      ],
      shortfall: 0n,
    });
    expect(allocate(lots, 900n).shortfall).toBe(100n);
    expect(allocate(lots, 0n).takes).toEqual([]);
  });

  it('refuses conversions below the minimum, off-step or above the balance', () => {
    const rule = { min: 1_000, step: 100 };
    expect(convertRefusal(900, 5_000n, rule)).toBe('BELOW_MINIMUM');
    expect(convertRefusal(1_050, 5_000n, rule)).toBe('NOT_A_MULTIPLE');
    expect(convertRefusal(6_000, 5_000n, rule)).toBe('INSUFFICIENT_POINTS');
    expect(convertRefusal(5_000, 5_000n, rule)).toBeNull();
  });

  it('adds months, clamping to the last day', () => {
    expect(addMonths(new Date('2026-01-31T10:00:00Z'), 1).toISOString()).toBe(
      '2026-02-28T10:00:00.000Z',
    );
    expect(addMonths(new Date('2026-11-21T00:00:00Z'), 12).toISOString()).toBe(
      '2027-11-21T00:00:00.000Z',
    );
  });
});
