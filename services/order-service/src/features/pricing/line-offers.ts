import { checkMinOrder, inScope, targetMatches } from './eligibility.js';
import { type Paise, allocate, percentOf, sum } from './money.js';
import type { PricingLine, PromoDef } from './pricing.types.js';

/**
 * Phase A — line offers. One offer per unit:
 *   1. BUNDLE_PAIR (opt-in via applyBundleIds): the set price REPLACES the unit price of the
 *      paired units; those units are never in a coupon / bonus base.
 *   2. Remaining units: the line takes ONE offer — highest tier (COMBO > PERCENTAGE > FLAT), then
 *      highest saving on that line, then higher priority, then lower id. COMBO frees the cheapest
 *      units of its pool. LINE_OFFER FLAT is per unit (clamped to the unit price).
 */

export interface LineAfterA {
  line: PricingLine;
  lineGross: Paise;
  pairedQty: number;
  /** Value of the paired units after the bundle price. */
  pairedAfterA: Paise;
  bundleDiscount: Paise;
  offerDiscount: Paise;
  /** Non-paired units after their line offer. */
  restAfterA: Paise;
  /** False when the line offer on the non-paired units is not stackable. */
  restStackable: boolean;
  promotionIds: string[];
  /** Exact discount of each line offer on this line (Σ = bundleDiscount + offerDiscount). */
  perPromo: { promotionId: string; amount: Paise }[];
}

export interface BundleInfo {
  promotionId: string;
  title: string;
  subtitle: string | null;
  bundlePrice: Paise;
  /** Saving of one set vs the current unit prices ("Saves ₹29 a pair"). */
  savingPerSet: Paise;
  /** Sets the cart can form (applied: sets actually applied). */
  sets: number;
  applied: boolean;
}

export interface PhaseAResult {
  lines: LineAfterA[];
  bundles: BundleInfo[];
  /** Line offers that actually gave a discount, with the total. */
  applied: { promo: PromoDef; discount: Paise }[];
}

const TIER: Record<string, number> = { COMBO: 3, PERCENTAGE: 2, FLAT: 1 };

