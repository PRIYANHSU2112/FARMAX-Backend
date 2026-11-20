import { describe, expect, it } from 'vitest';

import {
  allocate,
  fromPaise,
  percentOf,
  toBasisPoints,
  toPaise,
} from '../../../src/features/pricing/money.js';
import { evaluateOffers, formatRupees, priceCart } from '../../../src/features/pricing/index.js';
import { CAT, buyer, config, figma, line, promo } from './fixtures.js';

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('money', () => {
  it('converts decimals exactly', () => {
    expect(toPaise('1420.00')).toBe(142_000);
    expect(toPaise('0.1')).toBe(10);
    expect(toBasisPoints('2.5')).toBe(250);
    expect(fromPaise(217_900)).toBe('2179.00');
    expect(formatRupees(217_900)).toBe('₹2,179');
    expect(formatRupees(12_345_678)).toBe('₹1,23,456.78');
  });

  it('₹100 over 3 equal lines → 3334 / 3333 / 3333 and the sum is exact', () => {
    const shares = allocate(10_000, [500, 500, 500]);
    expect(shares).toEqual([3334, 3333, 3333]);
    expect(sumOf(shares)).toBe(10_000);
  });

  it('leftover paise go to the largest weight first', () => {
    // floors 16 / 50 / 33 = 99; the 2 leftover paise go to weights 300 then 200.
    expect(allocate(101, [100, 300, 200])).toEqual([16, 51, 34]);
  });

  it('15 % of ₹5,000 = ₹750', () => {
    expect(percentOf(500_000, 1_500)).toBe(75_000);
  });
});

