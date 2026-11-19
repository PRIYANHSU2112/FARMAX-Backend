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

export const reserveSchema = {
  body: Joi.object({
    orderRef: Joi.string().trim().min(1).max(64).required(),
    pinCode: PIN_CODE.required(),
    lines: LINES,
    ttlSeconds: Joi.number().integer().min(60).max(3_600),
  }),
};

export const availabilitySchema = {
  body: Joi.object({ pinCode: PIN_CODE.required(), lines: LINES }),
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
