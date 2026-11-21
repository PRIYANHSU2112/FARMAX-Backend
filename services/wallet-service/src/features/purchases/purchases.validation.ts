import Joi from 'joi';

import { ID } from '../../middleware/http.js';

const PAISE = Joi.number().integer().min(1).max(1_000_000_000);

export const debitSchema = {
  body: Joi.object({
    paymentId: ID.required(),
    userId: ID.required(),
    orderId: ID.required(),
    orderNo: Joi.string().trim().min(3).max(24).required(),
    amountPaise: PAISE.required(),
  }),
};

export const debitStatusSchema = { params: Joi.object({ paymentId: ID.required() }) };

export const creditSchema = {
  body: Joi.object({
    refundId: ID.required(),
    paymentId: ID.required(),
    userId: ID.required(),
    amountPaise: PAISE.required(),
    reason: Joi.string().trim().min(3).max(300).required(),
  }),
};

export const balanceSchema = { params: Joi.object({ userId: ID.required() }) };
