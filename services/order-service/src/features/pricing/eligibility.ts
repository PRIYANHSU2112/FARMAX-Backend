import { type Paise, fromPaise } from './money.js';
import type {
  BuyerContext,
  Eligibility,
  PricingLine,
  PromoDef,
  PromoRuleType,
  PromoTarget,
} from './pricing.types.js';

/** Does this promotion's scope cover the line? [R8] ancestors only when categoryPath is known. */
export function inScope(promo: Pick<PromoDef, 'scope' | 'targets'>, line: PricingLine): boolean {
  if (promo.scope === 'PLATFORM_WIDE') return true;
  return promo.targets.some((t) => targetMatches(t, line));
}

export function targetMatches(target: PromoTarget, line: PricingLine): boolean {
  switch (target.targetType) {
    case 'VARIANT':
      return line.variantId === target.targetId;
    case 'PRODUCT':
      return line.productId === target.targetId;
    case 'BRAND':
      return line.brandId === target.targetId;
    case 'CATEGORY':
      return line.categoryPath.length > 0
        ? line.categoryPath.includes(target.targetId)
        : line.categoryId === target.targetId;
  }
}

const valuesOf = (promo: PromoDef, type: PromoRuleType): string[] =>
  promo.rules.filter((r) => r.ruleType === type).map((r) => r.value);

const fail = (reasonCode: Exclude<Eligibility, { ok: true }>['reasonCode'], message: string) =>
  ({ ok: false, reasonCode, message }) as const;

/**
 * Every rule that does NOT depend on the cart value, in a fixed order (first failure wins).
 * Limits read configured limits vs `usedCount` and non-reversed redemptions [R7].
 */
export function checkStatic(promo: PromoDef, buyer: BuyerContext): Eligibility {
  const now = buyer.now.getTime();
  if (promo.status !== 'ACTIVE') return fail('INACTIVE', 'This offer is not active.');
  if (now < promo.startAt.getTime()) return fail('NOT_STARTED', 'This offer has not started yet.');
  if (now >= promo.endAt.getTime()) return fail('EXPIRED', 'This offer has expired.');
  if (promo.totalUsageLimit !== null && promo.usedCount >= promo.totalUsageLimit)
    return fail('USAGE_EXHAUSTED', 'This offer is fully redeemed.');
  const used = buyer.usage.get(promo.id) ?? { farm: 0, user: 0 };
  if (promo.perFarmLimit !== null && used.farm >= promo.perFarmLimit)
    return fail(
      'FARM_LIMIT',
      `Already used on this farm (${usesText(promo.perFarmLimit)} per farm).`,
    );
  if (promo.perUserLimit !== null && used.user >= promo.perUserLimit)
    return fail('USER_LIMIT', 'You have already used this offer.');

  if (promo.accountType === 'RETAIL' && buyer.gstin !== null)
    return fail('ACCOUNT_TYPE', 'Retail accounts only. This B2B farm account is not eligible.');
  if (promo.accountType === 'B2B_GST' && buyer.gstin === null)
    return fail('ACCOUNT_TYPE', 'GST-registered farms only. Add your GSTIN to use this offer.');

  const types = valuesOf(promo, 'PRODUCTION_TYPE');
  if (types.length > 0 && !buyer.productionTypes.some((t) => types.includes(t)))
    return fail('PRODUCTION_TYPE', `For ${listText(types)} farms only.`);
  const categories = valuesOf(promo, 'FARM_CATEGORY');
  if (categories.length > 0 && !categories.includes(buyer.farmCategory))
    return fail('FARM_CATEGORY', `For ${listText(categories)} accounts only.`);

  if (promo.farmHistory === 'NEW_FARM' && buyer.farmOrderCount > 0)
    return fail('FARM_HISTORY', "Valid on a farm's first order only.");
  if (promo.farmHistory === 'EXISTING_FARM' && buyer.farmOrderCount === 0)
    return fail('FARM_HISTORY', 'Valid for farms that have ordered before.');

  const regionRules: [PromoRuleType, string | null][] = [
    ['STATE', buyer.stateCode],
    ['TERRITORY', buyer.territoryCode],
    ['PINCODE', buyer.pinCode],
  ];
  for (const [type, value] of regionRules) {
    const allowed = valuesOf(promo, type);
    if (allowed.length > 0 && (value === null || !allowed.includes(value)))
      return fail('REGION', 'Not available for your farm location.');
  }

  if (promo.paymentMethod !== 'ANY' && buyer.paymentMethod !== promo.paymentMethod)
    return fail('PAYMENT_METHOD', `Pay by ${paymentText(promo.paymentMethod)} to use this offer.`);
  const banks = valuesOf(promo, 'BANK');
  if (banks.length > 0 && (buyer.bankCode === null || !banks.includes(buyer.bankCode)))
    return fail('PAYMENT_METHOD', 'Valid on selected bank payments only.');
  const bins = valuesOf(promo, 'CARD_BIN');
  if (
    bins.length > 0 &&
    (buyer.cardBin === null || !bins.some((b) => buyer.cardBin?.startsWith(b)))
  )
    return fail('PAYMENT_METHOD', 'Valid on selected cards only.');

  if (promo.isMemberOnly && !buyer.isMember) return fail('MEMBER_ONLY', 'FarmX members only.');
  return { ok: true };
}

