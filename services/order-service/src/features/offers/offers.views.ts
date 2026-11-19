import {
  type CouponStatus,
  type OffersResult,
  type WaterfallResult,
  fromBasisPoints,
  fromPaise,
} from '../pricing/index.js';
import type { FarmFacts } from '../projections/index.js';
import type { OfferCardView } from './offers.types.js';

/** Engine results (paise / bp) → API views (decimal strings). */

type Card = NonNullable<OffersResult['applied']>;

const cardView = (c: Omit<Card, 'message'>): OfferCardView => ({
  promotionId: c.promotionId,
  code: c.code,
  title: c.title,
  subtitle: c.subtitle,
  badgeText: c.badgeText,
  validUntil: c.endAt.toISOString(),
  conditions: c.conditions,
  freeShipping: c.freeShipping,
  saving: fromPaise(c.saving),
});

const couponView = (s: CouponStatus | null) => s;

export function offersView(r: OffersResult) {
  const inv = r.pricing.invoice;
  return {
    applied: r.applied === null ? null : { ...cardView(r.applied), message: r.applied.message },
    requested: couponView(r.requested),
    autoBonus: r.autoBonus === null ? null : cardView(r.autoBonus),
    alsoEligible: r.alsoEligible.map((c) => ({ ...cardView(c), message: c.message })),
    bundles: r.bundles.map((b) => ({
      promotionId: b.promotionId,
      title: b.title,
      subtitle: b.subtitle,
      bundlePrice: fromPaise(b.bundlePrice),
      savingPerSet: fromPaise(b.savingPerSet),
      sets: b.sets,
      applied: b.applied,
    })),
    nudges: r.nudges.map((n) => ({
      promotionId: n.promotionId,
      code: n.code,
      title: n.title,
      amountToUnlock: fromPaise(n.amountToUnlock),
      progressPct: n.progressPct,
      potentialSaving: fromPaise(n.potentialSaving),
      message: n.message,
    })),
    ineligible: r.ineligible,
    summary: {
      itemSubtotal: fromPaise(inv.itemSubtotal),
      totalSavings: fromPaise(inv.totalSavings),
      finalPayable: fromPaise(inv.finalPayable),
    },
  };
}

export function previewView(
  r: WaterfallResult,
  farm: FarmFacts,
  billToGst: boolean,
  sellerStateCode: string,
) {
  const inv = r.invoice;
  const gstBilled = billToGst && farm.gstin !== null;
  return {
    billing: {
      farmId: farm.farmId,
      farmCode: farm.farmCode,
      name: farm.name,
      gstin: gstBilled ? farm.gstin : null,
      itcEligible: gstBilled,
      placeOfSupply: farm.stateCode,
      sellerStateCode,
    },
    lines: r.lines.map((l) => ({
      variantId: l.variantId,
      sku: l.sku,
      name: l.name,
      qty: l.qty,
      unitPrice: fromPaise(l.unitPrice),
      priceSource: l.priceSource,
      lineGross: fromPaise(l.lineGross),
      lineOfferDiscount: fromPaise(l.lineOfferDiscount),
      lineOfferPromotionIds: l.lineOfferPromotionIds,
      pairedQty: l.pairedQty,
      couponDiscount: fromPaise(l.couponDiscount),
      autoBonusDiscount: fromPaise(l.autoBonusDiscount),
      taxableValue: fromPaise(l.taxableValue),
      hsnCode: l.hsnCode,
      gstRate: fromBasisPoints(l.gstRate),
      cgst: fromPaise(l.cgst),
      sgst: fromPaise(l.sgst),
      igst: fromPaise(l.igst),
      lineTotal: fromPaise(l.lineTotal),
    })),
    invoice: {
      itemSubtotal: fromPaise(inv.itemSubtotal),
      lineOfferDiscount: fromPaise(inv.lineOfferDiscount),
      couponDiscount: fromPaise(inv.couponDiscount),
      autoBonusDiscount: fromPaise(inv.autoBonusDiscount),
      taxableAmount: fromPaise(inv.taxableAmount),
      freight: fromPaise(inv.freight),
      freightDiscount: fromPaise(inv.freightDiscount),
      freightGst: fromPaise(inv.freightGst),
      gstByHsn: inv.gstByHsn.map((g) => ({
        hsnCode: g.hsnCode,
        rate: fromBasisPoints(g.rate),
        taxable: fromPaise(g.taxable),
        cgst: fromPaise(g.cgst),
        sgst: fromPaise(g.sgst),
        igst: fromPaise(g.igst),
      })),
      cgst: fromPaise(inv.cgst),
      sgst: fromPaise(inv.sgst),
      igst: fromPaise(inv.igst),
      gstTotal: fromPaise(inv.gstTotal),
      interState: inv.interState,
      totalSavings: fromPaise(inv.totalSavings),
      finalPayable: fromPaise(inv.finalPayable),
      saved: fromPaise(inv.totalSavings),
    },
    appliedPromotions: r.applied.map((a) => ({ ...a, discount: fromPaise(a.discount) })),
    couponStatus: r.couponStatus,
    bundles: r.bundles.map((b) => ({
      promotionId: b.promotionId,
      title: b.title,
      bundlePrice: fromPaise(b.bundlePrice),
      savingPerSet: fromPaise(b.savingPerSet),
      sets: b.sets,
      applied: b.applied,
    })),
  };
}
