import Joi from 'joi';
import { ID, PAGE, REASON, VERSION } from '../../middleware/http.js';
import { OWNER_TYPES, STOCK_STATUSES } from './stock.rules.js';

const DATE = Joi.string()
  .pattern(/^\d{4}-\d{2}-\d{2}$/)
  .messages({ 'string.pattern.base': 'must be a date YYYY-MM-DD' });
const QTY = Joi.number().integer().min(1).max(1_000_000);
const STATUS = Joi.string().valid(...STOCK_STATUSES);
const OWNER = Joi.string().valid(...OWNER_TYPES);
const BATCH_NO = Joi.string()
  .trim()
  .min(1)
  .max(40)
  .pattern(/^[A-Za-z0-9][A-Za-z0-9/_.-]*$/);

/** Commands that create something take an `Idempotency-Key` (handheld retries are safe). */
export const IDEMPOTENCY = Joi.object({
  'idempotency-key': Joi.string().trim().min(8).max(64).required(),
}).unknown(true);

export const receiptSchema = {
  headers: IDEMPOTENCY,
  body: Joi.object({
    warehouseId: ID.required(),
    sourceType: Joi.string().valid('VENDOR', 'RETURN').default('VENDOR'),
    vendorId: ID.allow(null),
    restockRequestId: ID.allow(null).when('sourceType', { is: 'RETURN', then: Joi.forbidden() }),
    notes: Joi.string().trim().max(500).allow(null, ''),
    lines: Joi.array()
      .items(
        Joi.object({
          variantId: ID.required(),
          batchNo: BATCH_NO.required(),
          mfgDate: DATE.allow(null),
          expiryDate: DATE.allow(null),
          qty: QTY.required(),
          binId: ID.allow(null),
          ownerType: OWNER,
          vendorId: ID.allow(null),
        }),
      )
      .min(1)
      .max(200)
      .required(),
  }),
};

export const receiptsQuery = {
  querystring: Joi.object({ warehouseId: ID, ...PAGE }),
};

export const idParam = { params: Joi.object({ id: ID.required() }) };

export const batchParam = { params: Joi.object({ batchId: ID.required() }) };

export const generateUnitsSchema = {
  ...batchParam,
  body: Joi.object({ warehouseId: ID.required() }),
};

export const coaSchema = {
  ...batchParam,
  body: Joi.object({
    warehouseId: ID.required(),
    coaRef: Joi.string().trim().max(60).allow(null),
    receipt: Joi.string().max(2048).allow(null),
    certificateStatus: Joi.string().valid(
      'NONE',
      'SAMPLE_REFERENCE',
      'VALID',
      'EXPIRED',
      'REJECTED',
    ),
    qualityNote: Joi.string().trim().max(500).allow(null),
  }).min(2),
};

export const releaseSchema = {
  body: Joi.object({
    warehouseId: ID.required(),
    batchId: ID.required(),
    binId: ID.allow(null),
    qty: QTY,
    from: Joi.string().valid('QC_HOLD', 'QUARANTINED', 'RETURNED').default('QC_HOLD'),
    reason: REASON,
  }),
};

export const holdSchema = {
  body: Joi.object({
    warehouseId: ID.required(),
    batchId: ID.required(),
    binId: ID.allow(null),
    qty: QTY,
    to: Joi.string().valid('QC_HOLD', 'QUARANTINED').default('QC_HOLD'),
    reason: REASON.required(),
  }),
};

export const statusChangeSchema = {
  body: Joi.object({
    positionId: ID.required(),
    from: STATUS.required(),
    to: STATUS.required(),
    qty: QTY.required(),
    reason: REASON.required(),
  }),
};

export const moveSchema = {
  body: Joi.object({
    positionId: ID.required(),
    toBinId: ID.required(),
    qty: QTY.required(),
    status: STATUS.default('AVAILABLE'),
    reason: REASON,
  }),
};

export const adjustmentSchema = {
  headers: IDEMPOTENCY,
  body: Joi.object({
    warehouseId: ID.required(),
    reasonCode: Joi.string()
      .valid('CYCLE_COUNT', 'DAMAGE_FOUND', 'SYSTEM_ERROR', 'FOUND_STOCK', 'LOST', 'OTHER')
      .required(),
    note: Joi.string().trim().max(500).allow(null),
    lines: Joi.array()
      .items(
        Joi.object({
          positionId: ID.required(),
          status: STATUS.default('AVAILABLE'),
          delta: Joi.number().integer().min(-1_000_000).max(1_000_000).invalid(0).required(),
        }),
      )
      .min(1)
      .max(100)
      .required(),
  }),
};

export const adjustmentsQuery = {
  querystring: Joi.object({
    warehouseId: ID,
    status: Joi.string().valid('PENDING_APPROVAL', 'APPLIED', 'REJECTED'),
    ...PAGE,
  }),
};

export const decideSchema = {
  ...idParam,
  body: Joi.object({
    expectedVersion: VERSION.required(),
    note: Joi.string().trim().max(500).allow(null),
  }),
};

