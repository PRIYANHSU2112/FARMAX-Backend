import Joi from 'joi';

import { ID } from '../../middleware/http.js';

const line = Joi.object({
  variantId: ID.required(),
  qty: Joi.number().integer().min(1).max(10_000).required(),
});

const base = {
  farmId: ID.required(),
  lines: Joi.array()
    .items(line)
    .min(1)
    .max(100)
    .unique('variantId')
    .required()
    .messages({ 'array.unique': 'each variantId may appear once (add to qty instead)' }),
  paymentMethod: Joi.string().valid('UPI', 'CARD', 'NETBANKING'),
  bankCode: Joi.string()
    .trim()
    .uppercase()
    .pattern(/^[A-Z0-9_]{2,20}$/),
  cardBin: Joi.string().pattern(/^\d{6,8}$/),
  couponCode: Joi.string().trim().uppercase().max(30).allow(''),
  applyBundleIds: Joi.array().items(ID).max(10).unique(),
};

export const offersSchema = { body: Joi.object(base) };

export const previewSchema = {
  body: Joi.object({ ...base, billToGst: Joi.boolean().default(true) }),
};
