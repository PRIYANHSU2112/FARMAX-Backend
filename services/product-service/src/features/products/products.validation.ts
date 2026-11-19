import Joi from 'joi';

import { DOC_TYPES, DRUG_SCHEDULES } from '../attributes/index.js';
import { ID, PAGE, REASON, SLUG } from '../../middleware/http.js';
import {
  MEDIA_KINDS,
  PRODUCT_STATUSES,
  REGISTRATION_AUTHORITIES,
  TEMPERATURE_CLASSES,
} from './products.types.js';

const TEXT = (max: number) => Joi.string().trim().max(max).allow(null, '');
const LONG = TEXT(5000);
const LICENCE = Joi.string().trim().max(60).allow(null, '');
const SKU = Joi.string()
  .trim()
  .uppercase()
  .min(3)
  .max(40)
  .pattern(/^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/)
  .messages({ 'string.pattern.base': 'must be letters, digits and single - _ . separators' });
/** GS1 GTIN-8/12/13/14 (digits only). */
const GTIN = Joi.string()
  .pattern(/^(\d{8}|\d{12,14})$/)
  .allow(null)
  .messages({ 'string.pattern.base': 'must be an 8, 12, 13 or 14-digit GTIN' });
const HSN = Joi.string()
  .pattern(/^\d{4,8}$/)
  .messages({ 'string.pattern.base': 'must be 4–8 digits' });
const GST = Joi.number().valid(0, 0.1, 0.25, 3, 5, 12, 18, 28);
const MONEY = Joi.number().positive().precision(2).max(99_999_999);
const DAYS = Joi.number().integer().min(0).max(365).allow(null);
const MM = Joi.number().integer().min(1).max(10_000).allow(null);
const TEMP = Joi.number().min(-80).max(60).precision(1).allow(null);

const ingredient = Joi.object({
  name: Joi.string().trim().min(2).max(120).required(),
  strength: Joi.number().positive().max(1e9).required(),
  unitId: ID.required(),
  perQuantity: Joi.number().positive().max(1e9).allow(null),
  perUnitId: ID.allow(null),
});

const variantFields = {
  sku: SKU,
  barcode: GTIN,
  name: Joi.string().trim().min(1).max(80),
  packSize: Joi.number().positive().max(1e7),
  packUnitId: ID,
  unitsPerPack: Joi.number().integer().min(1).max(100_000),
  mrp: MONEY,
  minOrderQty: Joi.number().integer().min(1).max(1_000_000),
  maxOrderQty: Joi.number().integer().min(1).max(1_000_000).allow(null),
  isB2cEligible: Joi.boolean(),
  weightGrams: Joi.number().integer().min(1).max(10_000_000).allow(null),
  lengthMm: MM,
  widthMm: MM,
  heightMm: MM,
  hsnCode: HSN.allow(null),
  gstRate: GST.allow(null),
  isActive: Joi.boolean(),
  sortOrder: Joi.number().integer().min(0).max(1_000_000),
};

const variant = Joi.object({
  ...variantFields,
  sku: SKU.required(),
  name: variantFields.name.required(),
  packSize: variantFields.packSize.required(),
  packUnitId: ID.required(),
  mrp: MONEY.required(),
  isDefault: Joi.boolean(),
});

const productFields = {
  name: Joi.string().trim().min(2).max(160),
  slug: SLUG,
  shortDescription: TEXT(300),
  description: LONG,
  categoryId: ID,
  brandId: ID,
  genericName: TEXT(200),
  dosageFormId: ID.allow(null),
  routeIds: Joi.array().items(ID).max(20).unique(),
  speciesIds: Joi.array().items(ID).max(20).unique(),
  productionStages: Joi.array().items(Joi.string().trim().min(1).max(40)).max(20).unique(),
  indications: LONG,
  dosageInstructions: LONG,
  contraindications: LONG,
  sideEffects: LONG,
  precautions: LONG,
  withdrawalMeatDays: DAYS,
  withdrawalEggDays: DAYS,
  manufacturerName: TEXT(160),
  manufacturerAddress: TEXT(500),
  marketerName: TEXT(160),
  drugSchedule: Joi.string().valid(...DRUG_SCHEDULES),
  registrationAuthority: Joi.string()
    .valid(...REGISTRATION_AUTHORITIES)
    .allow(null),
  registrationNo: LICENCE,
  drugLicenseNo: LICENCE,
  manufacturingLicenseNo: LICENCE,
  isPrescriptionRequired: Joi.boolean(),
  isVetConsultRequired: Joi.boolean(),
  isAntimicrobial: Joi.boolean(),
  temperatureClass: Joi.string().valid(...TEMPERATURE_CLASSES),
  storageMinTempC: TEMP,
  storageMaxTempC: TEMP,
  isFreezeSensitive: Joi.boolean(),
  isLightSensitive: Joi.boolean(),
  isHumiditySensitive: Joi.boolean(),
  storageInstructions: TEXT(500),
  shelfLifeMonths: Joi.number().integer().min(1).max(120).allow(null),
  hazardClass: TEXT(40),
  unNumber: Joi.string()
    .pattern(/^UN\d{4}$/)
    .allow(null, '')
    .messages({ 'string.pattern.base': 'must look like UN1234' }),
  hsnCode: HSN,
  gstRate: GST,
  countryOfOrigin: Joi.string()
    .uppercase()
    .length(2)
    .pattern(/^[A-Z]{2}$/)
    .allow(null),
  tags: Joi.array().items(Joi.string().trim().lowercase().min(1).max(40)).max(30).unique(),
  seoTitle: TEXT(70),
  seoDescription: TEXT(160),
  attributes: Joi.object().unknown(true).max(100),
  isFeatured: Joi.boolean(),
  isActive: Joi.boolean(),
  ingredients: Joi.array().items(ingredient).max(30),
};

