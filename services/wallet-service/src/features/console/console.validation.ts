import Joi from 'joi';

import { ID, PAGE } from '../../middleware/http.js';
import { CATEGORIES, KINDS } from '../ledger/index.js';

const REASON = Joi.string().trim().min(10).max(500);

export const accountsSchema = {
  querystring: Joi.object({ ...PAGE, status: Joi.string().valid('ACTIVE', 'FROZEN'), userId: ID }),
};

export const accountSchema = { params: Joi.object({ userId: ID.required() }) };

export const freezeSchema = {
  params: Joi.object({ userId: ID.required() }),
  body: Joi.object({ reason: REASON.required() }),
};

export const journalsSchema = {
  querystring: Joi.object({
    ...PAGE,
    userId: ID,
    kind: Joi.string().valid(...KINDS),
    category: Joi.string().valid(...CATEGORIES),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
  }),
};

export const settingSchema = {
  params: Joi.object({
    key: Joi.string()
      .pattern(/^[A-Za-z]{3,60}$/)
      .required(),
  }),
  body: Joi.object({ value: Joi.any().required(), reason: REASON.required() }),
};
