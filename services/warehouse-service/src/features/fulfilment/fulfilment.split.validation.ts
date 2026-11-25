import Joi from 'joi';

import { ID, REASON, VERSION } from '../../middleware/http.js';
import { PAGING } from '../../middleware/paging.js';

const DATE = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}$/);
const QTY = Joi.object({
  variantId: ID.required(),
  qty: Joi.number().integer().min(1).max(1_000_000).required(),
});
const LEG = Joi.object({
  warehouseId: ID.required(),
  lines: Joi.array().items(QTY).min(1).max(200).unique('variantId').required(),
  plannedAt: Joi.date().iso().allow(null),
});
const BACKORDER = QTY.keys({ promiseDate: DATE.allow(null) });

export const orderParams = { params: Joi.object({ orderId: ID.required() }) };
export const proposalQuery = {
  ...orderParams,
  querystring: Joi.object({
    strategy: Joi.string().valid('LEAST_COST', 'NEAREST', 'FEWEST_SPLITS').default('NEAREST'),
  }),
};

const PLAN = {
  legs: Joi.array().items(LEG).min(1).max(10).unique('warehouseId').required(),
  backorders: Joi.array().items(BACKORDER).max(200).default([]),
  consentLogged: Joi.boolean(),
};
export const previewSchema = { ...orderParams, body: Joi.object(PLAN) };
export const splitSchema = {
  ...orderParams,
  body: Joi.object({
    ...PLAN,
    notifyCustomer: Joi.boolean().default(true),
    reason: REASON.required(),
  }),
};
export const rerouteSchema = {
  ...orderParams,
  body: Joi.object({ warehouseId: ID.required(), reason: REASON.required() }),
};
export const partialSchema = {
  ...orderParams,
  body: Joi.object({
    shipmentId: ID.required(),
    lines: Joi.array()
      .items(
        Joi.object({
          variantId: ID.required(),
          shipQty: Joi.number().integer().min(0).max(1_000_000).required(),
        }),
      )
      .min(1)
      .max(200)
      .unique('variantId')
      .required(),
    remainder: Joi.string().valid('BACKORDER', 'CANCEL').required(),
    promiseDate: DATE.allow(null),
    consentLogged: Joi.boolean(),
    reason: REASON.required(),
  }),
};

export const backordersQuery = {
  querystring: Joi.object({
    status: Joi.string().valid('OPEN', 'ALLOCATED', 'CANCELLED'),
    warehouseId: ID,
    orderId: ID,
    variantId: ID,
    ...PAGING,
  }).oxor('cursor', 'page'),
};
export const backorderParams = { params: Joi.object({ id: ID.required() }) };
export const backorderPatchSchema = {
  ...backorderParams,
  body: Joi.object({
    promiseDate: DATE.allow(null),
    note: Joi.string().trim().max(300).allow(null, ''),
    expectedVersion: VERSION.required(),
  }).or('promiseDate', 'note'),
};
export const backorderCancelSchema = {
  ...backorderParams,
  body: Joi.object({ reason: REASON.required() }),
};

export const slotsQuery = {
  querystring: Joi.object({
    warehouseId: ID.required(),
    days: Joi.number().integer().min(1).max(14).default(3),
  }),
};

// ── W3.15 amendments ──
const DELIVERY = Joi.object({
  contactName: Joi.string().trim().min(2).max(120),
  contactPhone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{10,13}$/),
  line1: Joi.string().trim().min(2).max(200),
  line2: Joi.string().trim().max(200).allow(null, ''),
  landmark: Joi.string().trim().max(120).allow(null, ''),
  village: Joi.string().trim().max(80).allow(null, ''),
  mandal: Joi.string().trim().max(80).allow(null, ''),
  district: Joi.string().trim().min(2).max(80),
  pinCode: Joi.string().pattern(/^[1-9][0-9]{5}$/),
  latitude: Joi.number().min(-90).max(90).allow(null),
  longitude: Joi.number().min(-180).max(180).allow(null),
  deliveryPromise: DATE.allow(null),
}).min(1);
const AMEND_LINES = Joi.array()
  .items(
    Joi.object({
      variantId: ID.required(),
      qty: Joi.number().integer().min(0).max(1_000_000).required(),
    }),
  )
  .min(1)
  .max(200)
  .unique('variantId');
export const quoteSchema = {
  ...orderParams,
  body: Joi.object({ delivery: DELIVERY, lines: AMEND_LINES }).or('delivery', 'lines'),
};
export const amendSchema = {
  ...orderParams,
  body: Joi.object({
    delivery: DELIVERY,
    lines: AMEND_LINES,
    reason: Joi.string().trim().min(10).max(500).required(),
  }).or('delivery', 'lines'),
};
export const shipmentParams = { params: Joi.object({ id: ID.required() }) };
