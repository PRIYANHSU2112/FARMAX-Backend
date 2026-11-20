import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import {
  AUTH_ADMIN,
  AUTH_PUBLIC,
  IDEMPOTENCY_KEY,
  IDS,
  IF_MATCH,
  IF_NONE_MATCH,
  PUBLIC_ETAG,
  PUBLIC_RATE,
  VERSION_ETAG,
  ok,
  reasonIssue,
} from '../../docs/shared.js';
import type { StatusAction } from './products.status.js';

export const PRODUCTS_TAG = 'Catalog · Products';
export const ADMIN_PRODUCTS_TAG = 'Admin · Catalog Products';

const MANAGE = 'catalogue.manage';
const PUBLISH = 'catalogue.publish';
const at = '2026-11-14T09:30:00.000Z';

// ── Schemas ──

const lookupRef = Joi.object({
  id: Joi.string().guid(),
  code: Joi.string().example('ORAL_SOLUTION'),
  label: Joi.string().example('Oral solution'),
}).meta({ className: 'LookupRef' });

const priceFields = {
  mrp: Joi.string()
    .example('1150.00')
    .description('MRP incl. taxes (Legal Metrology), decimal string'),
  sellingPrice: Joi.string()
    .allow(null)
    .example('980.00')
    .description('From pricing-service (read-only projection); null until priced → show MRP'),
  discountAmount: Joi.string()
    .allow(null)
    .example('170.00')
    .description('Computed: mrp − sellingPrice'),
  discountPercent: Joi.number().allow(null).example(14.78).description('Computed'),
};

const variant = Joi.object({
  id: Joi.string().guid(),
  sku: Joi.string().example('ENRO10-1L'),
  barcode: Joi.string().allow(null).example('8901234567893').description('GS1 GTIN'),
  name: Joi.string().example('1 L'),
  packSize: Joi.string().example('1'),
  packUnit: lookupRef,
  unitsPerPack: Joi.number().integer(),
  ...priceFields,
  minOrderQty: Joi.number().integer(),
  maxOrderQty: Joi.number().integer().allow(null),
  isB2cEligible: Joi.boolean().description('Retail pack B2C buyers may purchase'),
  weightGrams: Joi.number().integer().allow(null),
  lengthMm: Joi.number().integer().allow(null),
  widthMm: Joi.number().integer().allow(null),
  heightMm: Joi.number().integer().allow(null),
  hsnCode: Joi.string().allow(null).description('Override of the product HSN'),
  gstRate: Joi.string().allow(null),
  isDefault: Joi.boolean().description('Exactly one active default per product'),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer(),
  version: Joi.number().integer(),
  availability: Joi.object({
    inStock: Joi.boolean(),
    lowStock: Joi.boolean(),
    availableQty: Joi.number().integer().allow(null),
  }).description('From inventory-service (read-only projection)'),
}).meta({ className: 'ProductVariant' });

const ingredient = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string().example('Enrofloxacin'),
  strength: Joi.string().example('100'),
  unit: lookupRef,
  perQuantity: Joi.string().allow(null).example('1'),
  perUnit: lookupRef.allow(null),
}).meta({ className: 'ProductIngredient' });

const media = Joi.object({
  id: Joi.string().guid(),
  variantId: Joi.string().guid().allow(null),
  kind: Joi.string().valid('IMAGE', 'DOCUMENT'),
  docType: Joi.string()
    .valid('TDS', 'SDS', 'MSDS', 'LEAFLET', 'PACKAGE_INSERT', 'LABEL', 'CERTIFICATE')
    .allow(null),
  url: Joi.string().uri(),
  mediaId: Joi.string().guid().allow(null),
  title: Joi.string().allow(null),
  sortOrder: Joi.number().integer(),
  isPrimary: Joi.boolean(),
}).meta({ className: 'ProductMedia' });

