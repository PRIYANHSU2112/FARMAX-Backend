import type { DocType, DrugSchedule } from '../attributes/index.js';

export const TEMPERATURE_CLASSES = ['AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ'] as const;
export type TemperatureClass = (typeof TEMPERATURE_CLASSES)[number];
export const PRODUCT_STATUSES = [
  'DRAFT',
  'PENDING_REVIEW',
  'PUBLISHED',
  'SUSPENDED',
  'DISCONTINUED',
] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const REGISTRATION_AUTHORITIES = ['CDSCO', 'STATE'] as const;
export type RegistrationAuthority = (typeof REGISTRATION_AUTHORITIES)[number];
export const MEDIA_KINDS = ['IMAGE', 'DOCUMENT'] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** Money/strength values cross the API as decimal strings ("1150.00") — never floats. */
export type DecimalString = string;

export interface IngredientInput {
  name: string;
  strength: number;
  unitId: string;
  perQuantity?: number | null;
  perUnitId?: string | null;
}

export interface VariantInput {
  sku: string;
  barcode?: string | null;
  name: string;
  packSize: number;
  packUnitId: string;
  unitsPerPack?: number;
  mrp: number;
  minOrderQty?: number;
  maxOrderQty?: number | null;
  isB2cEligible?: boolean;
  weightGrams?: number | null;
  lengthMm?: number | null;
  widthMm?: number | null;
  heightMm?: number | null;
  hsnCode?: string | null;
  gstRate?: number | null;
  isDefault?: boolean;
  isActive?: boolean;
  sortOrder?: number;
}

/** Every editable product field (create requires the non-optional ones). */
export interface ProductFields {
  name: string;
  slug?: string;
  shortDescription?: string | null;
  description?: string | null;
  categoryId: string;
  brandId: string;
  genericName?: string | null;
  dosageFormId?: string | null;
  routeIds?: string[];
  speciesIds?: string[];
  productionStages?: string[];
  indications?: string | null;
  dosageInstructions?: string | null;
  contraindications?: string | null;
  sideEffects?: string | null;
  precautions?: string | null;
  withdrawalMeatDays?: number | null;
  withdrawalEggDays?: number | null;
  manufacturerName?: string | null;
  manufacturerAddress?: string | null;
  marketerName?: string | null;
  drugSchedule?: DrugSchedule;
  registrationAuthority?: RegistrationAuthority | null;
  registrationNo?: string | null;
  drugLicenseNo?: string | null;
  manufacturingLicenseNo?: string | null;
  isPrescriptionRequired?: boolean;
  isVetConsultRequired?: boolean;
  isAntimicrobial?: boolean;
  temperatureClass?: TemperatureClass;
  storageMinTempC?: number | null;
  storageMaxTempC?: number | null;
  isFreezeSensitive?: boolean;
  isLightSensitive?: boolean;
  isHumiditySensitive?: boolean;
  storageInstructions?: string | null;
  shelfLifeMonths?: number | null;
  hazardClass?: string | null;
  unNumber?: string | null;
  hsnCode: string;
  gstRate: number;
  countryOfOrigin?: string | null;
  tags?: string[];
  seoTitle?: string | null;
  seoDescription?: string | null;
  attributes?: Record<string, unknown>;
  isFeatured?: boolean;
  isActive?: boolean;
  ingredients?: IngredientInput[];
}

export type CreateProductInput = ProductFields & { variants: VariantInput[]; reason: string };
export type UpdateProductInput = Partial<ProductFields> & { reason: string };
export type UpdateVariantInput = Partial<Omit<VariantInput, 'isDefault'>> & { reason: string };

export interface MediaInput {
  kind: MediaKind;
  docType?: DocType | null;
  url: string;
  mediaId?: string | null;
  title?: string | null;
  variantId?: string | null;
  isPrimary?: boolean;
  sortOrder?: number;
  reason: string;
}
export type UpdateMediaInput = Partial<Pick<MediaInput, 'title' | 'isPrimary' | 'sortOrder'>> & {
  reason: string;
};

export interface LookupRef {
  id: string;
  code: string;
  label: string;
}

export interface IngredientView {
  id: string;
  name: string;
  strength: DecimalString;
  unit: LookupRef;
  perQuantity: DecimalString | null;
  perUnit: LookupRef | null;
}

export interface PriceView {
  mrp: DecimalString;
  /** null until pricing-service publishes a price (storefront then shows MRP). */
  sellingPrice: DecimalString | null;
  discountAmount: DecimalString | null;
  discountPercent: number | null;
}

export interface AvailabilityView {
  inStock: boolean;
  lowStock: boolean;
  /** null until inventory-service reports the variant. */
  availableQty: number | null;
}

export interface VariantView extends PriceView {
  id: string;
  sku: string;
  barcode: string | null;
  name: string;
  packSize: DecimalString;
  packUnit: LookupRef;
  unitsPerPack: number;
  minOrderQty: number;
  maxOrderQty: number | null;
  isB2cEligible: boolean;
  weightGrams: number | null;
  lengthMm: number | null;
  widthMm: number | null;
  heightMm: number | null;
  hsnCode: string | null;
  gstRate: DecimalString | null;
  isDefault: boolean;
  isActive: boolean;
  sortOrder: number;
  version: number;
  availability: AvailabilityView;
}

