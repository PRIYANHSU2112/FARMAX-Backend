import { describe, expect, it } from 'vitest';

import { priceCart } from '../../../src/features/pricing/index.js';
import { buyer, config, line, promo } from './fixtures.js';

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('per-promotion allocations (exact discount split per line)', () => {
  it('every line carries each promotion share; Σ = the line discounts and each promotion total', () => {
    const lineOffer = promo({ kind: 'LINE_OFFER', benefitType: 'PERCENTAGE', percentage: 500, maxDiscountAmount: 1_000_000, isStackable: true });
    const coupon = promo({ kind: 'ORDER_COUPON', benefitType: 'FLAT', code: 'F100', flatAmount: 10_000, isStackable: true });
    const bonus = promo({ kind: 'AUTO_BONUS', benefitType: 'FLAT', flatAmount: 3_000, isAutoApply: true, isStackable: true });
    const r = priceCart({
      lines: [line({ unitPrice: 33_333, qty: 1 }), line({ unitPrice: 66_667, qty: 1 })],
      promotions: [lineOffer, coupon, bonus],
      buyer: buyer(),
      config,
      couponCode: 'F100',
      applyBundleIds: [],
    });
    for (const l of r.lines) {
      expect(sumOf(l.allocations.map((a) => a.amount))).toBe(l.lineOfferDiscount + l.couponDiscount + l.autoBonusDiscount);
    }
    const byPromo = (id: string) => sumOf(r.lines.flatMap((l) => l.allocations.filter((a) => a.promotionId === id).map((a) => a.amount)));
    expect(byPromo(coupon.id)).toBe(10_000);
    expect(byPromo(bonus.id)).toBe(3_000);
  });
});
