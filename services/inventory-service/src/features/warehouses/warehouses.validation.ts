import Joi from 'joi';

import { PAGE, PIN_CODE, REASON, idParams } from '../../middleware/http.js';

export const WAREHOUSE_TYPES = ['MOTHER', 'DEPOT'] as const;

/** Max PIN codes one warehouse may serve (one PUT replaces the whole list). */
export const MAX_COVERAGE = 5_000;

const CODE = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z0-9][A-Z0-9_-]{1,19}$/)
  .messages({ 'string.pattern.base': 'must be 2–20 letters, digits, "-" or "_"' });
const STATE_CODE = Joi.string()
  .pattern(/^\d{2}$/)
  .messages({ 'string.pattern.base': 'must be the 2-digit GST state code, e.g. 37' });
const PRIORITY = Joi.number().integer().min(1).max(10_000);
const VERSION = Joi.number().integer().min(0).required();

const fields = {
  name: Joi.string().trim().min(3).max(120),
  type: Joi.string().valid(...WAREHOUSE_TYPES),
  addressLine: Joi.string().trim().min(5).max(250),
  city: Joi.string().trim().min(2).max(80),
  stateCode: STATE_CODE,
  pinCode: PIN_CODE,
  isAllocatable: Joi.boolean(),
  hasColdChain: Joi.boolean(),
  priority: PRIORITY,
};

export const listWarehousesSchema = {
  querystring: Joi.object({
    ...PAGE,
    isActive: Joi.boolean(),
    type: Joi.string().valid(...WAREHOUSE_TYPES),
    q: Joi.string().trim().min(1).max(60),
  }),
};

export const getWarehouseSchema = idParams;

export const createWarehouseSchema = {
  body: Joi.object({
    ...fields,
    code: CODE.required(),
    name: fields.name.required(),
    type: fields.type.required(),
    addressLine: fields.addressLine.required(),
    city: fields.city.required(),
    stateCode: fields.stateCode.required(),
    pinCode: fields.pinCode.required(),
  }),
};

export const updateWarehouseSchema = {
  ...idParams,
  body: Joi.object({ ...fields, expectedVersion: VERSION, reason: REASON })
    .or(...Object.keys(fields))
    .messages({ 'object.missing': 'change at least one field' }),
};

export const warehouseStatusSchema = {
  ...idParams,
  body: Joi.object({
    expectedVersion: VERSION,
    isActive: Joi.boolean().required(),
    reason: REASON.required(),
  }),
};

export const putCoverageSchema = {
  ...idParams,
  body: Joi.object({
    expectedVersion: VERSION,
    entries: Joi.array()
      .items(Joi.object({ pinCode: PIN_CODE.required(), priority: PRIORITY.default(100) }))
      .max(MAX_COVERAGE)
      .unique('pinCode')
      .required(),
    reason: REASON.required(),
  }),
};
