import { discountOf } from './products.helpers.js';
import type { CardRecord, ProductRecord, VariantRecord } from './products.repository.js';
import type { ProductCard, ProductView, VariantView } from './products.types.js';

/** Copy of an object without the given keys. */
const omit = <T extends object, K extends keyof T>(obj: T, keys: readonly K[]): Omit<T, K> =>
  Object.fromEntries(
    Object.entries(obj).filter(([key]) => !(keys as readonly PropertyKey[]).includes(key)),
  ) as Omit<T, K>;

/** Prisma Decimal (or null) → decimal string. */
const dec = (value: { toString(): string } | null, places?: number): string | null =>
  value === null
    ? null
    : places === undefined
      ? value.toString()
      : Number(value.toString()).toFixed(places);
const money = (value: { toString(): string }) => Number(value.toString()).toFixed(2);

export const toVariantView = (v: VariantRecord): VariantView => {
  const mrp = money(v.mrp);
  const sellingPrice = v.price === null ? null : money(v.price.sellingPrice);
  return {
    id: v.id,
    sku: v.sku,
    barcode: v.barcode,
    name: v.name,
    packSize: v.packSize.toString(),
    packUnit: v.packUnit,
    unitsPerPack: v.unitsPerPack,
    mrp,
    sellingPrice,
    ...discountOf(mrp, sellingPrice),
    minOrderQty: v.minOrderQty,
    maxOrderQty: v.maxOrderQty,
    isB2cEligible: v.isB2cEligible,
    weightGrams: v.weightGrams,
    lengthMm: v.lengthMm,
    widthMm: v.widthMm,
    heightMm: v.heightMm,
    hsnCode: v.hsnCode,
    gstRate: dec(v.gstRate, 2),
    isDefault: v.isDefault,
    isActive: v.isActive,
    sortOrder: v.sortOrder,
    version: v.version,
    availability: v.availability ?? { inStock: false, lowStock: false, availableQty: null },
  };
};

export const toProductView = (p: ProductRecord): ProductView => ({
  id: p.id,
  name: p.name,
  slug: p.slug,
  productCode: p.productCode,
  shortDescription: p.shortDescription,
  description: p.description,
  categoryId: p.categoryId,
  brandId: p.brandId,
  brandName: p.brandName,
  genericName: p.genericName,
  dosageForm: p.dosageForm,
  routes: p.routes.map((r) => r.lookup),
  species: p.species.map(({ lookup: { id, code, label } }) => ({ id, code, label })),
  productionStages: p.productionStages,
  indications: p.indications,
  dosageInstructions: p.dosageInstructions,
  contraindications: p.contraindications,
  sideEffects: p.sideEffects,
  precautions: p.precautions,
  withdrawalMeatDays: p.withdrawalMeatDays,
  withdrawalEggDays: p.withdrawalEggDays,
  manufacturerName: p.manufacturerName,
  manufacturerAddress: p.manufacturerAddress,
  marketerName: p.marketerName,
  drugSchedule: p.drugSchedule,
  registrationAuthority: p.registrationAuthority,
  registrationNo: p.registrationNo,
  drugLicenseNo: p.drugLicenseNo,
  manufacturingLicenseNo: p.manufacturingLicenseNo,
  isPrescriptionRequired: p.isPrescriptionRequired,
  isVetConsultRequired: p.isVetConsultRequired,
  isAntimicrobial: p.isAntimicrobial,
  temperatureClass: p.temperatureClass,
  storageMinTempC: dec(p.storageMinTempC, 1),
  storageMaxTempC: dec(p.storageMaxTempC, 1),
  isFreezeSensitive: p.isFreezeSensitive,
  isLightSensitive: p.isLightSensitive,
  isHumiditySensitive: p.isHumiditySensitive,
  storageInstructions: p.storageInstructions,
  shelfLifeMonths: p.shelfLifeMonths,
  hazardClass: p.hazardClass,
  unNumber: p.unNumber,
  hsnCode: p.hsnCode,
  gstRate: money(p.gstRate),
  countryOfOrigin: p.countryOfOrigin,
  tags: p.tags,
  seoTitle: p.seoTitle,
  seoDescription: p.seoDescription,
  attributes: (p.attributes ?? {}) as Record<string, unknown>,
  isFeatured: p.isFeatured,
  isActive: p.isActive,
  status: p.status,
  submittedAt: p.submittedAt,
  publishedAt: p.publishedAt,
  minPrice: dec(p.minPrice, 2),
  maxPrice: dec(p.maxPrice, 2),
  maxDiscountPercent: dec(p.maxDiscountPercent, 2),
  rating: { avg: dec(p.ratingAvg, 2), count: p.ratingCount },
  ingredients: p.ingredients.map((i) => ({
    id: i.id,
    name: i.name,
    strength: i.strength.toString(),
    unit: i.unit,
    perQuantity: dec(i.perQuantity),
    perUnit: i.perUnit,
  })),
  variants: p.variants.map(toVariantView),
  media: p.media.map((m) => ({
    ...m,
    kind: m.kind,
    docType: m.docType,
  })),
  version: p.version,
  submittedByUserId: p.submittedByUserId,
  publishedByUserId: p.publishedByUserId,
  createdByUserId: p.createdByUserId,
  updatedByUserId: p.updatedByUserId,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** Storefront detail: only active variants; no workflow / audit fields. */
export const toPublicDetail = (view: ProductView) => {
  const rest = omit(view, [
    'status',
    'submittedAt',
    'submittedByUserId',
    'publishedByUserId',
    'createdByUserId',
    'updatedByUserId',
    'isActive',
    'version',
  ]);
  return {
    ...rest,
    isColdChain: view.temperatureClass === 'CC_REF' || view.temperatureClass === 'CC_FRZ',
    variants: view.variants
      .filter((v) => v.isActive)
      .map((v) => omit(v, ['version', 'isActive', 'sortOrder'])),
    inStock: view.variants.some((v) => v.isActive && v.availability.inStock),
  };
};

export type PublicProductDetail = ReturnType<typeof toPublicDetail>;

export const toCard = (c: CardRecord): ProductCard => {
  const variants = c.variants.map(toVariantView);
  const temperatureClass = c.temperatureClass;
  return {
    id: c.id,
    name: c.name,
    slug: c.slug,
    productCode: c.productCode,
    shortDescription: c.shortDescription,
    categoryId: c.categoryId,
    brand: { id: c.brandId, name: c.brandName },
    genericName: c.genericName,
    dosageForm: c.dosageForm,
    isPrescriptionRequired: c.isPrescriptionRequired,
    temperatureClass,
    isColdChain: temperatureClass === 'CC_REF' || temperatureClass === 'CC_FRZ',
    isFeatured: c.isFeatured,
    imageUrl: c.media[0]?.url ?? null,
    priceRange: { min: dec(c.minPrice, 2), max: dec(c.maxPrice, 2) },
    rating: { avg: dec(c.ratingAvg, 2), count: c.ratingCount },
    defaultVariant: variants[0] ?? null,
    inStock: variants.some((v) => v.availability.inStock),
  };
};