const productCore = {
  id: Joi.string().guid(),
  name: Joi.string().example('Enrocin 10% Oral Solution'),
  slug: Joi.string().example('enrocin-10-pct-oral-solution'),
  productCode: Joi.string().example('FXP-000123'),
  shortDescription: Joi.string().allow(null),
  description: Joi.string().allow(null),
  categoryId: Joi.string().guid().description('Any depth of the catalog category tree'),
  genericName: Joi.string().allow(null).example('Enrofloxacin'),
  dosageForm: lookupRef.allow(null),
  routes: Joi.array().items(lookupRef),
  species: Joi.array().items(lookupRef),
  productionStages: Joi.array().items(Joi.string()),
  indications: Joi.string().allow(null),
  dosageInstructions: Joi.string().allow(null),
  contraindications: Joi.string().allow(null),
  sideEffects: Joi.string().allow(null),
  precautions: Joi.string().allow(null),
  withdrawalMeatDays: Joi.number().integer().allow(null).description('0 = none; null = not stated'),
  withdrawalEggDays: Joi.number().integer().allow(null),
  manufacturerName: Joi.string().allow(null),
  manufacturerAddress: Joi.string().allow(null),
  marketerName: Joi.string().allow(null),
  drugSchedule: Joi.string().valid('OTC', 'G', 'H', 'H1', 'X'),
  registrationAuthority: Joi.string().valid('CDSCO', 'STATE').allow(null),
  registrationNo: Joi.string().allow(null),
  drugLicenseNo: Joi.string().allow(null),
  manufacturingLicenseNo: Joi.string().allow(null),
  isPrescriptionRequired: Joi.boolean().description('Forced true for G/H/H1/X and antimicrobials'),
  isVetConsultRequired: Joi.boolean().description('Forced true for Schedule X'),
  isAntimicrobial: Joi.boolean(),
  temperatureClass: Joi.string().valid('AMB', 'AMB_CTL', 'CC_REF', 'CC_FRZ', 'HAZ'),
  storageMinTempC: Joi.string().allow(null),
  storageMaxTempC: Joi.string().allow(null),
  isFreezeSensitive: Joi.boolean(),
  isLightSensitive: Joi.boolean(),
  isHumiditySensitive: Joi.boolean(),
  storageInstructions: Joi.string().allow(null),
  shelfLifeMonths: Joi.number().integer().allow(null),
  hazardClass: Joi.string().allow(null),
  unNumber: Joi.string().allow(null),
  hsnCode: Joi.string().example('30042019'),
  gstRate: Joi.string().example('12.00'),
  countryOfOrigin: Joi.string().allow(null).example('IN'),
  tags: Joi.array().items(Joi.string()),
  seoTitle: Joi.string().allow(null),
  seoDescription: Joi.string().allow(null),
  attributes: Joi.object().unknown().description('Values of the category’s dynamic attributes'),
  isFeatured: Joi.boolean(),
  minPrice: Joi.string().allow(null),
  maxPrice: Joi.string().allow(null),
  maxDiscountPercent: Joi.string().allow(null),
  rating: Joi.object({
    avg: Joi.string()
      .allow(null)
      .example('4.35')
      .description('Average of PUBLISHED reviews (1–5); null = no ratings yet'),
    count: Joi.number().integer().example(128).description('Number of published ratings'),
  }).meta({ className: 'ProductRating' }),
  ingredients: Joi.array().items(ingredient),
  variants: Joi.array().items(variant),
  media: Joi.array().items(media),
  publishedAt: Joi.date().allow(null),
};

const adminProduct = Joi.object({
  ...productCore,
  brandId: Joi.string().guid(),
  brandName: Joi.string().example('Venky’s Animal Health'),
  isActive: Joi.boolean(),
  status: Joi.string().valid('DRAFT', 'PENDING_REVIEW', 'PUBLISHED', 'SUSPENDED', 'DISCONTINUED'),
  submittedAt: Joi.date().allow(null),
  submittedByUserId: Joi.string().guid().allow(null),
  publishedByUserId: Joi.string().guid().allow(null),
  version: Joi.number().integer().description('Send as `If-Match` on writes'),
  createdByUserId: Joi.string().guid(),
  updatedByUserId: Joi.string().guid(),
  createdAt: Joi.date(),
  updatedAt: Joi.date(),
}).meta({ className: 'AdminProduct' });

const crumb = Joi.object({ id: Joi.string().guid(), name: Joi.string(), slug: Joi.string() });

const publicProduct = Joi.object({
  ...productCore,
  isColdChain: Joi.boolean(),
  inStock: Joi.boolean(),
  category: Joi.object({ id: Joi.string().guid(), breadcrumb: Joi.array().items(crumb) }),
  brand: Joi.object({
    id: Joi.string().guid(),
    name: Joi.string(),
    slug: Joi.string().allow(null),
    logoUrl: Joi.string().allow(null),
  }),
}).meta({ className: 'Product' });

const card = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string(),
  slug: Joi.string(),
  productCode: Joi.string(),
  shortDescription: Joi.string().allow(null),
  categoryId: Joi.string().guid(),
  brand: Joi.object({ id: Joi.string().guid(), name: Joi.string() }),
  genericName: Joi.string().allow(null),
  dosageForm: lookupRef.allow(null),
  isPrescriptionRequired: Joi.boolean().description('Rx badge'),
  temperatureClass: Joi.string(),
  isColdChain: Joi.boolean().description('Cold-chain badge'),
  isFeatured: Joi.boolean(),
  imageUrl: Joi.string().allow(null),
  priceRange: Joi.object({ min: Joi.string().allow(null), max: Joi.string().allow(null) }),
  rating: Joi.object({ avg: Joi.string().allow(null), count: Joi.number().integer() }),
  defaultVariant: variant.allow(null),
  inStock: Joi.boolean(),
}).meta({ className: 'ProductCard' });

