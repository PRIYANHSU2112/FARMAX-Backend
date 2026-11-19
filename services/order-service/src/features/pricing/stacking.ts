import { checkMinOrder } from './eligibility.js';
import { baseWeights, priceOrderPromo } from './coupon.js';
import type { LineAfterA } from './line-offers.js';
import { type Paise, sum } from './money.js';
import type { PromoDef } from './pricing.types.js';

/**
 * [R2] Stacking of the ONE manual coupon and the ONE auto bonus:
 * - both `isStackable` → both apply; the bonus is priced on the base left after the coupon
 *   (its minimum order is checked on the base before the coupon);
 * - otherwise the one that saves more applies (tie → the coupon, the buyer's own choice) and the
 *   other is reported as displaced.
 * Savings compare item discount + freight waived (`freeShipping`).
 */
export interface Priced {
  promo: PromoDef;
  discount: Paise;
  shares: Paise[];
}

export interface StackResult {
  coupon: Priced | null;
  bonus: Priced | null;
  displaced: { promo: PromoDef; saving: Paise; winner: PromoDef } | null;
}

/** Best auto bonus on its own: eligible base meets its minimum → highest saving wins. */
export function bestBonus(
  bonuses: readonly PromoDef[],
  lines: readonly LineAfterA[],
  freight: Paise,
): Priced | null {
  let best: { p: Priced; saving: Paise } | null = null;
  for (const promo of bonuses) {
    const weights = baseWeights(promo, lines);
    if (sum(weights) === 0 || !checkMinOrder(promo, sum(weights)).ok) continue;
    const p = { promo, ...priceOrderPromo(promo, weights) };
    const saving = savingOf(p, freight);
    if (
      best === null ||
      saving > best.saving ||
      (saving === best.saving &&
        (promo.priority > best.p.promo.priority ||
          (promo.priority === best.p.promo.priority && promo.id < best.p.promo.id)))
    )
      best = { p, saving };
  }
  return best?.p ?? null;
}

export function resolveStack(
  coupon: Priced | null,
  bonus: Priced | null,
  lines: readonly LineAfterA[],
  freight: Paise,
): StackResult {
  if (coupon === null || bonus === null) return { coupon, bonus, displaced: null };
  if (coupon.promo.isStackable && bonus.promo.isStackable) {
    const weights = baseWeights(bonus.promo, lines, coupon.shares);
    return {
      coupon,
      bonus: { promo: bonus.promo, ...priceOrderPromo(bonus.promo, weights) },
      displaced: null,
    };
  }
  const couponSaving = savingOf(coupon, freight);
  const bonusSaving = savingOf(bonus, freight);
  return couponSaving >= bonusSaving
    ? {
        coupon,
        bonus: null,
        displaced: { promo: bonus.promo, saving: bonusSaving, winner: coupon.promo },
      }
    : {
        coupon: null,
        bonus,
        displaced: { promo: coupon.promo, saving: couponSaving, winner: bonus.promo },
      };
}

const savingOf = (p: Priced, freight: Paise): Paise =>
  p.discount + (p.promo.freeShipping ? freight : 0);