export function applyLineOffers(
  lines: readonly PricingLine[],
  offers: readonly PromoDef[],
  applyBundleIds: readonly string[],
): PhaseAResult {
  const remaining = lines.map((l) => l.qty);
  const pairedQty = lines.map(() => 0);
  const pairedGross = lines.map(() => 0);
  const bundleDiscount = lines.map(() => 0);
  const promoIds = lines.map(() => new Set<string>());
  const perPromo = lines.map(() => new Map<string, Paise>());
  const addShare = (i: number, id: string, amount: Paise) => {
    if (amount <= 0) return;
    const m = perPromo[i];
    m?.set(id, (m.get(id) ?? 0) + amount);
  };
  const applied = new Map<string, { promo: PromoDef; discount: Paise }>();
  const bundles: BundleInfo[] = [];

  // ── 1. Bundles (opt-in, in the order asked) ──
  const bundleOffers = offers.filter((o) => o.benefitType === 'BUNDLE_PAIR');
  for (const id of applyBundleIds) {
    const promo = bundleOffers.find((o) => o.id === id);
    if (promo === undefined) continue;
    const take = formSets(promo, lines, remaining);
    if (take === null) continue;
    const consumedValue = take.units.map((u, i) => u * (lines[i]?.unitPrice ?? 0));
    const discount = sum(consumedValue) - take.sets * (promo.bundlePrice ?? 0);
    if (discount <= 0) continue; // the set price is not cheaper: leave the units alone
    const shares = allocate(discount, consumedValue);
    take.units.forEach((u, i) => {
      if (u === 0) return;
      remaining[i] = (remaining[i] ?? 0) - u;
      pairedQty[i] = (pairedQty[i] ?? 0) + u;
      pairedGross[i] = (pairedGross[i] ?? 0) + (consumedValue[i] ?? 0);
      bundleDiscount[i] = (bundleDiscount[i] ?? 0) + (shares[i] ?? 0);
      promoIds[i]?.add(promo.id);
      addShare(i, promo.id, shares[i] ?? 0);
    });
    applied.set(promo.id, { promo, discount });
    bundles.push(bundleInfo(promo, lines, take.sets, true));
  }
  // Bundles the cart could still form (shown as "Apply pair").
  for (const promo of bundleOffers) {
    if (applied.has(promo.id)) continue;
    const take = formSets(promo, lines, remaining);
    if (take !== null) {
      const info = bundleInfo(promo, lines, take.sets, false);
      if (info.savingPerSet > 0) bundles.push(info);
    }
  }

  // ── 2. One line offer per line on the remaining units ──
  const others = offers.filter((o) => o.benefitType !== 'BUNDLE_PAIR' && TIER[o.benefitType]);
  const restGross = lines.map((l, i) => (remaining[i] ?? 0) * l.unitPrice);
  // Offers whose pool (all matching remaining units) meets their minimum order.
  const usable = others.filter((o) => {
    const pool = sum(lines.map((l, i) => (inScope(o, l) ? (restGross[i] ?? 0) : 0)));
    return pool > 0 && checkMinOrder(o, pool).ok;
  });
  let candidates = lines.map((l, i) =>
    (remaining[i] ?? 0) > 0 ? usable.filter((o) => inScope(o, l)) : [],
  );
  let offerDiscount = lines.map(() => 0);
  let chosen: (PromoDef | null)[] = lines.map(() => null);
  // Re-pick until no chosen offer yields zero (e.g. a COMBO without enough units).
  for (let round = 0; round <= others.length; round += 1) {
    chosen = candidates.map((list, i) => pickBest(list, lines[i], remaining[i] ?? 0));
    offerDiscount = lines.map(() => 0);
    const dead = new Set<string>();
    for (const promo of new Set(chosen.filter((c): c is PromoDef => c !== null))) {
      const idx = chosen.flatMap((c, i) => (c?.id === promo.id ? [i] : []));
      const shares = poolDiscount(
        promo,
        idx.map((i) => ({ line: lines[i], qty: remaining[i] ?? 0 })),
      );
      if (sum(shares) === 0) dead.add(promo.id);
      idx.forEach((lineIdx, k) => {
        offerDiscount[lineIdx] = shares[k] ?? 0;
      });
    }
    if (dead.size === 0) break;
    candidates = candidates.map((list) => list.filter((o) => !dead.has(o.id)));
  }
  chosen.forEach((promo, i) => {
    if (promo === null || (offerDiscount[i] ?? 0) === 0) return;
    promoIds[i]?.add(promo.id);
    addShare(i, promo.id, offerDiscount[i] ?? 0);
    const entry = applied.get(promo.id) ?? { promo, discount: 0 };
    entry.discount += offerDiscount[i] ?? 0;
    applied.set(promo.id, entry);
  });

  return {
    lines: lines.map((line, i) => {
      const gross = line.qty * line.unitPrice;
      const pAfter = (pairedGross[i] ?? 0) - (bundleDiscount[i] ?? 0);
      const rest = (restGross[i] ?? 0) - (offerDiscount[i] ?? 0);
      return {
        line,
        lineGross: gross,
        pairedQty: pairedQty[i] ?? 0,
        pairedAfterA: pAfter,
        bundleDiscount: bundleDiscount[i] ?? 0,
        offerDiscount: offerDiscount[i] ?? 0,
        restAfterA: rest,
        restStackable: (offerDiscount[i] ?? 0) === 0 || (chosen[i]?.isStackable ?? true),
        promotionIds: [...(promoIds[i] ?? [])],
        perPromo: [...(perPromo[i] ?? new Map<string, Paise>())].map(([promotionId, amount]) => ({
          promotionId,
          amount,
        })),
      };
    }),
    bundles,
    applied: [...applied.values()],
  };
}