const adminRow = Joi.object({
  id: Joi.string().guid(),
  name: Joi.string(),
  slug: Joi.string(),
  productCode: Joi.string(),
  categoryId: Joi.string().guid(),
  brandId: Joi.string().guid(),
  brandName: Joi.string(),
  status: Joi.string(),
  drugSchedule: Joi.string(),
  temperatureClass: Joi.string(),
  isActive: Joi.boolean(),
  isFeatured: Joi.boolean(),
  variantCount: Joi.number().integer(),
  defaultSku: Joi.string().allow(null),
  updatedAt: Joi.date(),
  version: Joi.number().integer(),
}).meta({ className: 'AdminProductRow' });

const complianceIssue = Joi.object({
  rule: Joi.string().example('R1'),
  path: Joi.string().example('drugLicenseNo'),
  message: Joi.string().example('Drug licence is required for Schedule H'),
}).meta({ className: 'ComplianceIssue' });

// ── Examples ──

const ml = { id: IDS.lookup, code: 'ML', label: 'ml' };
const litre = { id: IDS.attribute, code: 'L', label: 'L' };
const v100 = {
  id: IDS.variant,
  sku: 'ENRO10-100ML',
  barcode: '8901234567886',
  name: '100 ml',
  packSize: '100',
  packUnit: ml,
  unitsPerPack: 1,
  mrp: '185.00',
  sellingPrice: '162.00',
  discountAmount: '23.00',
  discountPercent: 12.43,
  minOrderQty: 1,
  maxOrderQty: null,
  isB2cEligible: true,
  weightGrams: 140,
  lengthMm: 45,
  widthMm: 45,
  heightMm: 120,
  hsnCode: null,
  gstRate: null,
  isDefault: true,
  isActive: true,
  sortOrder: 10,
  version: 0,
  availability: { inStock: true, lowStock: false, availableQty: 420 },
};
const v1l = {
  ...v100,
  id: IDS.variant2,
  sku: 'ENRO10-1L',
  barcode: '8901234567893',
  name: '1 L',
  packSize: '1',
  packUnit: litre,
  mrp: '1150.00',
  sellingPrice: '980.00',
  discountAmount: '170.00',
  discountPercent: 14.78,
  isB2cEligible: false,
  weightGrams: 1150,
  isDefault: false,
  sortOrder: 20,
};
const enroCore = {
  id: IDS.product,
  name: 'Enrocin 10% Oral Solution',
  slug: 'enrocin-10-pct-oral-solution',
  productCode: 'FXP-000123',
  shortDescription: 'Enrofloxacin 10% for respiratory and enteric infections',
  description:
    'Broad-spectrum fluoroquinolone for CRD, colibacillosis and fowl cholera in poultry.',
  categoryId: IDS.category,
  genericName: 'Enrofloxacin',
  dosageForm: { id: IDS.lookup, code: 'ORAL_SOLUTION', label: 'Oral solution' },
  routes: [{ id: IDS.lookup, code: 'DRINKING_WATER', label: 'Drinking water' }],
  species: [
    { id: IDS.lookup, code: 'BROILER', label: 'Broiler' },
    { id: IDS.attribute, code: 'BREEDER', label: 'Breeder' },
  ],
  productionStages: ['grower', 'finisher'],
  indications: 'CRD, E. coli infections, fowl cholera, infectious coryza.',
  dosageInstructions: '0.5 ml per litre of drinking water for 3–5 days.',
  contraindications: 'Do not use in laying birds producing eggs for human consumption.',
  sideEffects: null,
  precautions: 'Keep out of reach of children.',
  withdrawalMeatDays: 7,
  withdrawalEggDays: 7,
  manufacturerName: 'Venky’s (India) Ltd.',
  manufacturerAddress: 'Pune, Maharashtra',
  marketerName: null,
  drugSchedule: 'H',
  registrationAuthority: 'CDSCO',
  registrationNo: 'VET/REG/2024/1187',
  drugLicenseNo: 'MH-PZ1-123456',
  manufacturingLicenseNo: 'MFG/MH/2019/887',
  isPrescriptionRequired: true,
  isVetConsultRequired: false,
  isAntimicrobial: true,
  temperatureClass: 'AMB',
  storageMinTempC: null,
  storageMaxTempC: '30.0',
  isFreezeSensitive: false,
  isLightSensitive: true,
  isHumiditySensitive: false,
  storageInstructions: 'Store below 30 °C, protect from light.',
  shelfLifeMonths: 24,
  hazardClass: null,
  unNumber: null,
  hsnCode: '30042019',
  gstRate: '12.00',
  countryOfOrigin: 'IN',
  tags: ['antibiotic', 'crd'],
  seoTitle: 'Enrocin 10% Oral Solution | FarmX',
  seoDescription:
    'Enrofloxacin 10% oral solution for poultry. Buy online with cold-chain delivery.',
  attributes: { concentration: '10%' },
  isFeatured: true,
  minPrice: '162.00',
  maxPrice: '980.00',
  maxDiscountPercent: '14.78',
  rating: { avg: '4.35', count: 128 },
  ingredients: [
    {
      id: IDS.media,
      name: 'Enrofloxacin',
      strength: '100',
      unit: { id: IDS.lookup, code: 'MG', label: 'mg' },
      perQuantity: '1',
      perUnit: ml,
    },
  ],
  variants: [v100, v1l],
  media: [
    {
      id: IDS.media,
      variantId: null,
      kind: 'IMAGE',
      docType: null,
      url: 'https://cdn.farmx.in/products/enrocin.webp',
      mediaId: null,
      title: null,
      sortOrder: 0,
      isPrimary: true,
    },
    {
      id: IDS.audit,
      variantId: null,
      kind: 'DOCUMENT',
      docType: 'LEAFLET',
      url: 'https://cdn.farmx.in/docs/enrocin-leaflet.pdf',
      mediaId: null,
      title: 'Product leaflet',
      sortOrder: 0,
      isPrimary: false,
    },
  ],
  publishedAt: at,
};
const adminExample = {
  ...enroCore,
  brandId: IDS.brand,
  brandName: 'Venky’s Animal Health',
  isActive: true,
  status: 'PUBLISHED',
  submittedAt: at,
  submittedByUserId: IDS.admin,
  publishedByUserId: IDS.audit,
  version: 4,
  createdByUserId: IDS.admin,
  updatedByUserId: IDS.admin,
  createdAt: at,
  updatedAt: at,
};
const publicExample = {
  ...enroCore,
  isColdChain: false,
  inStock: true,
  category: {
    id: IDS.category,
    breadcrumb: [
      { id: IDS.category, name: 'Medicines', slug: 'medicines' },
      { id: IDS.category, name: 'Antibiotics', slug: 'antibiotics' },
    ],
  },
  brand: {
    id: IDS.brand,
    name: 'Venky’s Animal Health',
    slug: 'venkys-animal-health',
    logoUrl: null,
  },
};
const cardExample = {
  id: IDS.product,
  name: enroCore.name,
  slug: enroCore.slug,
  productCode: enroCore.productCode,
  shortDescription: enroCore.shortDescription,
  categoryId: IDS.category,
  brand: { id: IDS.brand, name: 'Venky’s Animal Health' },
  genericName: 'Enrofloxacin',
  dosageForm: enroCore.dosageForm,
  isPrescriptionRequired: true,
  temperatureClass: 'AMB',
  isColdChain: false,
  isFeatured: true,
  imageUrl: 'https://cdn.farmx.in/products/enrocin.webp',
  priceRange: { min: '162.00', max: '980.00' },
  rating: { avg: '4.35', count: 128 },
  defaultVariant: v100,
  inStock: true,
};
const lasotaCard = {
  ...cardExample,
  id: IDS.product2,
  name: 'Lasota ND Live Vaccine',
  slug: 'lasota-nd-live-vaccine',
  productCode: 'FXP-000124',
  shortDescription: 'Newcastle disease live vaccine, Lasota strain',
  genericName: 'Newcastle disease virus, Lasota strain (live)',
  dosageForm: { id: IDS.lookup, code: 'LYOPHILISED_VACCINE', label: 'Freeze-dried vaccine' },
  isPrescriptionRequired: true,
  temperatureClass: 'CC_REF',
  isColdChain: true,
  priceRange: { min: '310.00', max: '560.00' },
  rating: { avg: null, count: 0 },
  defaultVariant: {
    ...v100,
    id: IDS.variant2,
    sku: 'LASOTA-1000D',
    name: '1000 doses',
    packSize: '1000',
    packUnit: { id: IDS.lookup, code: 'DOSE', label: 'dose' },
    mrp: '340.00',
    sellingPrice: '310.00',
    discountAmount: '30.00',
    discountPercent: 8.82,
  },
};

