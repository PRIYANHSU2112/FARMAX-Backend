import { describe, expect, it } from 'vitest';

import {
  canTransition,
  liveEditIssues,
  normalizeCode,
  overlapping,
  promotionIssues,
} from '../../../src/features/promotions/promotions.rules.js';
import type {
  PromotionFields,
  PromotionRecord,
} from '../../../src/features/promotions/promotions.types.js';

const T = (id: string) => ({ targetType: 'VARIANT' as const, targetId: id, bundleQty: null });

const fields = (over: Partial<PromotionFields> = {}): PromotionFields => ({
  code: 'SHED500',
  title: '₹500 off biosecurity over ₹10,000',
  subtitle: null,
  termsText: null,
  badgeText: null,
  kind: 'ORDER_COUPON',
  benefitType: 'FLAT',
  flatAmount: 500,
  percentage: null,
  maxDiscountAmount: null,
  comboBuyQty: null,
  comboGetQty: null,
  comboGetPercent: null,
  bundlePrice: null,
  freeShipping: true,
  scope: 'PLATFORM_WIDE',
  minOrderAmount: 10_000,
  startAt: new Date('2026-11-01T00:00:00Z'),
  endAt: new Date('2026-12-31T00:00:00Z'),
  isAutoApply: false,
  isStackable: true,
  priority: 0,
  totalUsageLimit: null,
  perFarmLimit: 1,
  perUserLimit: null,
  accountType: 'ALL',
  farmHistory: 'ALL',
  paymentMethod: 'ANY',
  isMemberOnly: false,
  isPublic: false,
  targets: [],
  rules: [],
  ...over,
});

const record = (over: Partial<PromotionRecord> = {}): PromotionRecord =>
  ({
    ...fields(),
    id: 'p1',
    flatAmount: '500.00',
    percentage: null,
    maxDiscountAmount: null,
    comboGetPercent: null,
    bundlePrice: null,
    minOrderAmount: '10000.00',
    status: 'ACTIVE',
    statusChangedAt: new Date(),
    statusChangedByUserId: 'u',
    statusReason: null,
    usedCount: 0,
    version: 1,
    createdByUserId: 'u',
    updatedByUserId: 'u',
    createdAt: new Date(),
    updatedAt: new Date(),
    totalUsageLimit: 100,
    ...over,
  }) as PromotionRecord;

const paths = (issues: { path: string }[]) => issues.map((i) => i.path);

describe('code normalisation [R1]', () => {
  it('trims and upper-cases; blank → null', () => {
    expect(normalizeCode(' shed500 ')).toBe('SHED500');
    expect(normalizeCode('   ')).toBeNull();
    expect(normalizeCode(null)).toBeNull();
  });
});

describe('state machine [R6]', () => {
  it.each([
    ['DRAFT', 'ACTIVE', true],
    ['DRAFT', 'ARCHIVED', true],
    ['DRAFT', 'PAUSED', false],
    ['ACTIVE', 'PAUSED', true],
    ['PAUSED', 'ACTIVE', true],
    ['ACTIVE', 'ARCHIVED', true],
    ['ARCHIVED', 'ACTIVE', false],
    ['ARCHIVED', 'DRAFT', false],
  ] as const)('%s → %s = %s', (from, to, ok) => {
    expect(canTransition(from, to)).toBe(ok);
  });
});