describe('Figma: offers for this order', () => {
  const cart = () => [
    line({
      unitPrice: 520_000,
      qty: 2,
      categoryId: CAT.biosecurity,
      name: 'Virkon S 5 kg',
      hsnCode: '3808',
      gstRate: 1_800,
    }),
    line({
      unitPrice: 840_000,
      qty: 2,
      categoryId: CAT.vaccines,
      name: 'ND Lasota 1000d',
      hsnCode: '3002',
      gstRate: 500,
      temperatureClass: 'CC_REF',
    }),
  ];
  const all = () => [figma.SHED500(), figma.VAX300(), figma.MONSOON1000(), figma.RETAIL50()];

  it('SHED500 is auto-picked over VAX300 (₹500 + free freight beats ₹300)', () => {
    const r = evaluateOffers({
      lines: cart(),
      promotions: all(),
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.applied?.code).toBe('SHED500');
    expect(r.applied?.saving).toBe(50_000 + 49_500);
    expect(r.applied?.conditions).toContain('1 use per farm');
    expect(r.applied?.conditions).toContain('Layer & broiler farms');
    const vax = r.alsoEligible.find((o) => o.code === 'VAX300');
    expect(vax?.message).toBe('One coupon per order. SHED500 saves more, so it stays.');
    expect(r.pricing.invoice.freightDiscount).toBe(49_500);
  });

  it('MONSOON1000 nudge: short by ₹2,179 → amountToUnlock 217900 paise', () => {
    // Eligible base = ₹27,821 (just under ₹30,000).
    const lines = [line({ unitPrice: 2_782_100, qty: 1, categoryId: CAT.feedAdditives })];
    const r = evaluateOffers({
      lines,
      promotions: all(),
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    const nudge = r.nudges.find((n) => n.code === 'MONSOON1000');
    expect(nudge?.amountToUnlock).toBe(217_900);
    expect(nudge?.message).toBe('Add ₹2,179 to unlock ₹1,000 off');
    expect(nudge?.progressPct).toBe(92);
  });

  it('RETAIL50 on a GST farm → ACCOUNT_TYPE', () => {
    const r = evaluateOffers({
      lines: cart(),
      promotions: all(),
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    const retail = r.ineligible.find((o) => o.code === 'RETAIL50');
    expect(retail?.reasonCode).toBe('ACCOUNT_TYPE');
    expect(retail?.message).toBe('Retail accounts only. This B2B farm account is not eligible.');
  });

  it('an explicitly chosen code that saves less still applies ("Use instead")', () => {
    const r = evaluateOffers({
      lines: cart(),
      promotions: all(),
      buyer: buyer(),
      config,
      couponCode: 'VAX300',
      applyBundleIds: [],
    });
    expect(r.applied?.code).toBe('VAX300');
    expect(r.alsoEligible.find((o) => o.code === 'SHED500')?.message).toBe(
      'Saves ₹695 more than VAX300.',
    );
  });

  it('per-farm limit reached → FARM_LIMIT', () => {
    const shed = figma.SHED500();
    const r = evaluateOffers({
      lines: cart(),
      promotions: [shed],
      buyer: buyer({ usage: new Map([[shed.id, { farm: 1, user: 1 }]]) }),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.applied).toBeNull();
    expect(r.ineligible[0]?.reasonCode).toBe('FARM_LIMIT');
  });

  it('production type outside the allow-list → PRODUCTION_TYPE', () => {
    const r = evaluateOffers({
      lines: cart(),
      promotions: [figma.SHED500()],
      buyer: buyer({ productionTypes: ['HATCHERY'] }),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.ineligible[0]?.reasonCode).toBe('PRODUCTION_TYPE');
  });

  it('unknown code → NOT_FOUND, cart priced without a coupon', () => {
    const r = priceCart({
      lines: cart(),
      promotions: all(),
      buyer: buyer(),
      config,
      couponCode: 'NOPE',
      applyBundleIds: [],
    });
    expect(r.couponStatus?.reasonCode).toBe('NOT_FOUND');
    expect(r.invoice.couponDiscount).toBe(0);
  });
});

describe('line offers', () => {
  const nd = () => line({ unitPrice: 72_500, qty: 3, name: 'ND', categoryId: CAT.vaccines });
  const ibd = () => line({ unitPrice: 72_400, qty: 2, name: 'IBD', categoryId: CAT.vaccines });
  const pair = (ndId: string, ibdId: string) =>
    promo({
      kind: 'LINE_OFFER',
      benefitType: 'BUNDLE_PAIR',
      title: 'ND + IBD pair',
      bundlePrice: 142_000,
      scope: 'VARIANT',
      targets: [
        { targetType: 'VARIANT', targetId: ndId, bundleQty: 1 },
        { targetType: 'VARIANT', targetId: ibdId, bundleQty: 1 },
      ],
    });

  it('ND + IBD 3 + 2 → 2 pairs at ₹1,420, 1 ND left; paired units excluded from the coupon', () => {
    const a = nd();
    const b = ibd();
    const p = pair(a.variantId, b.variantId);
    const coupon = promo({
      kind: 'ORDER_COUPON',
      benefitType: 'PERCENTAGE',
      code: 'VAX10',
      percentage: 1_000,
      maxDiscountAmount: 100_000,
      scope: 'CATEGORY',
      targets: [{ targetType: 'CATEGORY', targetId: CAT.vaccines, bundleQty: null }],
    });
    const r = priceCart({
      lines: [a, b],
      promotions: [p, coupon],
      buyer: buyer(),
      config,
      couponCode: 'VAX10',
      applyBundleIds: [p.id],
    });
    expect(r.lines[0]?.pairedQty).toBe(2);
    expect(r.lines[1]?.pairedQty).toBe(2);
    expect(r.invoice.lineOfferDiscount).toBe(2 * 2_900);
    // Only the leftover ND unit (₹725) is in the coupon base → 10 % = ₹72.50.
    expect(r.invoice.couponDiscount).toBe(7_250);
    expect(r.lines[1]?.couponDiscount).toBe(0);
    const paired = sumOf(r.lines.map((l) => l.lineGross - l.lineOfferDiscount)) - 72_500;
    expect(paired).toBe(2 * 142_000);
  });

  it('offers screen lists the pair with "saves ₹29 a pair" before it is applied', () => {
    const a = nd();
    const b = ibd();
    const p = pair(a.variantId, b.variantId);
    const r = evaluateOffers({
      lines: [a, b],
      promotions: [p],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.bundles).toEqual([
      expect.objectContaining({ promotionId: p.id, savingPerSet: 2_900, sets: 2, applied: false }),
    ]);
  });

  it('COMBO buy 2 get 1 with qty 5 → exactly 1 free unit', () => {
    const combo = promo({
      kind: 'LINE_OFFER',
      benefitType: 'COMBO',
      comboBuyQty: 2,
      comboGetQty: 1,
      comboGetPercent: 10_000,
    });
    const r = priceCart({
      lines: [line({ unitPrice: 10_000, qty: 5 })],
      promotions: [combo],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.invoice.lineOfferDiscount).toBe(10_000);
  });

  it('COMBO frees the cheapest units across lines of its pool', () => {
    const combo = promo({
      kind: 'LINE_OFFER',
      benefitType: 'COMBO',
      comboBuyQty: 2,
      comboGetQty: 1,
      comboGetPercent: 5_000,
    });
    const r = priceCart({
      lines: [line({ unitPrice: 30_000, qty: 2 }), line({ unitPrice: 10_000, qty: 1 })],
      promotions: [combo],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.lines.map((l) => l.lineOfferDiscount)).toEqual([0, 5_000]);
  });

  it('higher tier wins on a line: COMBO beats a bigger PERCENTAGE', () => {
    const combo = promo({
      kind: 'LINE_OFFER',
      benefitType: 'COMBO',
      comboBuyQty: 2,
      comboGetQty: 1,
      comboGetPercent: 10_000,
    });
    const pct = promo({
      kind: 'LINE_OFFER',
      benefitType: 'PERCENTAGE',
      percentage: 5_000,
      maxDiscountAmount: 1_000_000,
    });
    const r = priceCart({
      lines: [line({ unitPrice: 10_000, qty: 3 })],
      promotions: [combo, pct],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.lines[0]?.lineOfferPromotionIds).toEqual([combo.id]);
  });

  it('a COMBO that cannot form a set falls back to the next offer', () => {
    const combo = promo({
      kind: 'LINE_OFFER',
      benefitType: 'COMBO',
      comboBuyQty: 2,
      comboGetQty: 1,
      comboGetPercent: 10_000,
    });
    const flat = promo({ kind: 'LINE_OFFER', benefitType: 'FLAT', flatAmount: 1_000 });
    const r = priceCart({
      lines: [line({ unitPrice: 10_000, qty: 2 })],
      promotions: [combo, flat],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.invoice.lineOfferDiscount).toBe(2_000);
  });

  it('a non-stackable line offer removes its units from the coupon base', () => {
    const pct = promo({
      kind: 'LINE_OFFER',
      benefitType: 'PERCENTAGE',
      percentage: 1_000,
      maxDiscountAmount: 1_000_000,
      isStackable: false,
      scope: 'CATEGORY',
      targets: [{ targetType: 'CATEGORY', targetId: CAT.vaccines, bundleQty: null }],
    });
    const flat = promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'FLAT100',
      flatAmount: 10_000,
    });
    const r = priceCart({
      lines: [
        line({ unitPrice: 100_000, qty: 1, categoryId: CAT.vaccines }),
        line({ unitPrice: 50_000, qty: 1 }),
      ],
      promotions: [pct, flat],
      buyer: buyer(),
      config,
      couponCode: 'FLAT100',
      applyBundleIds: [],
    });
    expect(r.lines.map((l) => l.couponDiscount)).toEqual([0, 10_000]);
  });

  it('category offers match sub-categories when categoryPath is known [R8]', () => {
    const pct = promo({
      kind: 'LINE_OFFER',
      benefitType: 'PERCENTAGE',
      percentage: 1_000,
      maxDiscountAmount: 1_000_000,
      scope: 'CATEGORY',
      targets: [{ targetType: 'CATEGORY', targetId: CAT.animalHealth, bundleQty: null }],
    });
    const withPath = line({
      unitPrice: 10_000,
      qty: 1,
      categoryId: CAT.vaccines,
      categoryPath: [CAT.animalHealth, CAT.vaccines],
    });
    const noPath = line({ unitPrice: 10_000, qty: 1, categoryId: CAT.vaccines });
    const r = priceCart({
      lines: [withPath, noPath],
      promotions: [pct],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.lines.map((l) => l.lineOfferDiscount)).toEqual([1_000, 0]);
  });
});

describe('order coupon', () => {
  it('PERCENTAGE is capped: 15 % of ₹5,000 capped at ₹300', () => {
    const c = promo({
      kind: 'ORDER_COUPON',
      benefitType: 'PERCENTAGE',
      code: 'P15',
      percentage: 1_500,
      maxDiscountAmount: 30_000,
    });
    const r = priceCart({
      lines: [line({ unitPrice: 500_000, qty: 1 })],
      promotions: [c],
      buyer: buyer(),
      config,
      couponCode: 'P15',
      applyBundleIds: [],
    });
    expect(r.invoice.couponDiscount).toBe(30_000);
  });

  it('pro-rata split with odd paise sums exactly to the coupon', () => {
    const c = promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'F100',
      flatAmount: 10_000,
    });
    const lines = [1, 2, 3].map(() => line({ unitPrice: 33_333, qty: 1 }));
    const r = priceCart({
      lines,
      promotions: [c],
      buyer: buyer(),
      config,
      couponCode: 'F100',
      applyBundleIds: [],
    });
    expect(r.lines.map((l) => l.couponDiscount)).toEqual([3_334, 3_333, 3_333]);
    expect(r.invoice.couponDiscount).toBe(10_000);
  });

  it('a FLAT coupon never exceeds the eligible base', () => {
    const c = promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'BIG',
      flatAmount: 1_000_000,
    });
    const r = priceCart({
      lines: [line({ unitPrice: 50_000, qty: 1 })],
      promotions: [c],
      buyer: buyer(),
      config,
      couponCode: 'BIG',
      applyBundleIds: [],
    });
    expect(r.invoice.couponDiscount).toBe(50_000);
    expect(r.lines[0]?.taxableValue).toBe(0);
  });
});

describe('stacking [R2]', () => {
  const lines = () => [line({ unitPrice: 1_000_000, qty: 1 })];
  const coupon = (stackable: boolean, amount = 20_000) =>
    promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'C200',
      flatAmount: amount,
      isStackable: stackable,
    });

  it('coupon + bonus both stackable → both apply', () => {
    const r = priceCart({
      lines: lines(),
      promotions: [coupon(true), figma.WELCOME30(true)],
      buyer: buyer(),
      config,
      couponCode: 'C200',
      applyBundleIds: [],
    });
    expect(r.invoice.couponDiscount).toBe(20_000);
    expect(r.invoice.autoBonusDiscount).toBe(3_000);
  });

  it('one not stackable → the bigger saving applies (coupon ₹200 > bonus ₹30)', () => {
    const r = priceCart({
      lines: lines(),
      promotions: [coupon(false), figma.WELCOME30(true)],
      buyer: buyer(),
      config,
      couponCode: 'C200',
      applyBundleIds: [],
    });
    expect(r.invoice.couponDiscount).toBe(20_000);
    expect(r.invoice.autoBonusDiscount).toBe(0);
  });

  it('one not stackable and the bonus saves more → coupon is DISPLACED', () => {
    const r = priceCart({
      lines: lines(),
      promotions: [coupon(false, 1_000), figma.WELCOME30(true)],
      buyer: buyer(),
      config,
      couponCode: 'C200',
      applyBundleIds: [],
    });
    expect(r.invoice.autoBonusDiscount).toBe(3_000);
    expect(r.couponStatus?.reasonCode).toBe('DISPLACED');
  });

  it('NEW_FARM bonus does not apply after the first order', () => {
    const r = priceCart({
      lines: lines(),
      promotions: [figma.WELCOME30(true)],
      buyer: buyer({ farmOrderCount: 1 }),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.invoice.autoBonusDiscount).toBe(0);
  });
});

describe('GST and freight [R3]', () => {
  it('intra-state: CGST + SGST per HSN at 2.5 % and 9 % on the post-discount value', () => {
    const c = promo({
      kind: 'ORDER_COUPON',
      benefitType: 'FLAT',
      code: 'F100',
      flatAmount: 10_000,
    });
    const r = priceCart({
      lines: [
        line({ unitPrice: 100_000, qty: 1, hsnCode: '2101', gstRate: 500 }),
        line({ unitPrice: 100_000, qty: 1, hsnCode: '0424', gstRate: 1_800 }),
      ],
      promotions: [c],
      buyer: buyer(),
      config,
      couponCode: 'F100',
      applyBundleIds: [],
    });
    // Each line gets ₹50 off → taxable ₹950.
    expect(r.lines.map((l) => [l.taxableValue, l.cgst, l.sgst, l.igst])).toEqual([
      [95_000, 2_375, 2_375, 0],
      [95_000, 8_550, 8_550, 0],
    ]);
    expect(r.invoice.cgst).toBe(sumOf(r.invoice.gstByHsn.map((g) => g.cgst)));
    expect(r.invoice.finalPayable).toBe(190_000 + 2 * (2_375 + 8_550));
  });

  it('inter-state → IGST only', () => {
    const r = priceCart({
      lines: [line({ unitPrice: 100_000, qty: 1, gstRate: 1_800 })],
      promotions: [],
      buyer: buyer({ stateCode: '36' }),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(r.lines[0]).toMatchObject({ cgst: 0, sgst: 0, igst: 18_000 });
    expect(r.invoice.interState).toBe(true);
  });

  it('GST rounds half-up per line and the HSN totals are the sum of the lines', () => {
    const lines = [1, 2, 3].map(() =>
      line({ unitPrice: 3_333, qty: 1, hsnCode: '3002', gstRate: 500 }),
    );
    const r = priceCart({
      lines,
      promotions: [],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    // 3333 × 2.5 % = 83.325 → 83 per line, per tax.
    expect(r.lines.map((l) => l.cgst)).toEqual([83, 83, 83]);
    expect(r.invoice.gstByHsn).toEqual([
      { hsnCode: '3002', rate: 500, taxable: 9_999, cgst: 249, sgst: 249, igst: 0 },
    ]);
  });

  it('free cold-chain freight: ₹495 shown, waived, item GST unchanged', () => {
    const items = () => [
      line({ unitPrice: 100_000, qty: 1, temperatureClass: 'CC_REF', gstRate: 500 }),
    ];
    const ship = promo({
      kind: 'SHIPPING',
      benefitType: 'FREE_SHIPPING',
      title: 'Free cold-chain freight',
    });
    const without = priceCart({
      lines: items(),
      promotions: [],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    const withPromo = priceCart({
      lines: items(),
      promotions: [ship],
      buyer: buyer(),
      config,
      couponCode: null,
      applyBundleIds: [],
    });
    expect(without.invoice.freight).toBe(49_500);
    expect(without.invoice.freightGst).toBe(8_910);
    expect(withPromo.invoice).toMatchObject({
      freight: 49_500,
      freightDiscount: 49_500,
      freightTaxable: 0,
      freightGst: 0,
    });
    expect(withPromo.lines[0]?.cgst).toBe(without.lines[0]?.cgst);
    expect(withPromo.invoice.finalPayable).toBe(without.invoice.finalPayable - 49_500 - 8_910);
  });
});

describe('eligibility', () => {
  const base = () => ({
    lines: [line({ unitPrice: 100_000, qty: 1 })],
    buyer: buyer(),
    config,
    applyBundleIds: [] as string[],
  });
  const cases: [string, Parameters<typeof promo>[0], string][] = [
    [
      'expired',
      {
        kind: 'ORDER_COUPON',
        benefitType: 'FLAT',
        code: 'X',
        flatAmount: 100,
        endAt: new Date('2026-11-01T00:00:00Z'),
      },
      'EXPIRED',
    ],
    [
      'not started',
      {
        kind: 'ORDER_COUPON',
        benefitType: 'FLAT',
        code: 'X',
        flatAmount: 100,
        startAt: new Date('2026-12-01T00:00:00Z'),
      },
      'NOT_STARTED',
    ],
    [
      'paused',
      { kind: 'ORDER_COUPON', benefitType: 'FLAT', code: 'X', flatAmount: 100, status: 'PAUSED' },
      'INACTIVE',
    ],
    [
      'fully redeemed',
      {
        kind: 'ORDER_COUPON',
        benefitType: 'FLAT',
        code: 'X',
        flatAmount: 100,
        totalUsageLimit: 5,
        usedCount: 5,
      },
      'USAGE_EXHAUSTED',
    ],
    [
      'other state',
      {
        kind: 'ORDER_COUPON',
        benefitType: 'FLAT',
        code: 'X',
        flatAmount: 100,
        rules: [{ ruleType: 'STATE', value: '36' }],
      },
      'REGION',
    ],
    [
      'card only',
      {
        kind: 'ORDER_COUPON',
        benefitType: 'FLAT',
        code: 'X',
        flatAmount: 100,
        paymentMethod: 'CARD',
      },
      'PAYMENT_METHOD',
    ],
    [
      'members only',
      { kind: 'ORDER_COUPON', benefitType: 'FLAT', code: 'X', flatAmount: 100, isMemberOnly: true },
      'MEMBER_ONLY',
    ],
  ];
  it.each(cases)('%s → %s', (_name, over, reason) => {
    const r = priceCart({ ...base(), promotions: [promo(over)], couponCode: 'X' });
    expect(r.couponStatus?.reasonCode).toBe(reason);
    expect(r.invoice.couponDiscount).toBe(0);
  });
});
