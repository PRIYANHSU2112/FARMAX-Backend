import Joi from 'joi';

import { ID, PAGE, idParams } from '../../middleware/http.js';

export const PAYMENT_STATUSES = [
  'CREATED',
  'PENDING',
  'FAILED',
  'CAPTURED',
  'CANCELLED',
  'EXPIRED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
] as const;

const GATEWAY_ID = Joi.string().trim().pattern(/^[A-Za-z0-9_]{6,64}$/);

export const getPaymentSchema = idParams;

export const verifySchema = {
  ...idParams,
  body: Joi.object({
    providerOrderId: GATEWAY_ID.required(),
    providerPaymentId: GATEWAY_ID.required(),
    signature: Joi.string().trim().pattern(/^[a-f0-9]{64}$/).required(),
  }),
};

export const mockPaySchema = {
  ...idParams,
  body: Joi.object({ method: Joi.string().valid('upi', 'card', 'netbanking') }).default({}),
};

export const createPaymentSchema = {
  body: Joi.object({
    orderId: ID.required(),
    orderNo: Joi.string().trim().min(3).max(24).required(),
    userId: ID.required(),
    /** Integer paise (₹1 … ₹1 crore). */
    amountPaise: Joi.number().integer().min(100).max(1_000_000_000).required(),
    currency: Joi.string().valid('INR').default('INR'),
    expiresAt: Joi.date().iso().required(),
  }),
};

export const cancelSchema = {
  ...idParams,
  body: Joi.object({ reason: Joi.string().trim().min(3).max(300).required() }),
};

export const listPaymentsSchema = {
  querystring: Joi.object({
    ...PAGE,
    status: Joi.string().valid(...PAYMENT_STATUSES),
    orderId: ID,
    userId: ID,
  }),
};
