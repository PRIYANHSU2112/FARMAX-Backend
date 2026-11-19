import { baseWeights, priceOrderPromo } from './coupon.js';
import { checkMinOrder, checkStatic, formatRupees } from './eligibility.js';
import { gstFor, groupByHsn } from './gst.js';
import { type BundleInfo, applyLineOffers } from './line-offers.js';
import { type Paise, sum } from './money.js';
import type {
  AppliedPromotion,
  BuyerContext,
  Invoice,
  PricedLine,
  PricingConfig,
  PricingLine,
  PromoDef,
  ReasonCode,
} from './pricing.types.js';
import { bestFreightBenefit, freightFor } from './shipping.js';
import { type Priced, bestBonus, resolveStack } from './stacking.js';

/**
 * The price waterfall, strict order:
 *   0 base price → A line offers → B one manual coupon → B2 one auto bonus → C freight → D GST.
 * Pure: same input, same output; every amount is integer paise.
 */
export interface WaterfallInput {
  lines: readonly PricingLine[];
  /** Live promotions (any kind); eligibility is checked here. */
  promotions: readonly PromoDef[];
  buyer: BuyerContext;
  config: PricingConfig;
  /** Normalised (trim + UPPERCASE) or null. */
  couponCode: string | null;
  applyBundleIds: readonly string[];
}

export interface CouponStatus {
  code: string;
  applied: boolean;
  promotionId: string | null;
  reasonCode: ReasonCode | 'NOT_FOUND' | 'NOT_APPLICABLE' | 'DISPLACED' | null;
  message: string | null;
}

export interface WaterfallResult {
  lines: PricedLine[];
  invoice: Invoice;
  applied: AppliedPromotion[];
  bundles: BundleInfo[];
  couponStatus: CouponStatus | null;
}

export function priceCart(input: WaterfallInput): WaterfallResult {
  const { buyer, config } = input;
  const live = input.promotions.filter((p) => checkStatic(p, buyer).ok);
  const ofKind = (kind: PromoDef['kind']) => live.filter((p) => p.kind === kind);

  // ── A ──
  const phaseA = applyLineOffers(input.lines, ofKind('LINE_OFFER'), input.applyBundleIds);
  const linesA = phaseA.lines;
  const freight = freightFor(linesA, config);

  // ── B: the manual coupon ──
  let couponStatus: CouponStatus | null = null;
  let coupon: Priced | null = null;
  if (input.couponCode !== null) {
    const result = resolveCoupon(input.couponCode, input.promotions, buyer, linesA);
    couponStatus = result.status;
    coupon = result.priced;
  }

  // ── B2: one auto bonus, stacked or competing [R2] ──
  const bonus = bestBonus(
    ofKind('AUTO_BONUS').filter((p) => p.isAutoApply),
    linesA,
    freight,
  );
  const stack = resolveStack(coupon, bonus, linesA, freight);
  if (stack.displaced !== null && couponStatus !== null && stack.coupon === null) {
    couponStatus = {
      ...couponStatus,
      applied: false,
      reasonCode: 'DISPLACED',
      message: `${stack.displaced.winner.title} saves more and cannot be combined; only one applies.`,
    };
  }
  const couponShares = stack.coupon?.shares ?? linesA.map(() => 0);
  const bonusShares = stack.bonus?.shares ?? linesA.map(() => 0);

  // ── C: freight ──
  const carriers = [stack.coupon?.promo, stack.bonus?.promo].filter(
    (p): p is PromoDef => p !== undefined,
  );
  const freightBenefit = bestFreightBenefit(freight, linesA, ofKind('SHIPPING'), carriers);

  // ── D: GST ──
  const interState = buyer.stateCode !== null && buyer.stateCode !== config.sellerStateCode;
  const lines: PricedLine[] = linesA.map((l, i) => {
    const lineOfferDiscount = l.bundleDiscount + l.offerDiscount;
    const couponDiscount = couponShares[i] ?? 0;
    const autoBonusDiscount = bonusShares[i] ?? 0;
    const taxableValue = Math.max(
      0,
      l.lineGross - lineOfferDiscount - couponDiscount - autoBonusDiscount,
    );
    const tax = gstFor(taxableValue, l.line.gstRate, interState);
    const allocations = [
      ...l.perPromo,
      ...(stack.coupon !== null && couponDiscount > 0
        ? [{ promotionId: stack.coupon.promo.id, amount: couponDiscount }]
        : []),
      ...(stack.bonus !== null && autoBonusDiscount > 0
        ? [{ promotionId: stack.bonus.promo.id, amount: autoBonusDiscount }]
        : []),
    ];
    return {
      variantId: l.line.variantId,
      sku: l.line.sku,
      name: l.line.name,
      qty: l.line.qty,
      unitPrice: l.line.unitPrice,
      priceSource: l.line.priceSource,
      lineGross: l.lineGross,
      lineOfferDiscount,
      lineOfferPromotionIds: l.promotionIds,
      pairedQty: l.pairedQty,
      couponDiscount,
      autoBonusDiscount,
      taxableValue,
      hsnCode: l.line.hsnCode,
      gstRate: l.line.gstRate,
      ...tax,
      lineTotal: taxableValue + tax.cgst + tax.sgst + tax.igst,
      allocations,
    };
  });
  const freightTaxable = freight - freightBenefit.discount;
  const freightTax = gstFor(freightTaxable, config.freightGstRate, interState);
  const gstRows = [
    ...lines.map((l) => ({
      hsnCode: l.hsnCode,
      rate: l.gstRate,
      taxable: l.taxableValue,
      cgst: l.cgst,
      sgst: l.sgst,
      igst: l.igst,
    })),
    ...(freight > 0
      ? [
          {
            hsnCode: config.freightSacCode,
            rate: config.freightGstRate,
            taxable: freightTaxable,
            ...freightTax,
          },
        ]
      : []),
  ];
  const gstByHsn = groupByHsn(gstRows);
  const cgst = sum(gstByHsn.map((g) => g.cgst));
  const sgst = sum(gstByHsn.map((g) => g.sgst));
  const igst = sum(gstByHsn.map((g) => g.igst));
  const freightGst = freightTax.cgst + freightTax.sgst + freightTax.igst;
  const lineOfferDiscount = sum(lines.map((l) => l.lineOfferDiscount));
  const couponDiscount = sum(lines.map((l) => l.couponDiscount));
  const autoBonusDiscount = sum(lines.map((l) => l.autoBonusDiscount));
  const taxableAmount = sum(lines.map((l) => l.taxableValue));
  const invoice: Invoice = {
    itemSubtotal: sum(lines.map((l) => l.lineGross)),
    lineOfferDiscount,
    couponDiscount,
    autoBonusDiscount,
    taxableAmount,
    freight,
    freightDiscount: freightBenefit.discount,
    freightTaxable,
    freightGst,
    gstByHsn,
    cgst,
    sgst,
    igst,
    gstTotal: cgst + sgst + igst,
    interState,
    totalSavings: lineOfferDiscount + couponDiscount + autoBonusDiscount + freightBenefit.discount,
    finalPayable: taxableAmount + freightTaxable + cgst + sgst + igst,
  };

  const applied: AppliedPromotion[] = [
    ...phaseA.applied.map(({ promo, discount }) => toApplied(promo, discount)),
    ...(stack.coupon === null ? [] : [toApplied(stack.coupon.promo, stack.coupon.discount)]),
    ...(stack.bonus === null ? [] : [toApplied(stack.bonus.promo, stack.bonus.discount)]),
  ];
  if (freightBenefit.promotionId !== null) {
    const owner = applied.find((a) => a.promotionId === freightBenefit.promotionId);
    const promo = input.promotions.find((p) => p.id === freightBenefit.promotionId);
    if (owner !== undefined) owner.discount += freightBenefit.discount;
    else if (promo !== undefined) applied.push(toApplied(promo, freightBenefit.discount));
  }
  return { lines, invoice, applied, bundles: phaseA.bundles, couponStatus };
}

