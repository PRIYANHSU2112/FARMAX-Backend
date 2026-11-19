import type { ValidationIssue } from '@farmx/common/errors';

import type { PromoStatus, PromotionFields, PromotionRecord } from './promotions.types.js';

/** [R1] One spelling per code: trimmed, UPPERCASE. Lookups normalise the same way. */
export const normalizeCode = (code: string | null | undefined): string | null => {
  const c = code?.trim().toUpperCase() ?? '';
  return c === '' ? null : c;
};

/** [R6] DRAFT → ACTIVE | ARCHIVED; ACTIVE ↔ PAUSED; ACTIVE | PAUSED → ARCHIVED; ARCHIVED is final. */
const TRANSITIONS: Readonly<Record<PromoStatus, readonly PromoStatus[]>> = {
  DRAFT: ['ACTIVE', 'ARCHIVED'],
  ACTIVE: ['PAUSED', 'ARCHIVED'],
  PAUSED: ['ACTIVE', 'ARCHIVED'],
  ARCHIVED: [],
};

export const canTransition = (from: PromoStatus, to: PromoStatus): boolean =>
  TRANSITIONS[from].includes(to);

const TARGET_OF_SCOPE: Record<string, string> = {
  CATEGORY: 'CATEGORY',
  PRODUCT: 'PRODUCT',
  VARIANT: 'VARIANT',
  BRAND: 'BRAND',
};

const BENEFITS_OF_KIND: Record<string, readonly string[]> = {
  LINE_OFFER: ['FLAT', 'PERCENTAGE', 'COMBO', 'BUNDLE_PAIR'],
  ORDER_COUPON: ['FLAT', 'PERCENTAGE', 'FREE_SHIPPING'],
  AUTO_BONUS: ['FLAT', 'PERCENTAGE', 'FREE_SHIPPING'],
  SHIPPING: ['FREE_SHIPPING', 'FLAT'],
};

/**
 * [R6] Consistency of a whole promotion (create, update and activation). `now` given → also the
 * activation checks (endAt in the future). Returns every issue, not just the first.
 */
export function promotionIssues(p: PromotionFields, now?: Date): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const add = (path: string, message: string) => issues.push({ path: `body.${path}`, message });
  const allowed = BENEFITS_OF_KIND[p.kind] ?? [];
  if (!allowed.includes(p.benefitType))
    add('benefitType', `${p.kind} supports ${allowed.join(', ')}`);
  if (p.endAt.getTime() <= p.startAt.getTime()) add('endAt', 'must be after startAt');
  if (now !== undefined && p.endAt.getTime() <= now.getTime())
    add('endAt', 'must be in the future to activate');

  switch (p.benefitType) {
    case 'FLAT':
      if (p.flatAmount === null || p.flatAmount <= 0) add('flatAmount', 'is required for FLAT');
      else if (
        p.kind === 'ORDER_COUPON' &&
        p.minOrderAmount > 0 &&
        p.flatAmount >= p.minOrderAmount
      )
        add('flatAmount', 'must be less than minOrderAmount');
      break;
    case 'PERCENTAGE':
      if (p.percentage === null) add('percentage', 'is required for PERCENTAGE');
      if (p.maxDiscountAmount === null || p.maxDiscountAmount <= 0)
        add('maxDiscountAmount', 'is required for PERCENTAGE (the cap)');
      break;
    case 'COMBO':
      if (p.comboBuyQty === null || p.comboBuyQty < 1) add('comboBuyQty', 'is required for COMBO');
      if (p.comboGetQty === null || p.comboGetQty < 1) add('comboGetQty', 'is required for COMBO');
      if (p.comboGetPercent === null) add('comboGetPercent', 'is required for COMBO (100 = free)');
      break;
    case 'BUNDLE_PAIR': {
      if (p.bundlePrice === null || p.bundlePrice <= 0)
        add('bundlePrice', 'is required for BUNDLE_PAIR');
      const parts = p.targets.filter((t) => (t.bundleQty ?? 0) > 0);
      if (parts.length < 2 || parts.length !== p.targets.length)
        add('targets', 'BUNDLE_PAIR needs at least 2 targets, each with bundleQty ≥ 1');
      if (p.isStackable) add('isStackable', 'BUNDLE_PAIR is never stackable');
      break;
    }
    case 'FREE_SHIPPING':
      break;
  }
  if (p.benefitType !== 'BUNDLE_PAIR' && p.targets.some((t) => t.bundleQty != null))
    add('targets', 'bundleQty is only for BUNDLE_PAIR');

  if (p.scope === 'PLATFORM_WIDE') {
    if (p.targets.length > 0) add('targets', 'must be empty for PLATFORM_WIDE');
  } else {
    if (p.targets.length === 0) add('targets', `at least one ${p.scope} target is required`);
    if (p.targets.some((t) => t.targetType !== TARGET_OF_SCOPE[p.scope]))
      add('targets', `every target must be of type ${TARGET_OF_SCOPE[p.scope] ?? p.scope}`);
  }

  if (p.kind === 'ORDER_COUPON') {
    if (p.code === null) add('code', 'is required for ORDER_COUPON');
    if (p.isAutoApply) add('isAutoApply', 'an ORDER_COUPON is applied by code, not automatically');
  } else if (p.kind === 'AUTO_BONUS') {
    if (!p.isAutoApply) add('isAutoApply', 'must be true for AUTO_BONUS');
  } else if (p.code !== null) add('code', `${p.kind} has no code`);
  return issues;
}