/** Units per line a bundle consumes for the max number of full sets (most expensive first). */
function formSets(
  promo: PromoDef,
  lines: readonly PricingLine[],
  remaining: readonly number[],
): { sets: number; units: number[] } | null {
  const components = promo.targets.filter((t) => (t.bundleQty ?? 0) > 0);
  if (components.length < 2 || promo.bundlePrice === null) return null;
  const avail = [...remaining];
  const pools = components.map((c) =>
    lines
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => targetMatches(c, l))
      .sort((a, b) => b.l.unitPrice - a.l.unitPrice || a.i - b.i),
  );
  // Sets limited by each component's pool (a line used by one component is not reused).
  let sets = Infinity;
  components.forEach((c, k) => {
    const units = sum((pools[k] ?? []).map(({ i }) => avail[i] ?? 0));
    sets = Math.min(sets, Math.floor(units / (c.bundleQty ?? 1)));
  });
  if (!Number.isFinite(sets) || sets < 1) return null;
  const units = lines.map(() => 0);
  components.forEach((c, k) => {
    let need = sets * (c.bundleQty ?? 1);
    for (const { i } of pools[k] ?? []) {
      const take = Math.min(need, avail[i] ?? 0);
      units[i] = (units[i] ?? 0) + take;
      avail[i] = (avail[i] ?? 0) - take;
      need -= take;
      if (need === 0) break;
    }
    if (need > 0) sets = 0;
  });
  return sets < 1 ? null : { sets, units };
}

function bundleInfo(
  promo: PromoDef,
  lines: readonly PricingLine[],
  sets: number,
  applied: boolean,
): BundleInfo {
  const setValue = sum(
    promo.targets
      .filter((t) => (t.bundleQty ?? 0) > 0)
      .map((t) => {
        const price = Math.max(
          0,
          ...lines.filter((l) => targetMatches(t, l)).map((l) => l.unitPrice),
        );
        return price * (t.bundleQty ?? 1);
      }),
  );
  return {
    promotionId: promo.id,
    title: promo.title,
    subtitle: promo.subtitle,
    bundlePrice: promo.bundlePrice ?? 0,
    savingPerSet: setValue - (promo.bundlePrice ?? 0),
    sets,
    applied,
  };
}

function pickBest(
  list: readonly PromoDef[],
  line: PricingLine | undefined,
  qty: number,
): PromoDef | null {
  if (line === undefined || list.length === 0 || qty === 0) return null;
  let best: { promo: PromoDef; key: number[] } | null = null;
  for (const promo of list) {
    const saving = sum(poolDiscount(promo, [{ line, qty }]));
    const key = [TIER[promo.benefitType] ?? 0, saving, promo.priority];
    if (
      best === null ||
      compareKeys(key, best.key) > 0 ||
      (compareKeys(key, best.key) === 0 && promo.id < best.promo.id)
    )
      best = { promo, key };
  }
  return best?.promo ?? null;
}

const compareKeys = (a: number[], b: number[]): number => {
  for (let i = 0; i < a.length; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
};

/** Discount of one line offer over its pool, per pool entry. */
function poolDiscount(
  promo: PromoDef,
  pool: readonly { line: PricingLine | undefined; qty: number }[],
): Paise[] {
  const values = pool.map((p) => (p.line?.unitPrice ?? 0) * p.qty);
  switch (promo.benefitType) {
    case 'PERCENTAGE': {
      const raw = values.map((v) => percentOf(v, promo.percentage ?? 0));
      const cap = promo.maxDiscountAmount;
      return cap !== null && sum(raw) > cap ? allocate(cap, values) : raw;
    }
    case 'FLAT': {
      const flat = promo.flatAmount ?? 0;
      return pool.map((p) => Math.min(flat, p.line?.unitPrice ?? 0) * p.qty);
    }
    case 'COMBO': {
      const buy = promo.comboBuyQty ?? 0;
      const get = promo.comboGetQty ?? 0;
      if (buy < 1 || get < 1) return pool.map(() => 0);
      const units = pool.flatMap((p, k) =>
        Array.from({ length: p.qty }, () => ({ k, price: p.line?.unitPrice ?? 0 })),
      );
      const free = Math.floor(units.length / (buy + get)) * get;
      const out = pool.map(() => 0);
      units
        .sort((a, b) => a.price - b.price || a.k - b.k)
        .slice(0, free)
        .forEach((u) => {
          out[u.k] = (out[u.k] ?? 0) + percentOf(u.price, promo.comboGetPercent ?? 10_000);
        });
      return out;
    }
    default:
      return pool.map(() => 0);
  }
}
