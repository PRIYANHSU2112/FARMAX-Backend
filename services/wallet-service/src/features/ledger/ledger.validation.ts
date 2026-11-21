import Joi from 'joi';

import { PAGE } from '../../middleware/http.js';

export const CATEGORIES = ['TOPUPS', 'PURCHASES', 'REFUNDS', 'REWARDS', 'ADJUSTMENTS'] as const;
export const KINDS = [
  'TOPUP',
  'ORDER_DEBIT',
  'REFUND_CREDIT',
  'POINTS_CONVERSION',
  'ADJUSTMENT_CREDIT',
  'ADJUSTMENT_DEBIT',
  'REVERSAL',
] as const;

/** ISO date or date-time; `to` is exclusive. */
const RANGE = {
  from: Joi.date().iso(),
  to: Joi.date()
    .iso()
    .when('from', { is: Joi.exist(), then: Joi.date().greater(Joi.ref('from')) }),
};

export const transactionsSchema = {
  querystring: Joi.object({
    ...PAGE,
    category: Joi.string().valid(...CATEGORIES),
    ...RANGE,
  }),
};

export const transactionCountsSchema = { querystring: Joi.object({ ...RANGE }) };

export const transactionSchema = {
  params: Joi.object({
    id: Joi.string()
      .guid({ version: ['uuidv7', 'uuidv4'] })
      .required(),
  }),
};