/** Fields that may still change once a promotion has been live (ACTIVE / PAUSED). [R6] */
export const EDITABLE_WHEN_LIVE = new Set([
  'title',
  'subtitle',
  'termsText',
  'badgeText',
  'endAt',
  'totalUsageLimit',
  'perFarmLimit',
  'perUserLimit',
]);

/** Live edits: endAt may only be extended, limits only raised (null = unlimited). */
export function liveEditIssues(
  current: PromotionRecord,
  patch: Partial<PromotionFields>,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const key of Object.keys(patch)) {
    if (!EDITABLE_WHEN_LIVE.has(key))
      issues.push({
        path: `body.${key}`,
        message: `cannot change once the promotion is ${current.status}; clone it as a new DRAFT`,
      });
  }
  if (patch.endAt !== undefined && patch.endAt.getTime() < current.endAt.getTime())
    issues.push({ path: 'body.endAt', message: 'can only be extended while live' });
  for (const key of ['totalUsageLimit', 'perFarmLimit', 'perUserLimit'] as const) {
    const next = patch[key];
    const prev = current[key];
    if (next === undefined || prev === null) continue;
    if (next !== null && next < prev)
      issues.push({ path: `body.${key}`, message: 'can only be raised while live' });
  }
  return issues;
}

/** Two windows [a, b) overlap. */
export const windowsOverlap = (
  a: { startAt: Date; endAt: Date },
  b: { startAt: Date; endAt: Date },
): boolean => a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();

/** AUTO_BONUS audiences overlap when neither field separates them (ALL overlaps everything). */
export const audiencesOverlap = (
  a: Pick<PromotionFields, 'accountType' | 'farmHistory'>,
  b: Pick<PromotionFields, 'accountType' | 'farmHistory'>,
): boolean =>
  (a.accountType === 'ALL' || b.accountType === 'ALL' || a.accountType === b.accountType) &&
  (a.farmHistory === 'ALL' || b.farmHistory === 'ALL' || a.farmHistory === b.farmHistory);

/** [R6] Ids of live promotions that conflict with `p` (LINE_OFFER targets, AUTO_BONUS audience). */
export function overlapping(
  p: Pick<
    PromotionRecord,
    'id' | 'kind' | 'startAt' | 'endAt' | 'targets' | 'accountType' | 'farmHistory'
  >,
  others: readonly Pick<
    PromotionRecord,
    'id' | 'kind' | 'status' | 'startAt' | 'endAt' | 'targets' | 'accountType' | 'farmHistory'
  >[],
): string[] {
  const key = (t: { targetType: string; targetId: string }) => `${t.targetType}:${t.targetId}`;
  const mine = new Set(p.targets.map(key));
  return others
    .filter((o) => o.id !== p.id && o.kind === p.kind && windowsOverlap(p, o))
    .filter((o) => {
      if (p.kind === 'LINE_OFFER')
        // No targets = PLATFORM_WIDE: it overlaps every other line offer in the window.
        return (
          (o.status === 'ACTIVE' || o.status === 'PAUSED') &&
          (mine.size === 0 || o.targets.length === 0 || o.targets.some((t) => mine.has(key(t))))
        );
      if (p.kind === 'AUTO_BONUS') return o.status === 'ACTIVE' && audiencesOverlap(p, o);
      return false;
    })
    .map((o) => o.id);
}
