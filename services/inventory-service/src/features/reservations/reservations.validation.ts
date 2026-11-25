import Joi from 'joi';

import { ID, PAGE, PIN_CODE, QTY, REASON, idParams } from '../../middleware/http.js';

export const RESERVATION_STATUSES = [
  'ACTIVE',
  'COMMITTED',
  'ISSUED',
  'RELEASED',
  'EXPIRED',
  'REJECTED',
] as const;

const LINES = Joi.array()
  .items(Joi.object({ variantId: ID.required(), qty: QTY.required() }))
  .min(1)
  .max(200)
  .unique('variantId')
  .required();

/** D-57b routing facts (optional; rules on value, district, distance). */
const ROUTING = Joi.object({
  orderValue: Joi.number().min(0).allow(null),
  district: Joi.string().trim().max(80).allow(null),
  stateCode: Joi.string().trim().max(4).allow(null),
  lat: Joi.number().min(-90).max(90).allow(null),
  lng: Joi.number().min(-180).max(180).allow(null),
});

export const reserveSchema = {
  body: Joi.object({
    orderRef: Joi.string().trim().min(1).max(64).required(),
    pinCode: PIN_CODE.required(),
    lines: LINES,
    ttlSeconds: Joi.number().integer().min(60).max(3_600),
    routing: ROUTING,
  }),
};

export const availabilitySchema = {
  body: Joi.object({ pinCode: PIN_CODE.required(), lines: LINES, routing: ROUTING }),
};

export const getReservationSchema = idParams;

export const byOrderRefSchema = {
  querystring: Joi.object({ orderRef: Joi.string().trim().min(1).max(64).required() }),
};

export const listReservationsSchema = {
  querystring: Joi.object({
    ...PAGE,
    status: Joi.string().valid(...RESERVATION_STATUSES),
    orderRef: Joi.string().trim().max(64),
  }),
};

export const releaseSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };

/** D-57b internal: warehouse reallocation (idempotent by `key`). */
export const reallocateSchema = {
  ...idParams,
  body: Joi.object({
    key: Joi.string().trim().min(8).max(80).required(),
    moves: Joi.array()
      .items(
        Joi.object({
          variantId: ID.required(),
          fromWarehouseId: ID.required(),
          toWarehouseId: ID.required(),
          qty: Joi.number().integer().min(1).max(1_000_000).required(),
        }),
      )
      .min(1)
      .max(200)
      .required(),
  }),
};

/** D-57b internal: held lines per warehouse (allocation reconcile). */
export const openLinesSchema = {
  querystring: Joi.object({
    warehouseId: ID.required(),
    cursor: Joi.string().max(80),
    limit: Joi.number().integer().min(1).max(500).default(200),
  }),
};