const notFound = { message: 'Product not found' };
const versionConflict = {
  summary: 'VERSION_CONFLICT (stale If-Match)',
  message: 'The product was changed by someone else; reload and retry',
  details: { reason: 'VERSION_CONFLICT', currentVersion: 5 },
};
const duplicateSku = {
  summary: 'PRODUCT_DUPLICATE (SKU / barcode / slug)',
  message: 'Already in use: sku',
  details: { reason: 'PRODUCT_DUPLICATE', fields: ['sku'] },
};
const lastVariant = {
  summary: 'LAST_VARIANT',
  message: 'A product must keep at least one active variant',
  details: { reason: 'LAST_VARIANT' },
};
const complianceFail = {
  summary: 'Regulatory requirements not met (publish matrix R1–R13)',
  message: 'Regulatory requirements not met',
  details: {
    issues: [
      { path: 'drugLicenseNo', message: '[R1] Drug licence is required for Schedule H' },
      { path: 'withdrawalEggDays', message: '[R6] Egg withdrawal period is required (0 if none)' },
      { path: 'media', message: '[R13] A primary product image is required' },
    ],
  },
};
const unavailableRef = {
  summary: 'Category / brand inactive, unknown or being deleted',
  message: 'Validation failed',
  details: { issues: [{ path: 'categoryId', message: 'Category not found or inactive' }] },
};

