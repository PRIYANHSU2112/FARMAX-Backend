import { inScope } from './eligibility.js';
import type { LineAfterA } from './line-offers.js';
import { type Paise, sum } from './money.js';
import type { PricingConfig, PromoDef } from './pricing.types.js';

const COLD_CHAIN = new Set(['CC_REF', 'CC_FRZ']);

/** 2–8 °C or frozen: shipped in a separate cold-chain consignment. */
export const isColdChain = (temperatureClass: string): boolean => COLD_CHAIN.has(temperatureClass);

/** Freight for the cart: cold-chain freight & packaging when any line needs 2–8 °C / frozen. */
export function freightFor(lines: readonly LineAfterA[], config: PricingConfig): Paise {
  if (lines.length === 0) return 0;
  return lines.some((l) => isColdChain(l.line.temperatureClass))
    ? config.coldChainFreight
    : config.standardFreight;
}

export interface FreightBenefit {
  discount: Paise;
  /** The promotion that gave it (SHIPPING promo, or the coupon / bonus with freeShipping). */
  promotionId: string | null;
}

/**
 * Phase C — at most ONE freight benefit, the largest: a coupon / bonus carrying `freeShipping`,
 * or an eligible SHIPPING promo (FREE_SHIPPING = whole freight, FLAT = up to the freight).
 * Never touches item taxable values.
 */
export function bestFreightBenefit(
  freight: Paise,
  lines: readonly LineAfterA[],
  shippingPromos: readonly PromoDef[],
  carriers: readonly PromoDef[],
): FreightBenefit {
  let best: FreightBenefit = { discount: 0, promotionId: null };
  if (freight === 0) return best;
  for (const promo of carriers) {
    if (promo.freeShipping && freight > best.discount)
      best = { discount: freight, promotionId: promo.id };
  }
  for (const promo of shippingPromos) {
    const base = sum(
      lines.map((l) => (inScope(promo, l.line) ? l.pairedAfterA + l.restAfterA : 0)),
    );
    if (base === 0 || base < promo.minOrderAmount) continue;
    const discount =
      promo.benefitType === 'FREE_SHIPPING'
        ? freight
        : promo.benefitType === 'FLAT'
          ? Math.min(freight, promo.flatAmount ?? 0)
          : 0;
    if (discount > best.discount) best = { discount, promotionId: promo.id };
  }
  return best;
}
