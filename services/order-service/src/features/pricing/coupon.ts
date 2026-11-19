import { inScope } from './eligibility.js';
import type { LineAfterA } from './line-offers.js';
import { type Paise, allocate, percentOf, sum } from './money.js';
import type { PromoDef } from './pricing.types.js';

/**
 * Phase B / B2 — order coupon and auto bonus.
 * Base per line = non-paired value after Phase A, and only when the line offer on it is stackable
 * (bundle units are never in the base). `already` = what an earlier phase took from each line.
 */
export function baseWeights(
  promo: PromoDef,
  lines: readonly LineAfterA[],
  already: readonly Paise[] = [],
): Paise[] {
  return lines.map((l, i) =>
    inScope(promo, l.line) && l.restStackable ? Math.max(0, l.restAfterA - (already[i] ?? 0)) : 0,
  );
}

/** FLAT, or PERCENTAGE capped at maxDiscountAmount; never more than the base. */
export function discountOn(promo: PromoDef, base: Paise): Paise {
  let d = 0;
  if (promo.benefitType === 'FLAT') d = promo.flatAmount ?? 0;
  else if (promo.benefitType === 'PERCENTAGE') {
    d = percentOf(base, promo.percentage ?? 0);
    if (promo.maxDiscountAmount !== null) d = Math.min(d, promo.maxDiscountAmount);
  }
  return Math.max(0, Math.min(d, base));
}

/** Discount + its exact per-line split over the given weights. */
export function priceOrderPromo(
  promo: PromoDef,
  weights: readonly Paise[],
): { discount: Paise; shares: Paise[] } {
  const discount = discountOn(promo, sum(weights));
  return { discount, shares: allocate(discount, weights) };
}
