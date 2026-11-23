import { describe, expect, it } from 'vitest';

import { type StatsFacts, aggregateStats } from '../../src/features/stock/stock.stats.js';

const level = (
  warehouseId: string,
  variantId: string,
  onHand: number,
  reserved = 0,
  damaged = 0,
  safetyStock = 0,
) => ({
  warehouseId,
  variantId,
  onHand,
  reserved,
  damaged,
  safetyStock,
});

describe('warehouse stats (D-56 P3, plan §8.1)', () => {
  const facts = new Map<string, StatsFacts>([
    ['feed', { rootCategoryId: 'cat-feed', weightGrams: 25_000 }],
    ['vac', { rootCategoryId: 'cat-vet', weightGrams: 333 }],
    ['nowt', { rootCategoryId: 'cat-vet', weightGrams: null }],
    ['zero', { rootCategoryId: null, weightGrams: 0 }],
  ]);

  it('kg from grams over onHand + damaged; unknown weights excluded and reported', () => {
    const [w] = aggregateStats(
      [
        level('w1', 'feed', 10, 2, 1), // 11 physical × 25 kg = 275 kg
        level('w1', 'vac', 3), // 3 × 0.333 kg = 0.999 kg
        level('w1', 'nowt', 4, 0, 1), // 5 unweighed
        level('w1', 'zero', 1), // 1 unweighed (0 g is unknown)
        level('w1', 'unknown-variant', 0, 0, 0),
      ],
      facts,
    );
    expect(w).toMatchObject({
      warehouseId: 'w1',
      onHand: 18,
      reserved: 2,
      damaged: 2,
      available: 16,
      skuCount: 4,
      usedKg: '276.00',
      weighedUnits: 14,
      unweighedUnits: 6,
      unweighedSkus: 2,
      weightKnownPct: 70,
    });
  });

  it('available never goes below zero and respects safety stock', () => {
    const [w] = aggregateStats(
      [level('w1', 'feed', 5, 4, 0, 3), level('w1', 'vac', 2, 0, 0, 1)],
      facts,
    );
    expect(w?.available).toBe(1);
  });

  it('groups by root category (unclassified as null), biggest first, per warehouse', () => {
    const out = aggregateStats(
      [
        level('w1', 'vac', 3),
        level('w1', 'nowt', 4, 1),
        level('w1', 'feed', 20),
        level('w1', 'zero', 1),
        level('w2', 'feed', 1),
      ],
      facts,
    );
    expect(out).toHaveLength(2);
    expect(out[0]?.categories).toEqual([
      { rootCategoryId: 'cat-feed', skuCount: 1, onHand: 20, reserved: 0, available: 20 },
      { rootCategoryId: 'cat-vet', skuCount: 2, onHand: 7, reserved: 1, available: 6 },
      { rootCategoryId: null, skuCount: 1, onHand: 1, reserved: 0, available: 1 },
    ]);
  });

  it('nothing stored → 100% known weight, 0 kg', () => {
    const [w] = aggregateStats([level('w1', 'feed', 0, 3)], facts);
    expect(w).toMatchObject({ usedKg: '0.00', weightKnownPct: 100, skuCount: 0 });
  });
});