describe('promotion consistency [R6]', () => {
  it('a valid coupon has no issues', () => {
    expect(promotionIssues(fields())).toEqual([]);
  });

  it('PERCENTAGE without a cap', () => {
    expect(
      paths(
        promotionIssues(fields({ benefitType: 'PERCENTAGE', percentage: 10, flatAmount: null })),
      ),
    ).toContain('body.maxDiscountAmount');
  });

  it('FLAT coupon not below its minimum order', () => {
    expect(paths(promotionIssues(fields({ flatAmount: 10_000 })))).toContain('body.flatAmount');
  });

  it('BUNDLE_PAIR needs ≥ 2 targets with bundleQty and is never stackable', () => {
    const issues = paths(
      promotionIssues(
        fields({
          kind: 'LINE_OFFER',
          code: null,
          benefitType: 'BUNDLE_PAIR',
          bundlePrice: 1420,
          scope: 'VARIANT',
          targets: [{ ...T('a'), bundleQty: 1 }],
          isStackable: true,
        }),
      ),
    );
    expect(issues).toEqual(expect.arrayContaining(['body.targets', 'body.isStackable']));
  });

  it('scope and targets must agree', () => {
    expect(paths(promotionIssues(fields({ scope: 'CATEGORY' })))).toContain('body.targets');
    expect(paths(promotionIssues(fields({ targets: [T('a')] })))).toContain('body.targets');
  });

  it('kind rules: coupon needs a code; auto bonus must auto-apply; COMBO is not a coupon benefit', () => {
    expect(paths(promotionIssues(fields({ code: null })))).toContain('body.code');
    expect(paths(promotionIssues(fields({ kind: 'AUTO_BONUS', code: null })))).toContain(
      'body.isAutoApply',
    );
    expect(
      paths(
        promotionIssues(
          fields({ benefitType: 'COMBO', comboBuyQty: 2, comboGetQty: 1, comboGetPercent: 100 }),
        ),
      ),
    ).toContain('body.benefitType');
  });

  it('activation also needs endAt in the future', () => {
    expect(paths(promotionIssues(fields(), new Date('2027-01-01T00:00:00Z')))).toContain(
      'body.endAt',
    );
  });
});

describe('live edits [R6]', () => {
  it('benefit fields are locked once live; title / limits / endAt are not', () => {
    expect(paths(liveEditIssues(record(), { flatAmount: 600 }))).toEqual(['body.flatAmount']);
    expect(liveEditIssues(record(), { title: 'New title', totalUsageLimit: 200 })).toEqual([]);
  });

  it('endAt only extends, limits only rise', () => {
    expect(paths(liveEditIssues(record(), { endAt: new Date('2026-12-01T00:00:00Z') }))).toEqual([
      'body.endAt',
    ]);
    expect(paths(liveEditIssues(record(), { totalUsageLimit: 50 }))).toEqual([
      'body.totalUsageLimit',
    ]);
    expect(liveEditIssues(record(), { totalUsageLimit: null })).toEqual([]);
  });
});

describe('overlap check [R6]', () => {
  const lineOffer = (
    id: string,
    targets: ReturnType<typeof T>[],
    status: PromotionRecord['status'] = 'ACTIVE',
    window = { startAt: new Date('2026-11-01'), endAt: new Date('2026-12-01') },
  ) =>
    ({
      id,
      kind: 'LINE_OFFER',
      status,
      targets,
      accountType: 'ALL',
      farmHistory: 'ALL',
      ...window,
    }) as const;

  it('LINE_OFFER sharing a target in an overlapping window conflicts', () => {
    const me = lineOffer('me', [T('v1')]);
    expect(overlapping(me, [lineOffer('a', [T('v1')]), lineOffer('b', [T('v2')])])).toEqual(['a']);
  });

  it('no conflict when windows only touch, or the other is DRAFT', () => {
    const me = lineOffer('me', [T('v1')]);
    const later = lineOffer('a', [T('v1')], 'ACTIVE', {
      startAt: new Date('2026-12-01'),
      endAt: new Date('2027-01-01'),
    });
    expect(overlapping(me, [later, lineOffer('d', [T('v1')], 'DRAFT')])).toEqual([]);
  });

  it('a platform-wide line offer overlaps every other line offer', () => {
    expect(overlapping(lineOffer('me', []), [lineOffer('a', [T('v9')])])).toEqual(['a']);
  });

  it('AUTO_BONUS conflicts only when audiences overlap', () => {
    const bonus = (id: string, farmHistory: 'ALL' | 'NEW_FARM' | 'EXISTING_FARM') => ({
      id,
      kind: 'AUTO_BONUS' as const,
      status: 'ACTIVE' as const,
      targets: [],
      accountType: 'ALL' as const,
      farmHistory,
      startAt: new Date('2026-11-01'),
      endAt: new Date('2026-12-01'),
    });
    expect(
      overlapping(bonus('me', 'NEW_FARM'), [bonus('a', 'EXISTING_FARM'), bonus('b', 'ALL')]),
    ).toEqual(['b']);
  });
});