const createExample = {
  name: 'Enrocin 10% Oral Solution',
  categoryId: IDS.category,
  brandId: IDS.brand,
  genericName: 'Enrofloxacin',
  dosageFormId: IDS.lookup,
  routeIds: [IDS.lookup],
  speciesIds: [IDS.lookup, IDS.attribute],
  ingredients: [
    {
      name: 'Enrofloxacin',
      strength: 100,
      unitId: IDS.lookup,
      perQuantity: 1,
      perUnitId: IDS.attribute,
    },
  ],
  indications: 'CRD, E. coli infections, fowl cholera, infectious coryza.',
  dosageInstructions: '0.5 ml per litre of drinking water for 3–5 days.',
  withdrawalMeatDays: 7,
  withdrawalEggDays: 7,
  manufacturerName: 'Venky’s (India) Ltd.',
  drugSchedule: 'H',
  registrationAuthority: 'CDSCO',
  registrationNo: 'VET/REG/2024/1187',
  drugLicenseNo: 'MH-PZ1-123456',
  manufacturingLicenseNo: 'MFG/MH/2019/887',
  isAntimicrobial: true,
  temperatureClass: 'AMB',
  storageMaxTempC: 30,
  storageInstructions: 'Store below 30 °C, protect from light.',
  shelfLifeMonths: 24,
  hsnCode: '30042019',
  gstRate: 12,
  countryOfOrigin: 'IN',
  tags: ['antibiotic', 'crd'],
  attributes: { concentration: '10%' },
  variants: [
    {
      sku: 'ENRO10-100ML',
      barcode: '8901234567886',
      name: '100 ml',
      packSize: 100,
      packUnitId: IDS.lookup,
      mrp: 185,
      isB2cEligible: true,
      isDefault: true,
    },
    {
      sku: 'ENRO10-1L',
      barcode: '8901234567893',
      name: '1 L',
      packSize: 1,
      packUnitId: IDS.attribute,
      mrp: 1150,
    },
  ],
  reason: 'New antibiotic listing requested by category manager',
};

const page = { nextCursor: null, limit: 20 };

const statusDoc = (
  action: StatusAction,
  summary: string,
  description: string,
  permission: string,
): RouteDocs => ({
  tag: ADMIN_PRODUCTS_TAG,
  operationId: `adminProduct${action[0]?.toUpperCase() ?? ''}${action.slice(1)}`,
  summary,
  description: `${description} Audited; emits outbox events.`,
  auth: AUTH_ADMIN,
  permission,
  headers: IF_MATCH,
  requestExample: { reason: 'Reviewed licences and label against the dossier' },
  success: {
    status: 200,
    description: 'New state',
    data: adminProduct,
    example: ok(adminExample),
    headers: VERSION_ETAG,
  },
  errors: [404, 409, 422],
  errorExamples: {
    404: notFound,
    409: [
      {
        summary: 'INVALID_TRANSITION',
        message: `Cannot ${action} a DISCONTINUED product`,
        details: { reason: 'INVALID_TRANSITION', status: 'DISCONTINUED', action },
      },
      versionConflict,
    ],
    422: [complianceFail, reasonIssue],
  },
});