export const ownerSchema = {
  ...idParam,
  body: Joi.object({
    ownerType: OWNER.required(),
    vendorId: ID.allow(null),
    reason: REASON.required(),
  }),
};

export const relabelSchema = {
  params: Joi.object({ positionId: ID.required() }),
  body: Joi.object({
    reason: REASON.required(),
    splits: Joi.array()
      .items(
        Joi.object({
          batchNo: BATCH_NO.required(),
          mfgDate: DATE.allow(null),
          expiryDate: DATE.allow(null),
          binId: ID.allow(null),
          qty: QTY.required(),
        }),
      )
      .min(1)
      .max(20)
      .required(),
  }),
};

const THRESHOLD = {
  safetyStock: Joi.number().integer().min(0).max(1_000_000).required(),
  reorderLevel: Joi.number().integer().min(0).max(1_000_000).required(),
  targetStock: Joi.number().integer().min(0).max(1_000_000).required(),
};

export const thresholdParams = {
  params: Joi.object({ warehouseId: ID.required(), variantId: ID.required() }),
};

export const thresholdSchema = { ...thresholdParams, body: Joi.object(THRESHOLD) };

export const thresholdBulkSchema = {
  body: Joi.object({
    warehouseId: ID.required(),
    rows: Joi.array()
      .items(Joi.object({ variantId: ID.required(), ...THRESHOLD }))
      .min(1)
      .max(500)
      .unique('variantId')
      .required(),
  }),
};

export const proposalSchema = {
  body: Joi.object({
    from: STATUS.required(),
    to: STATUS.required(),
    action: Joi.string().valid('ADD', 'REMOVE').default('ADD'),
    reasonEvent: Joi.string().trim().min(5).max(500).required(),
    roleLabel: Joi.string().trim().max(80).allow(null),
  }),
};

export const proposalsQuery = {
  querystring: Joi.object({
    status: Joi.string().valid('PENDING', 'APPROVED', 'REJECTED'),
    ...PAGE,
  }),
};

export const proposalDecisionSchema = {
  ...idParam,
  body: Joi.object({
    note: Joi.string().trim().max(500).allow(null),
    permissionKey: Joi.string()
      .pattern(/^[a-z]+\.[a-z_]+$/)
      .allow(null),
    roleLabel: Joi.string().trim().max(80).allow(null),
  }),
};

export const settingsSchema = {
  querystring: Joi.object({
    scope: Joi.alternatives(ID, Joi.string().valid('GLOBAL')).default('GLOBAL'),
  }),
  body: Joi.object({
    'stock.qcOnReceipt': Joi.boolean(),
    'stock.nearExpiryDays': Joi.number().integer().min(1).max(730),
    'stock.adjustApprovalUnits': Joi.number().integer().min(0).max(100_000),
    'stock.releasePolicy': Joi.string().valid('CONTROLLED', 'AUTO'),
    'stock.serializedCategoryIds': Joi.array().items(ID).max(200),
    'stock.freezeMaxMinutes': Joi.number().integer().min(15).max(240),
    'stock.rollbackWindowHours': Joi.number().integer().min(1).max(72),
  }).min(1),
};

export const settingsQuery = {
  querystring: Joi.object({
    scope: Joi.alternatives(ID, Joi.string().valid('GLOBAL')).default('GLOBAL'),
  }),
};

export const reasonSchema = { body: Joi.object({ reason: REASON.required() }) };

export const dlqParam = Joi.object({ id: Joi.string().max(64).required() });
export const reconcileQuery = {
  querystring: Joi.object({ type: Joi.string().valid('stock', 'allocation').default('stock') }),
};

const VENDOR = {
  name: Joi.string().trim().min(2).max(120),
  gstin: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/)
    .allow(null),
  phone: Joi.string()
    .trim()
    .pattern(/^\+?\d{10,15}$/)
    .allow(null),
  email: Joi.string().trim().lowercase().email().max(254).allow(null),
  defaultOwnership: OWNER,
  status: Joi.string().valid('ACTIVE', 'INACTIVE'),
};
export const vendorsQuery = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(60),
    variantId: ID,
    status: Joi.string().valid('ACTIVE', 'INACTIVE'),
    ...PAGE,
  }),
};
export const createVendorSchema = {
  body: Joi.object({
    code: Joi.string()
      .trim()
      .uppercase()
      .pattern(/^[A-Z0-9][A-Z0-9-]{1,19}$/)
      .required(),
    ...VENDOR,
    name: VENDOR.name.required(),
  }),
};
export const updateVendorSchema = {
  ...idParam,
  body: Joi.object({ ...VENDOR, expectedVersion: VERSION.required() }).min(2),
};
export const vendorVariantsSchema = {
  ...idParam,
  body: Joi.array()
    .items(
      Joi.object({
        variantId: ID.required(),
        ownershipModel: OWNER.required(),
        leadTimeDays: Joi.number().integer().min(0).max(365),
        moq: Joi.number().integer().min(1).max(1_000_000),
        isPreferred: Joi.boolean(),
        requiresUnitQr: Joi.boolean(),
      }),
    )
    .max(1000)
    .unique('variantId')
    .required(),
};
