import Joi from 'joi';

import { ID, PAGE, REASON, VERSION } from '../../middleware/http.js';

const variantParams = { params: Joi.object({ variantId: ID.required() }) };

const param = Joi.object({
  code: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9_]{2,40}$/)
    .required(),
  name: Joi.string().trim().min(2).max(120).required(),
  unit: Joi.string().trim().max(30).allow(null, ''),
  rule: Joi.string().valid('MIN', 'MAX', 'RANGE', 'TEXT').required(),
  min: Joi.number().allow(null),
  max: Joi.number().allow(null),
  expectedText: Joi.string().trim().max(120).allow(null),
  critical: Joi.boolean().default(false),
});

export const listSchema = {
  querystring: Joi.object({ q: Joi.string().trim().max(80), ...PAGE, cursor: ID }),
};
export const getSchema = variantParams;
export const putSchema = {
  ...variantParams,
  body: Joi.object({
    releaseMode: Joi.string().valid('MANUFACTURER_COA', 'INDEPENDENT_COA').required(),
    sampleOnReceipt: Joi.boolean().default(true),
    sampleQty: Joi.number().integer().min(1).max(10_000).default(3),
    sampleUnit: Joi.string().trim().max(20).default('units'),
    defaultLabId: ID.allow(null),
    coaValidityDays: Joi.number().integer().min(1).max(3650).allow(null),
    isActive: Joi.boolean().default(true),
    params: Joi.array().items(param).max(60).required(),
    reason: REASON.required(),
    expectedVersion: VERSION.required(),
  }),
};
