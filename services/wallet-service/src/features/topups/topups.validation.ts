import Joi from 'joi';

import { idParams } from '../../middleware/http.js';

export const TOPUP_METHODS = ['UPI', 'NETBANKING', 'CARD'] as const;

export const createTopupSchema = {
  body: Joi.object({
    /** Integer paise; the business range comes from wallet settings (422 AMOUNT_OUT_OF_RANGE). */
    amountPaise: Joi.number().integer().min(1).max(100_000_000).required(),
    method: Joi.string()
      .valid(...TOPUP_METHODS)
      .required(),
  }),
};

export const getTopupSchema = idParams;
