import Joi from 'joi';

import { ID, REASON } from '../../middleware/http.js';
import { LOOKUP_GROUPS } from './lookups.types.js';

const GROUP = Joi.string().valid(...LOOKUP_GROUPS);
const CODE = Joi.string()
  .trim()
  .uppercase()
  .min(1)
  .max(40)
  .pattern(/^[A-Z0-9]+(?:_[A-Z0-9]+)*$/)
  .messages({ 'string.pattern.base': 'must be letters, digits and single underscores' });
const LABEL = Joi.string().trim().min(1).max(80);
const DESCRIPTION = Joi.string().trim().max(300).allow(null, '');
const META = Joi.object().unknown(true).max(20);

export const publicListSchema = { querystring: Joi.object({ group: GROUP }) };

export const adminListSchema = {
  querystring: Joi.object({
    group: GROUP,
    q: Joi.string().trim().min(1).max(80),
    isActive: Joi.boolean(),
  }),
};

export const createSchema = {
  body: Joi.object({
    group: GROUP.required(),
    code: CODE.required(),
    label: LABEL.required(),
    description: DESCRIPTION,
    meta: META,
    isActive: Joi.boolean(),
    sortOrder: Joi.number().integer().min(0).max(1_000_000),
    reason: REASON,
  }),
};

export const updateSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({
    label: LABEL,
    description: DESCRIPTION,
    meta: META,
    isActive: Joi.boolean(),
    sortOrder: Joi.number().integer().min(0).max(1_000_000),
    reason: REASON,
  }).min(2),
};
