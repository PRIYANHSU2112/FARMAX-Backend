import { baseWeights, discountOn } from './coupon.js';
import { checkStatic, conditionsOf, formatRupees } from './eligibility.js';
import { type BundleInfo, applyLineOffers } from './line-offers.js';
import { type Paise, sum } from './money.js';
import type { PromoDef, ReasonCode } from './pricing.types.js';
import {
  type CouponStatus,
  type WaterfallInput,
  type WaterfallResult,
  priceCart,
} from './waterfall.js';

/**
 * "Offers for this order": prices the cart once per candidate coupon and ranks them.
 * applied = the asked-for code when it applies, else the coupon that saves the most
 * (tie → higher priority, then lower id). Savings are measured against the cart with no coupon,
 * so the auto bonus, freight and stacking rules are all included.
 */
export interface OfferCard {
  promotionId: string;
  code: string | null;
  title: string;
  subtitle: string | null;
  badgeText: string | null;
  endAt: Date;
  conditions: string[];
  freeShipping: boolean;
  saving: Paise;
}

export interface OffersResult {
  applied: (OfferCard & { message: string | null }) | null;
  /** What happened to the code the buyer asked for (null when none was asked). */
  requested: CouponStatus | null;
  autoBonus: OfferCard | null;
  alsoEligible: (OfferCard & { message: string })[];
  bundles: BundleInfo[];
  nudges: (Omit<OfferCard, 'saving'> & {
    amountToUnlock: Paise;
    progressPct: number;
    potentialSaving: Paise;
    message: string;
  })[];
  ineligible: {
    promotionId: string;
    code: string | null;
    title: string;
    reasonCode: ReasonCode | 'NOT_APPLICABLE';
    message: string;
  }[];
  /** Full waterfall of the cart with `applied` (or no coupon). */
  pricing: WaterfallResult;
}

export function evaluateOffers(input: WaterfallInput): OffersResult {
  const baseline = priceCart({ ...input, couponCode: null });
  const phaseA = applyLineOffers(
    input.lines,
    input.promotions.filter((p) => p.kind === 'LINE_OFFER' && checkStatic(p, input.buyer).ok),
    input.applyBundleIds,
  );
  const eligible: { card: OfferCard; result: WaterfallResult; promo: PromoDef }[] = [];
  const nudges: OffersResult['nudges'] = [];
  const ineligible: OffersResult['ineligible'] = [];

  const coupons = input.promotions
    .filter((p) => p.kind === 'ORDER_COUPON' && p.code !== null)
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
  for (const promo of coupons) {
    const code = promo.code ?? '';
    const elig = checkStatic(promo, input.buyer);
    if (!elig.ok) {
      ineligible.push({
        promotionId: promo.id,
        code,
        title: promo.title,
        reasonCode: elig.reasonCode,
        message: elig.message,
      });
      continue;
    }
    const result = priceCart({ ...input, couponCode: code });
    const status = result.couponStatus;
    if (status?.applied === true || status?.reasonCode === 'DISPLACED') {
      eligible.push({
        card: card(promo, result.invoice.totalSavings - baseline.invoice.totalSavings),
        result,
        promo,
      });
    } else if (status?.reasonCode === 'MIN_ORDER') {
      const base = sum(baseWeights(promo, phaseA.lines));
      const amountToUnlock = promo.minOrderAmount - base;
      nudges.push({
        ...card(promo, 0),
        amountToUnlock,
        progressPct: Math.min(99, Math.floor((base * 100) / Math.max(1, promo.minOrderAmount))),
        potentialSaving: discountOn(promo, promo.minOrderAmount),
        message: `Add ${formatRupees(amountToUnlock)} to unlock ${formatRupees(discountOn(promo, promo.minOrderAmount))} off`,
      });
    } else {
      ineligible.push({
        promotionId: promo.id,
        code,
        title: promo.title,
        reasonCode: 'NOT_APPLICABLE',
        message: status?.message ?? 'Not applicable to this cart.',
      });
    }
  }

  const requestedCode = input.couponCode;
  const asked = eligible.find(
    (e) => e.promo.code === requestedCode && e.result.couponStatus?.applied === true,
  );
  const ranked = eligible
    .filter((e) => e.result.couponStatus?.applied === true)
    .sort(
      (a, b) =>
        b.card.saving - a.card.saving ||
        b.promo.priority - a.promo.priority ||
        a.promo.id.localeCompare(b.promo.id),
    );
  const winner = asked ?? ranked[0] ?? null;
  const pricing = winner?.result ?? baseline;
  const requested =
    requestedCode === null
      ? null
      : (eligible.find((e) => e.promo.code === requestedCode)?.result.couponStatus ??
        priceCart({ ...input, couponCode: requestedCode }).couponStatus);

  const alsoEligible = eligible
    .filter((e) => e !== winner)
    .sort((a, b) => b.card.saving - a.card.saving)
    .map((e) => ({
      ...e.card,
      message:
        e.result.couponStatus?.reasonCode === 'DISPLACED'
          ? (e.result.couponStatus.message ?? '')
          : winner === null
            ? ''
            : e.card.saving > winner.card.saving
              ? `Saves ${formatRupees(e.card.saving - winner.card.saving)} more than ${winner.promo.code ?? ''}.`
              : `One coupon per order. ${winner.promo.code ?? ''} saves more, so it stays.`,
    }));

  const bonusApplied = pricing.applied.find((a) => a.kind === 'AUTO_BONUS');
  const bonusPromo = input.promotions.find((p) => p.id === bonusApplied?.promotionId);
  return {
    applied:
      winner === null
        ? null
        : { ...winner.card, message: winner.result.couponStatus?.message ?? null },
    requested,
    autoBonus: bonusPromo === undefined ? null : card(bonusPromo, bonusApplied?.discount ?? 0),
    alsoEligible,
    bundles: pricing.bundles,
    nudges: nudges.sort((a, b) => a.amountToUnlock - b.amountToUnlock),
    ineligible,
    pricing,
  };
}

const card = (promo: PromoDef, saving: Paise): OfferCard => ({
  promotionId: promo.id,
  code: promo.code,
  title: promo.title,
  subtitle: promo.subtitle,
  badgeText: promo.badgeText,
  endAt: promo.endAt,
  conditions: conditionsOf(promo),
  freeShipping: promo.freeShipping,
  saving,
});