function resolveCoupon(
  code: string,
  promotions: readonly PromoDef[],
  buyer: BuyerContext,
  lines: Parameters<typeof baseWeights>[1],
): { status: CouponStatus; priced: Priced | null } {
  const promo = promotions.find((p) => p.kind === 'ORDER_COUPON' && p.code === code);
  const status = (s: Partial<CouponStatus>): CouponStatus => ({
    code,
    applied: false,
    promotionId: promo?.id ?? null,
    reasonCode: null,
    message: null,
    ...s,
  });
  if (promo === undefined)
    return {
      status: status({ reasonCode: 'NOT_FOUND', message: 'This code is not valid.' }),
      priced: null,
    };
  const elig = checkStatic(promo, buyer);
  if (!elig.ok)
    return { status: status({ reasonCode: elig.reasonCode, message: elig.message }), priced: null };
  const weights = baseWeights(promo, lines);
  if (sum(weights) === 0)
    return {
      status: status({
        reasonCode: 'NOT_APPLICABLE',
        message: 'No item in your cart is eligible for this code.',
      }),
      priced: null,
    };
  const min = checkMinOrder(promo, sum(weights));
  if (!min.ok)
    return { status: status({ reasonCode: min.reasonCode, message: min.message }), priced: null };
  const priced = { promo, ...priceOrderPromo(promo, weights) };
  if (priced.discount === 0 && !promo.freeShipping)
    return {
      status: status({
        reasonCode: 'NOT_APPLICABLE',
        message: 'This code gives no saving on this cart.',
      }),
      priced: null,
    };
  return {
    status: status({
      applied: true,
      message:
        priced.discount > 0
          ? `You save ${formatRupees(priced.discount)} with ${code}.`
          : `Free shipping with ${code}.`,
    }),
    priced,
  };
}

const toApplied = (promo: PromoDef, discount: Paise): AppliedPromotion => ({
  promotionId: promo.id,
  code: promo.code,
  title: promo.title,
  kind: promo.kind,
  discount,
});
