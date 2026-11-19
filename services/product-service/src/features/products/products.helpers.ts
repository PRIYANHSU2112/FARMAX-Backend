/** Pure helpers for products (unit-tested; no I/O). */

/** URL slug from a name: ASCII lower-case words joined by `-`. */
export const slugify = (text: string): string => {
  const slug = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/%/g, ' pct ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160)
    .replace(/-+$/, '');
  return slug === '' ? 'product' : slug;
};

export const firstFreeSlug = (base: string, taken: ReadonlySet<string>): string => {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${String(n)}`;
    if (!taken.has(candidate)) return candidate;
  }
};

export const productCodeOf = (seq: number | bigint): string =>
  `FXP-${String(seq).padStart(6, '0')}`;

/** Denormalised, lower-cased search text (rebuilt in the write transaction). */
export const buildSearchText = (p: {
  name: string;
  genericName: string | null;
  brandName: string;
  productCode: string;
  manufacturerName: string | null;
  tags: readonly string[];
  ingredientNames: readonly string[];
}): string =>
  [
    p.name,
    p.genericName,
    p.brandName,
    p.productCode,
    p.manufacturerName,
    ...p.ingredientNames,
    ...p.tags,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim() !== '')
    .join(' ')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/** Money in paise (integers) to avoid float error; inputs are decimal strings or numbers. */
const toPaise = (value: string | number): number => Math.round(Number(value) * 100);
const fromPaise = (paise: number): string => (paise / 100).toFixed(2);

/**
 * Discount is always derived (never stored as truth): MRP from product-service, selling price from
 * the pricing projection. A selling price above MRP is treated as no discount.
 */
export const discountOf = (
  mrp: string | number,
  sellingPrice: string | number | null,
): { discountAmount: string | null; discountPercent: number | null } => {
  if (sellingPrice === null) return { discountAmount: null, discountPercent: null };
  const m = toPaise(mrp);
  const s = toPaise(sellingPrice);
  if (m <= 0 || s >= m) return { discountAmount: '0.00', discountPercent: 0 };
  return {
    discountAmount: fromPaise(m - s),
    discountPercent: Math.round(((m - s) / m) * 10_000) / 100,
  };
};

/** Product price range + best discount from its active variants' projections. */
export const priceSummary = (
  variants: readonly { mrp: string | number; sellingPrice: string | number | null }[],
): { minPrice: string | null; maxPrice: string | null; maxDiscountPercent: string | null } => {
  const priced = variants.filter((v) => v.sellingPrice !== null);
  if (priced.length === 0) return { minPrice: null, maxPrice: null, maxDiscountPercent: null };
  const prices = priced.flatMap((v) => (v.sellingPrice === null ? [] : [toPaise(v.sellingPrice)]));
  const best = Math.max(
    ...priced.map((v) => discountOf(v.mrp, v.sellingPrice).discountPercent ?? 0),
  );
  return {
    minPrice: fromPaise(Math.min(...prices)),
    maxPrice: fromPaise(Math.max(...prices)),
    maxDiscountPercent: best.toFixed(2),
  };
};

/**
 * Default-variant invariant on create: at most one flagged default, it must be active, and with
 * none flagged the first active variant becomes the default. Returns the default's index or an
 * error message.
 */
export const pickDefaultIndex = (
  variants: readonly { isDefault?: boolean; isActive?: boolean }[],
): number | string => {
  const flagged = variants.flatMap((v, i) => (v.isDefault === true ? [i] : []));
  if (flagged.length > 1) return 'Only one variant can be the default';
  const [index] = flagged;
  if (index !== undefined)
    return variants[index]?.isActive === false ? 'The default variant must be active' : index;
  const firstActive = variants.findIndex((v) => v.isActive !== false);
  return firstActive === -1 ? 'At least one variant must be active' : firstActive;
};

/** Variant to promote when the default is removed/deactivated: lowest sortOrder, then oldest. */
export const pickPromotion = <T extends { id: string; isActive: boolean; sortOrder: number }>(
  variants: readonly T[],
  excludeId: string,
  preferredId?: string,
): T | undefined => {
  const candidates = variants.filter((v) => v.id !== excludeId && v.isActive);
  if (preferredId !== undefined) return candidates.find((v) => v.id === preferredId);
  return [...candidates].sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))[0];
};