const storageRange = (schema: Joi.ObjectSchema) =>
  schema.custom(
    (value: { storageMinTempC?: number | null; storageMaxTempC?: number | null }, helpers) => {
      const { storageMinTempC: min, storageMaxTempC: max } = value;
      if (typeof min === 'number' && typeof max === 'number' && min > max)
        return helpers.message({ custom: '"storageMinTempC" must be ≤ "storageMaxTempC"' });
      return value;
    },
  );

export const createSchema = {
  body: storageRange(
    Joi.object({
      ...productFields,
      name: productFields.name.required(),
      categoryId: ID.required(),
      brandId: ID.required(),
      hsnCode: HSN.required(),
      gstRate: GST.required(),
      variants: Joi.array().items(variant).min(1).max(50).required(),
      reason: REASON,
    }),
  ),
};

export const updateSchema = {
  params: Joi.object({ id: ID.required() }),
  body: storageRange(Joi.object({ ...productFields, reason: REASON }).min(2)),
};

export const flagsSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ isActive: Joi.boolean(), isFeatured: Joi.boolean(), reason: REASON }).or(
    'isActive',
    'isFeatured',
  ),
};

export const statusSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ reason: REASON }),
};

const variantParams = Joi.object({ id: ID.required(), variantId: ID.required() });

export const addVariantSchema = {
  params: Joi.object({ id: ID.required() }),
  body: variant.keys({ reason: REASON }),
};

export const updateVariantSchema = {
  params: variantParams,
  body: Joi.object({ ...variantFields, reason: REASON }).min(2),
};

export const variantActionSchema = { params: variantParams, body: Joi.object({ reason: REASON }) };

export const deleteVariantSchema = {
  params: variantParams,
  querystring: Joi.object({ reason: REASON, newDefaultVariantId: ID }),
};

export const addMediaSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({
    kind: Joi.string()
      .valid(...MEDIA_KINDS)
      .required(),
    docType: Joi.string()
      .valid(...DOC_TYPES)
      .when('kind', {
        is: 'DOCUMENT',
        then: Joi.required(),
        otherwise: Joi.forbidden(),
      }),
    url: Joi.string()
      .uri({ scheme: ['https', 'http'] })
      .max(500)
      .required(),
    mediaId: ID.allow(null),
    title: TEXT(120),
    variantId: ID.allow(null),
    isPrimary: Joi.boolean().when('kind', { is: 'DOCUMENT', then: Joi.valid(false) }),
    sortOrder: Joi.number().integer().min(0).max(1_000_000),
    reason: REASON,
  }),
};

const mediaParams = Joi.object({ id: ID.required(), mediaId: ID.required() });

export const updateMediaSchema = {
  params: mediaParams,
  body: Joi.object({
    title: TEXT(120),
    isPrimary: Joi.boolean(),
    sortOrder: Joi.number().integer().min(0).max(1_000_000),
    reason: REASON,
  }).min(2),
};

export const deleteMediaSchema = {
  params: mediaParams,
  querystring: Joi.object({ reason: REASON }),
};

export const adminListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(80),
    status: Joi.string().valid(...PRODUCT_STATUSES),
    categoryId: ID,
    brandId: ID,
    isActive: Joi.boolean(),
    isFeatured: Joi.boolean(),
    ...PAGE,
  }),
};

export const historySchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object(PAGE),
};

const CODE = Joi.string().trim().uppercase().max(40);
const CODES = Joi.alternatives().try(Joi.array().items(CODE).max(20), CODE);

export const publicListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(100),
    categoryId: ID,
    categorySlug: Joi.string().lowercase().max(100),
    brandId: Joi.alternatives().try(Joi.array().items(ID).max(20), ID),
    dosageForm: CODE,
    species: CODES,
    route: CODES,
    isPrescriptionRequired: Joi.boolean(),
    temperatureClass: Joi.string().valid(...TEMPERATURE_CLASSES),
    inStock: Joi.boolean(),
    minPrice: Joi.number().min(0),
    maxPrice: Joi.number().min(0),
    isFeatured: Joi.boolean(),
    sort: Joi.string().valid('relevance', 'name', 'price_asc', 'price_desc', 'discount', 'newest'),
    ...PAGE,
  })
    .oxor('categoryId', 'categorySlug')
    // Dynamic category attributes: `attr.<key>=value` (validated against the category).
    .pattern(
      /^attr\.[a-z][a-zA-Z0-9]*$/,
      Joi.alternatives().try(Joi.string().max(80), Joi.array().items(Joi.string().max(80)).max(20)),
    ),
};

export const slugOrIdSchema = {
  params: Joi.object({ slugOrId: Joi.alternatives().try(ID, SLUG).required() }),
};

export const filtersSchema = { querystring: Joi.object({ categoryId: ID }) };

export const referenceBlockSchema = {
  body: Joi.object({
    refType: Joi.string().valid('CATEGORY', 'BRAND').required(),
    refId: ID.required(),
  }),
};

export const referenceParamsSchema = {
  params: Joi.object({
    refType: Joi.string().valid('CATEGORY', 'BRAND').required(),
    refId: ID.required(),
  }),
};

export const variantIdsSchema = {
  querystring: Joi.object({
    ids: Joi.alternatives().try(Joi.array().items(ID).min(1).max(200), ID).required(),
  }),
};

export const productIdsSchema = {
  querystring: Joi.object({
    ids: Joi.alternatives().try(Joi.array().items(ID).min(1).max(100), ID).required(),
  }),
};

/** `?brandId=a&brandId=b` and `?brandId=a` both become arrays. */
export const toArray = <T>(value: T | T[] | undefined): T[] | undefined =>
  value === undefined ? undefined : Array.isArray(value) ? value : [value];
