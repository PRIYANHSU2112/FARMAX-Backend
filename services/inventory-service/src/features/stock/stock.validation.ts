import Joi from 'joi';

import { ID, PAGE, QTY, REASON, idParams } from '../../middleware/http.js';

export const OPERATION_TYPES = ['RECEIPT', 'DAMAGE', 'WRITE_OFF', 'ADJUSTMENT'] as const;
export const OPERATION_STATUSES = ['PENDING', 'APPLIED', 'REJECTED'] as const;
export const LEDGER_TYPES = [
  'RECEIVE',
  'ADJUST_IN',
  'ADJUST_OUT',
  'DAMAGE',
  'WRITE_OFF',
  'SALE',
] as const;

/** Max lines (variants) in one stock document. */
export const MAX_OPERATION_LINES = 100;

const lines = (qty: Joi.NumberSchema) =>
  Joi.array()
    .items(Joi.object({ variantId: ID.required(), qty: qty.required() }))
    .min(1)
    .max(MAX_OPERATION_LINES)
    .unique('variantId')
    .required();

const SIGNED_QTY = Joi.number().integer().min(-1_000_000).max(1_000_000).invalid(0);

export const receiptSchema = {
  body: Joi.object({
    warehouseId: ID.required(),
    lines: lines(QTY),
    reference: Joi.string().trim().min(1).max(80),
    reason: Joi.string().trim().max(500),
  }),
};

/** Damage and write-off: positive units, reason required. */
export const movementSchema = {
  body: Joi.object({ warehouseId: ID.required(), lines: lines(QTY), reason: REASON.required() }),
};

export const adjustmentSchema = {
  body: Joi.object({
    warehouseId: ID.required(),
    lines: lines(SIGNED_QTY),
    reason: REASON.required(),
  }),
};

export const decisionSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };

const levelParams = Joi.object({ warehouseId: ID.required(), variantId: ID.required() });

export const levelSchema = { params: levelParams };

export const thresholdsSchema = {
  params: levelParams,
  body: Joi.object({
    reorderLevel: Joi.number().integer().min(0).max(1_000_000),
    safetyStock: Joi.number().integer().min(0).max(1_000_000),
    reason: REASON.required(),
  })
    .or('reorderLevel', 'safetyStock')
    .messages({ 'object.missing': 'set reorderLevel and/or safetyStock' }),
};

export const listLevelsSchema = {
  querystring: Joi.object({
    ...PAGE,
    warehouseId: ID,
    variantId: ID,
    lowStock: Joi.boolean(),
  }),
};

export const listOperationsSchema = {
  querystring: Joi.object({
    ...PAGE,
    warehouseId: ID,
    type: Joi.string().valid(...OPERATION_TYPES),
    status: Joi.string().valid(...OPERATION_STATUSES),
  }),
};

export const getOperationSchema = idParams;

export const listLedgerSchema = {
  querystring: Joi.object({
    ...PAGE,
    warehouseId: ID,
    variantId: ID,
    type: Joi.string().valid(...LEDGER_TYPES),
    from: Joi.date().iso(),
    to: Joi.date().iso().greater(Joi.ref('from')),
  }),
};