/** MIN_ORDER on the eligible base. Failing only this → a nudge with the amount to add. */
export function checkMinOrder(promo: PromoDef, eligibleBase: Paise): Eligibility {
  if (eligibleBase >= promo.minOrderAmount) return { ok: true };
  const amountToUnlock = promo.minOrderAmount - eligibleBase;
  const what = promo.scope === 'PLATFORM_WIDE' ? '' : ' of eligible items';
  return {
    ok: false,
    reasonCode: 'MIN_ORDER',
    message: `Add ${formatRupees(amountToUnlock)} more${what} to unlock.`,
    amountToUnlock,
  };
}

/** Short conditions for the coupon card: "1 use per farm", "Layer & broiler farms", … */
export function conditionsOf(promo: PromoDef): string[] {
  const out: string[] = [];
  if (promo.perFarmLimit !== null) out.push(`${usesText(promo.perFarmLimit)} per farm`);
  if (promo.perUserLimit !== null) out.push(`${usesText(promo.perUserLimit)} per user`);
  const types = valuesOf(promo, 'PRODUCTION_TYPE');
  if (types.length > 0) out.push(capitalise(`${listText(types)} farms`));
  if (promo.minOrderAmount > 0)
    out.push(`Min. eligible order ${formatRupees(promo.minOrderAmount)}`);
  if (promo.paymentMethod !== 'ANY') out.push(`${paymentText(promo.paymentMethod)} only`);
  if (promo.accountType === 'B2B_GST') out.push('GST-registered farms');
  if (promo.accountType === 'RETAIL') out.push('Retail accounts');
  if (promo.farmHistory === 'NEW_FARM') out.push('First order only');
  if (promo.isMemberOnly) out.push('FarmX members');
  return out;
}

/** 217900 → "₹2,179"; 12345 → "₹123.45" (Indian digit grouping). */
export function formatRupees(paise: Paise): string {
  const [whole = '0', fraction = '00'] = fromPaise(paise).split('.');
  const last3 = whole.slice(-3);
  const rest = whole.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = rest === '' ? last3 : `${rest},${last3}`;
  return fraction === '00' ? `₹${grouped}` : `₹${grouped}.${fraction}`;
}

const usesText = (n: number) => (n === 1 ? '1 use' : `${String(n)} uses`);
const paymentText = (m: string) => (m === 'NETBANKING' ? 'net banking' : m === 'CARD' ? 'card' : m);
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const listText = (values: string[]): string => {
  const words = values.map((v) => v.toLowerCase().replaceAll('_', ' '));
  return words.length <= 1
    ? (words[0] ?? '')
    : `${words.slice(0, -1).join(', ')} & ${words.at(-1) ?? ''}`;
};