export interface MediaView {
  id: string;
  variantId: string | null;
  kind: MediaKind;
  docType: DocType | null;
  url: string;
  mediaId: string | null;
  title: string | null;
  sortOrder: number;
  isPrimary: boolean;
}

/** Full product (admin detail; the storefront view strips internal fields). */
export interface ProductView {
  id: string;
  name: string;
  slug: string;
  productCode: string;
  shortDescription: string | null;
  description: string | null;
  categoryId: string;
  brandId: string;
  brandName: string;
  genericName: string | null;
  dosageForm: LookupRef | null;
  routes: LookupRef[];
  species: LookupRef[];
  productionStages: string[];
  indications: string | null;
  dosageInstructions: string | null;
  contraindications: string | null;
  sideEffects: string | null;
  precautions: string | null;
  withdrawalMeatDays: number | null;
  withdrawalEggDays: number | null;
  manufacturerName: string | null;
  manufacturerAddress: string | null;
  marketerName: string | null;
  drugSchedule: DrugSchedule;
  registrationAuthority: RegistrationAuthority | null;
  registrationNo: string | null;
  drugLicenseNo: string | null;
  manufacturingLicenseNo: string | null;
  isPrescriptionRequired: boolean;
  isVetConsultRequired: boolean;
  isAntimicrobial: boolean;
  temperatureClass: TemperatureClass;
  storageMinTempC: DecimalString | null;
  storageMaxTempC: DecimalString | null;
  isFreezeSensitive: boolean;
  isLightSensitive: boolean;
  isHumiditySensitive: boolean;
  storageInstructions: string | null;
  shelfLifeMonths: number | null;
  hazardClass: string | null;
  unNumber: string | null;
  hsnCode: string;
  gstRate: DecimalString;
  countryOfOrigin: string | null;
  tags: string[];
  seoTitle: string | null;
  seoDescription: string | null;
  attributes: Record<string, unknown>;
  isFeatured: boolean;
  isActive: boolean;
  status: ProductStatus;
  submittedAt: Date | null;
  publishedAt: Date | null;
  minPrice: DecimalString | null;
  maxPrice: DecimalString | null;
  maxDiscountPercent: DecimalString | null;
  rating: RatingView;
  ingredients: IngredientView[];
  variants: VariantView[];
  media: MediaView[];
  version: number;
  submittedByUserId: string | null;
  publishedByUserId: string | null;
  createdByUserId: string;
  updatedByUserId: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Storefront product card (list). */
export interface ProductCard {
  id: string;
  name: string;
  slug: string;
  productCode: string;
  shortDescription: string | null;
  categoryId: string;
  brand: { id: string; name: string };
  genericName: string | null;
  dosageForm: LookupRef | null;
  isPrescriptionRequired: boolean;
  temperatureClass: TemperatureClass;
  isColdChain: boolean;
  isFeatured: boolean;
  imageUrl: string | null;
  priceRange: { min: DecimalString | null; max: DecimalString | null };
  rating: RatingView;
  defaultVariant: VariantView | null;
  inStock: boolean;
}

/** Admin list row. */
export interface AdminProductRow {
  id: string;
  name: string;
  slug: string;
  productCode: string;
  categoryId: string;
  brandId: string;
  brandName: string;
  status: ProductStatus;
  drugSchedule: DrugSchedule;
  temperatureClass: TemperatureClass;
  isActive: boolean;
  isFeatured: boolean;
  variantCount: number;
  defaultSku: string | null;
  updatedAt: Date;
  version: number;
}

export type PublicSort =
  'relevance' | 'name' | 'price_asc' | 'price_desc' | 'discount' | 'newest' | 'rating';

/** Published rating (reviews feature): average 1–5 (null = none yet) and number of ratings. */
export interface RatingView {
  avg: DecimalString | null;
  count: number;
}

export interface PublicListQuery {
  q?: string;
  categoryId?: string;
  categorySlug?: string;
  brandId?: string[];
  dosageForm?: string;
  species?: string[];
  route?: string[];
  isPrescriptionRequired?: boolean;
  temperatureClass?: TemperatureClass;
  inStock?: boolean;
  minPrice?: number;
  maxPrice?: number;
  minRating?: number;
  isFeatured?: boolean;
  sort?: PublicSort;
  cursor?: string;
  limit: number;
  /** `attr.<key>` filters (filterable category attributes only). */
  [attr: `attr.${string}`]: string | string[] | undefined;
}

export interface AdminListQuery {
  q?: string;
  status?: ProductStatus;
  categoryId?: string;
  brandId?: string;
  isActive?: boolean;
  isFeatured?: boolean;
  cursor?: string;
  limit: number;
}

export interface ComplianceIssue {
  rule: string;
  path: string;
  message: string;
}