export const PRODUCT_DOCS = {
  // ── Storefront ──
  publicList: {
    tag: PRODUCTS_TAG,
    operationId: 'listProducts',
    summary: 'Browse / search products',
    description:
      'Published, active products in active categories and brands.\n\n' +
      '- `q`: full-text + typo-tolerant search over name, generic name, ingredients (molecule), brand, manufacturer, tags and product code.\n' +
      '- `categoryId` / `categorySlug`: the category **and all its sub-categories** (any depth).\n' +
      '- Dynamic master filters by code: `dosageForm`, `species`, `route` (repeatable).\n' +
      '- `attr.<key>=value`: filterable attributes of the selected category (see `/filters`).\n' +
      '- `inStock`, `minPrice`/`maxPrice` use the inventory / pricing projections.\n' +
      '- `minRating` (1–5): published average rating at least this ("4★ & up"); `sort=rating`: best rated first.\n\n' +
      'Cached 60 s per query; send `If-None-Match` → 304.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'A page of product cards',
      data: card,
      paginated: true,
      example: ok([cardExample, lasotaCard], page),
      headers: PUBLIC_ETAG,
    },
    errors: [422],
    errorExamples: {
      422: {
        summary: 'Unknown attribute filter',
        message: 'Validation failed',
        details: {
          issues: [{ path: 'attr.colour', message: 'Not a filterable attribute of this category' }],
        },
      },
    },
  },
  publicDetail: {
    tag: PRODUCTS_TAG,
    operationId: 'getProduct',
    summary: 'Product page by slug or id',
    description:
      'Full regulatory and usage content, active variants (MRP, selling price, computed discount, stock), ingredients, documents (leaflet, SDS …), category breadcrumb and brand. Unpublished / hidden products → 404.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Product',
      data: publicProduct,
      example: ok(publicExample),
      headers: PUBLIC_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  alternatives: {
    tag: PRODUCTS_TAG,
    operationId: 'getProductAlternatives',
    summary: 'Alternatives with the same active ingredients',
    description: 'Same molecule set from other products / brands (substitution, FR-RX-08).',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Product cards',
      data: Joi.array().items(card),
      example: ok([cardExample]),
      headers: PUBLIC_ETAG,
    },
    errors: [404, 422],
  },
  filters: {
    tag: PRODUCTS_TAG,
    operationId: 'getProductFilters',
    summary: 'Filter options for a listing page',
    description:
      'Filterable dynamic attributes of the category (own + inherited), master values (dosage forms, routes, species), brands present and the price range.',
    auth: AUTH_PUBLIC,
    public: true,
    rateLimit: PUBLIC_RATE,
    headers: IF_NONE_MATCH,
    success: {
      status: 200,
      description: 'Filters',
      data: Joi.object({
        attributes: Joi.array().items(Joi.object().unknown()),
        dosageForms: Joi.array().items(Joi.object({ code: Joi.string(), label: Joi.string() })),
        routes: Joi.array().items(Joi.object({ code: Joi.string(), label: Joi.string() })),
        species: Joi.array().items(Joi.object({ code: Joi.string(), label: Joi.string() })),
        brands: Joi.array().items(
          Joi.object({ id: Joi.string(), name: Joi.string(), productCount: Joi.number() }),
        ),
        priceRange: Joi.object({ min: Joi.string().allow(null), max: Joi.string().allow(null) }),
      }).meta({ className: 'ProductFilters' }),
      example: ok({
        attributes: [
          {
            key: 'vaccineStrain',
            label: 'Vaccine strain',
            dataType: 'SELECT',
            unit: null,
            options: ['Lasota', 'F1', 'R2B'],
          },
        ],
        dosageForms: [{ code: 'LYOPHILISED_VACCINE', label: 'Freeze-dried vaccine' }],
        routes: [
          { code: 'EYE_DROP', label: 'Eye drop / intra-ocular' },
          { code: 'DRINKING_WATER', label: 'Drinking water' },
        ],
        species: [
          { code: 'BROILER', label: 'Broiler' },
          { code: 'LAYER', label: 'Layer' },
        ],
        brands: [{ id: IDS.brand, name: 'Venky’s Animal Health', productCount: 12 }],
        priceRange: { min: '95.00', max: '4200.00' },
      }),
      headers: PUBLIC_ETAG,
    },
    errors: [404, 422],
  },

  // ── Admin reads ──
  list: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminListProducts',
    summary: 'List products (all statuses)',
    description:
      '`q` searches name, generic name, product code and SKU. `categoryId` includes sub-categories.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    success: {
      status: 200,
      description: 'A page of products',
      data: adminRow,
      paginated: true,
      example: ok(
        [
          {
            id: IDS.product,
            name: enroCore.name,
            slug: enroCore.slug,
            productCode: 'FXP-000123',
            categoryId: IDS.category,
            brandId: IDS.brand,
            brandName: 'Venky’s Animal Health',
            status: 'PUBLISHED',
            drugSchedule: 'H',
            temperatureClass: 'AMB',
            isActive: true,
            isFeatured: true,
            variantCount: 2,
            defaultSku: 'ENRO10-100ML',
            updatedAt: at,
            version: 4,
          },
        ],
        page,
      ),
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminGetProduct',
    summary: 'Product detail (all fields, all variants)',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    success: {
      status: 200,
      description: 'Product',
      data: adminProduct,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 422],
    errorExamples: { 404: notFound },
  },
  history: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminProductHistory',
    summary: 'Change history (audit log)',
    description: 'Newest first; kept after deletion.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    success: {
      status: 200,
      description: 'Audit rows',
      data: Joi.object({
        id: Joi.string().guid(),
        actorUserId: Joi.string().guid(),
        action: Joi.string().example('product.approve'),
        reason: Joi.string().allow(null),
        createdAt: Joi.date(),
      }).meta({ className: 'ProductAuditRecord' }),
      paginated: true,
      example: ok(
        [
          {
            id: IDS.audit,
            actorUserId: IDS.admin,
            action: 'product.approve',
            reason: 'Dossier verified',
            createdAt: at,
          },
        ],
        page,
      ),
    },
    errors: [422],
  },
  compliance: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminProductCompliance',
    summary: 'Dry-run the regulatory publish checks',
    description:
      'Runs rules R1–R13 (schedules, licences, withdrawal periods by species, antimicrobials, cold chain 2–8 °C / frozen / controlled ambient, hazardous goods, required documents, primary image, default variant) merged with the category compliance profile, plus required dynamic attributes.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    success: {
      status: 200,
      description: 'Report',
      data: Joi.object({ ok: Joi.boolean(), issues: Joi.array().items(complianceIssue) }),
      example: ok({
        ok: false,
        issues: [
          { rule: 'R1', path: 'drugLicenseNo', message: 'Drug licence is required for Schedule H' },
        ],
      }),
    },
    errors: [404, 422],
  },

  // ── Admin writes ──
  create: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminCreateProduct',
    summary: 'Create a product with its variants (starts as DRAFT)',
    description:
      'At least one variant; exactly one default (the first active one when none is flagged). Category (any depth) and brand must be active. Dosage form, routes, species and units are **dynamic master values** (`/admin/catalog/lookups`). `attributes` are validated against the category’s attributes (types now, required-ness at submit). Rx flags are forced from the schedule. `slug` / `productCode` are generated. Audited; emits `product.variant_created.v1` per variant.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IDEMPOTENCY_KEY,
    requestExample: createExample,
    success: {
      status: 201,
      description: 'Created',
      data: adminProduct,
      example: ok({ ...adminExample, status: 'DRAFT', version: 0 }),
      headers: VERSION_ETAG,
    },
    errors: [409, 422],
    errorExamples: {
      409: duplicateSku,
      422: [
        unavailableRef,
        {
          summary: 'Two defaults',
          message: 'Validation failed',
          details: {
            issues: [{ path: 'variants', message: 'Only one variant can be the default' }],
          },
        },
        {
          summary: 'Wrong lookup group',
          message: 'Validation failed',
          details: { issues: [{ path: 'speciesIds[0]', message: 'Must be a SPECIES value' }] },
        },
        reasonIssue,
      ],
    },
  },
  update: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminUpdateProduct',
    summary: 'Update product content',
    description:
      'Any subset of fields + `reason`. `routeIds`, `speciesIds`, `ingredients` replace the whole list. A PUBLISHED / PENDING_REVIEW product must stay compliant (422 otherwise). Variants have their own routes.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    requestExample: {
      withdrawalEggDays: 10,
      reason: 'Updated per revised label from manufacturer',
    },
    success: {
      status: 200,
      description: 'Updated',
      data: adminProduct,
      example: ok({ ...adminExample, withdrawalEggDays: 10, version: 5 }),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: [duplicateSku, versionConflict],
      422: [complianceFail, unavailableRef],
    },
  },
  flags: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminSetProductFlags',
    summary: 'Activate / deactivate or feature / unfeature',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    requestExample: { isFeatured: true, reason: 'Featured for the monsoon CRD campaign' },
    success: {
      status: 200,
      description: 'Updated',
      data: adminProduct,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
  },
  submit: statusDoc(
    'submit',
    'Submit for review',
    'DRAFT → PENDING_REVIEW. Runs the full compliance matrix first.',
    MANAGE,
  ),
  approve: statusDoc(
    'approve',
    'Approve and publish',
    'PENDING_REVIEW → PUBLISHED. Approver must differ from the submitter (segregation of duties). Re-runs compliance. Emits `product.published.v1`.',
    PUBLISH,
  ),
  reject: statusDoc('reject', 'Reject back to draft', 'PENDING_REVIEW → DRAFT.', PUBLISH),
  suspend: statusDoc(
    'suspend',
    'Suspend a published product',
    'PUBLISHED → SUSPENDED (hidden from the storefront). Emits `product.suspended.v1`.',
    PUBLISH,
  ),
  reinstate: statusDoc(
    'reinstate',
    'Reinstate a suspended product',
    'SUSPENDED → PUBLISHED. Re-runs compliance.',
    PUBLISH,
  ),
  discontinue: statusDoc(
    'discontinue',
    'Discontinue (retire) a product',
    'Any status → DISCONTINUED (terminal; read-only afterwards).',
    PUBLISH,
  ),
  remove: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminDeleteProduct',
    summary: 'Delete a product (soft)',
    description:
      'Only DRAFT or DISCONTINUED. Variants and media go with it; emits `product.variant_deactivated.v1`.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
    errorExamples: {
      404: notFound,
      409: {
        summary: 'NOT_DELETABLE',
        message: 'Only draft or discontinued products can be deleted',
        details: { reason: 'NOT_DELETABLE', status: 'PUBLISHED' },
      },
    },
  },

  // ── Variants ──
  addVariant: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminAddProductVariant',
    summary: 'Add a pack-size / strength variant',
    description:
      '`isDefault: true` moves the default to it (must be active). Emits `product.variant_created.v1`.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    requestExample: {
      sku: 'ENRO10-5L',
      name: '5 L',
      packSize: 5,
      packUnitId: IDS.attribute,
      mrp: 5400,
      reason: 'Bulk pack for integrators',
    },
    success: {
      status: 201,
      description: 'Product with the new variant',
      data: adminProduct,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 409: duplicateSku },
  },
  updateVariant: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminUpdateProductVariant',
    summary: 'Update a variant',
    description:
      '`If-Match` = the variant version. Deactivating the default promotes another active variant; deactivating the last active variant → 409 `LAST_VARIANT`. Selling price is owned by pricing-service and cannot be set here.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    requestExample: { mrp: 1199, reason: 'MRP revised on new label' },
    success: {
      status: 200,
      description: 'Product',
      data: adminProduct,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 409: [lastVariant, duplicateSku, versionConflict] },
  },
  setDefaultVariant: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminSetDefaultProductVariant',
    summary: 'Make a variant the default',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    requestExample: { reason: '1 L is the best-selling pack' },
    success: {
      status: 200,
      description: 'Product',
      data: adminProduct,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
  },
  removeVariant: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminDeleteProductVariant',
    summary: 'Remove a variant (soft)',
    description:
      'Removing the default needs another active variant (`newDefaultVariantId`, or the lowest sort order is promoted). The last active variant cannot be removed → 409 `LAST_VARIANT`.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    headers: IF_MATCH,
    success: {
      status: 200,
      description: 'Product',
      data: adminProduct,
      example: ok(adminExample),
      headers: VERSION_ETAG,
    },
    errors: [404, 409, 422],
    errorExamples: { 409: lastVariant },
  },

  // ── Media ──
  addMedia: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminAddProductMedia',
    summary: 'Attach an image or document',
    description:
      'Upload the file through media-service first, then attach its URL. Documents need a `docType` (TDS, SDS, MSDS, LEAFLET, PACKAGE_INSERT, LABEL, CERTIFICATE). One primary image per product.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    requestExample: {
      kind: 'DOCUMENT',
      docType: 'LEAFLET',
      url: 'https://cdn.farmx.in/docs/enrocin-leaflet.pdf',
      title: 'Product leaflet',
      reason: 'Manufacturer leaflet v3',
    },
    success: { status: 201, description: 'Created', data: media, example: ok(enroCore.media[1]) },
    errors: [404, 422],
  },
  updateMedia: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminUpdateProductMedia',
    summary: 'Edit title / order / primary image',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    requestExample: { isPrimary: true, reason: 'New pack shot' },
    success: { status: 200, description: 'Updated', data: media, example: ok(enroCore.media[0]) },
    errors: [404, 422],
  },
  removeMedia: {
    tag: ADMIN_PRODUCTS_TAG,
    operationId: 'adminDeleteProductMedia',
    summary: 'Remove an image or document',
    description:
      'The primary image of a published product cannot be removed until another is primary.',
    auth: AUTH_ADMIN,
    permission: MANAGE,
    success: { status: 204, description: 'Deleted' },
    errors: [404, 409, 422],
  },
} satisfies Record<string, RouteDocs>;
