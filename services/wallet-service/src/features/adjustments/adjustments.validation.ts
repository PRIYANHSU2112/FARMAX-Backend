import Joi from 'joi';

import { ID, PAGE, idParams } from '../../middleware/http.js';

const REASON = Joi.string().trim().min(10).max(500);

export const createAdjustmentSchema = {
  body: Joi.object({
    userId: ID.required(),
    ledger: Joi.string().valid('WALLET', 'POINTS').required(),
    direction: Joi.string().valid('CREDIT', 'DEBIT').required(),
    /** Paise (WALLET) or points (POINTS). */
    amount: Joi.number().integer().min(1).max(1_000_000_000).required(),
    category: Joi.string()
      .valid('GOODWILL', 'DAMAGE_CLAIM', 'LOYALTY_BONUS', 'CORRECTION')
      .required(),
    title: Joi.string().trim().min(3).max(120).required(),
    reason: REASON.required(),
  }),
};

export const approveSchema = {
  ...idParams,
  body: Joi.object({ reason: REASON }).default({}),
};

export const rejectSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };

export const getAdjustmentSchema = idParams;

export const listAdjustmentsSchema = {
  querystring: Joi.object({
    ...PAGE,
    status: Joi.string().valid('PENDING_APPROVAL', 'POSTED', 'REJECTED'),
    userId: ID,
  }),
};
