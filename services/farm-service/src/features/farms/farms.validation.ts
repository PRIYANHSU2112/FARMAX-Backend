import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

export const CATEGORIES = ['POULTRY_FARM', 'HATCHERY', 'FEED_MILL', 'BACKYARD'] as const;
export const PRODUCTION_TYPES = [
  'LAYER',
  'BROILER',
  'BROILER_BREEDER',
  'LAYER_BREEDER',
  'HATCHERY',
  'FEED_MILL',
  'BACKYARD',
] as const;
export const STATUSES = [
  'DRAFT',
  'UNDER_REVIEW',
  'NEEDS_ATTENTION',
  'ACTIVE',
  'SUSPENDED',
  'REJECTED',
  'MERGED',
  'CLOSED',
] as const;
export const METRICS = ['BIRDS', 'EGGS', 'FEED_TONNES'] as const;
export const PERIODS = [
  'STANDING',
  'PER_CYCLE',
  'PER_SETTING',
  'PER_WEEK',
  'PER_HOUR',
  'PER_DAY',
  'PER_MONTH',
] as const;
export const KYC_STATUSES = ['NOT_STARTED', 'PENDING', 'VERIFIED', 'REJECTED'] as const;

const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
const NAME = Joi.string().trim().min(2).max(120);
const PIN = Joi.string()
  .pattern(/^[1-9][0-9]{5}$/)
  .messages({ 'string.pattern.base': 'must be a 6-digit pin code' });
const REASON = Joi.string().trim().min(10).max(500).required();
// India bounding box (also a DB CHECK).
const LAT = Joi.number().min(6.5).max(37.5).precision(6);
const LNG = Joi.number().min(68).max(97.5).precision(6);
const LIMIT = Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT);

const capacity = Joi.object({
  productionType: Joi.string()
    .valid(...PRODUCTION_TYPES)
    .required(),
  metric: Joi.string()
    .valid(...METRICS)
    .required(),
  value: Joi.number().positive().max(100_000_000).precision(2).required(),
  period: Joi.string()
    .valid(...PERIODS)
    .required(),
});
const capacities = Joi.array()
  .items(capacity)
  .max(12)
  .unique(
    (
      a: { productionType: string; metric: string },
      b: { productionType: string; metric: string },
    ) => a.productionType === b.productionType && a.metric === b.metric,
  );

export const idParams = { params: Joi.object({ id: ID.required() }) };

export const listFarmsSchema = {
  querystring: Joi.object({ status: Joi.string().valid(...STATUSES), cursor: ID, limit: LIMIT }),
};

export const createDraftSchema = {
  body: Joi.object({
    category: Joi.string()
      .valid(...CATEGORIES)
      .required(),
  }),
};

export const quickSignupSchema = {
  body: Joi.object({
    ownerName: NAME.required(),
    addressLine: Joi.string().trim().min(3).max(200).required(),
    village: NAME.max(80).required(),
    pinCode: PIN.required(),
    latitude: LAT,
    longitude: LNG,
    accuracyM: Joi.number().integer().min(0).max(100),
    birds: Joi.number().integer().min(1).max(5_000),
    personalizedOffers: Joi.boolean(),
  }).and('latitude', 'longitude'),
};

export const detailsSchema = {
  ...idParams,
  body: Joi.object({
    name: NAME.required(),
    ownerName: NAME.required(),
    productionTypes: Joi.array()
      .items(Joi.string().valid(...PRODUCTION_TYPES))
      .min(1)
      .max(4)
      .unique(),
    capacities: capacities.min(1).required(),
  }),
};

export const locationSchema = {
  ...idParams,
  body: Joi.object({
    latitude: LAT.required(),
    longitude: LNG.required(),
    accuracyM: Joi.number()
      .integer()
      .min(0)
      .max(100)
      .required()
      .messages({ 'number.max': 'GPS accuracy must be within 100 m; move to open sky and retry' }),
    capturedAt: Joi.date().iso().max('now').required(),
    village: NAME.max(80).required(),
    pinCode: PIN.required(),
    addressLine: Joi.string().trim().max(200),
  }),
};

export const ownerPrefsSchema = {
  ...idParams,
  body: Joi.object({
    ageBand: Joi.string().valid('AGE_18_30', 'AGE_31_45', 'AGE_46_60', 'AGE_60_PLUS').allow(null),
    personalizedOffers: Joi.boolean(),
  }).min(1),
};

export const submitSchema = {
  ...idParams,
  body: Joi.object({ acknowledgePermanentId: Joi.boolean().valid(true).required() }),
};

export const updateActiveSchema = {
  ...idParams,
  body: Joi.object({
    addressLine: Joi.string().trim().max(200),
    capacities: capacities.min(1),
  }).min(1),
};

export const verifyPassSchema = {
  params: Joi.object({
    farmCode: Joi.string()
      .pattern(/^FX-[A-Z]{2,3}-[A-Z]{1,2}-\d{5,}$/)
      .required(),
  }),
  querystring: Joi.object({ sig: Joi.string().hex().length(64).required() }),
};

// ── Admin ──

export const adminListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(2).max(60),
    status: Joi.string().valid(...STATUSES),
    category: Joi.string().valid(...CATEGORIES),
    productionType: Joi.string().valid(...PRODUCTION_TYPES),
    territoryCode: Joi.string()
      .uppercase()
      .pattern(/^[A-Z]{2,3}$/),
    pinCode: PIN,
    kycStatus: Joi.string().valid(...KYC_STATUSES),
    channel: Joi.string().valid('SELF', 'FIELD_ASSISTED', 'ADMIN', 'IMPORT'),
    createdFrom: Joi.date().iso(),
    createdTo: Joi.date().iso().greater(Joi.ref('createdFrom')),
    cursor: ID,
    limit: LIMIT,
  }),
};

export const adminHistorySchema = {
  ...idParams,
  querystring: Joi.object({ cursor: ID, limit: LIMIT }),
};

export const adminUpdateSchema = {
  ...idParams,
  body: Joi.object({
    name: NAME,
    ownerName: NAME,
    addressLine: Joi.string().trim().max(200),
    capacities: capacities.min(1),
    reason: REASON,
  }).min(2),
};

const issue = Joi.object({
  docType: Joi.string()
    .valid(
      'PAN_CARD',
      'GST_CERTIFICATE',
      'ID_PROOF_FRONT',
      'ID_PROOF_BACK',
      'OTHER',
      'DETAILS',
      'LOCATION',
    )
    .required(),
  code: Joi.string().valid('BLURRY', 'MISMATCH', 'EXPIRED', 'INCOMPLETE', 'OTHER').required(),
  message: Joi.string().trim().min(5).max(300).required(),
});

export const adminActionSchema = {
  params: Joi.object({
    id: ID.required(),
    action: Joi.string()
      .valid('suspend', 'reactivate', 'close', 'reject', 'request-changes')
      .required(),
  }),
  body: Joi.object({
    reason: REASON,
    /** Required for `request-changes` (checked in the controller: params are not visible here). */
    issues: Joi.array().items(issue).min(1).max(10),
  }),
};

export const internalBatchSchema = {
  body: Joi.object({ ids: Joi.array().items(ID).min(1).max(100).unique().required() }),
};

export const internalByCodeSchema = { params: verifyPassSchema.params };

/** `If-Match: 3` / `"3"` / `W/"3"` → 3. Absent → undefined (the row version is still checked). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};
