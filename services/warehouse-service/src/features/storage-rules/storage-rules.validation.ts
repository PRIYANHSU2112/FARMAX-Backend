import Joi from 'joi';

import { ID, VERSION } from '../../middleware/http.js';
import { RULE_TYPES } from './storage-rules.types.js';

const wh = { id: ID.required() };
const CATS = Joi.array().items(ID).max(50).unique();

const fields = {
  name: Joi.string().trim().min(2).max(80),
  subjectCategoryIds: CATS.min(1).description('Product types the rule is about (catalog ids)'),
  keepAwayCategoryIds: CATS.description('"Cannot be stored with" (catalog ids)'),
  allowedZoneId: ID.allow(null),
  minDistance: Joi.number().min(0).max(10_000).precision(2).allow(null),
  minDistanceUnit: Joi.string().valid('METRES', 'FEET').default('METRES'),
  notes: Joi.string().trim().max(500).allow(null, ''),
  status: Joi.string().valid('ACTIVE', 'INACTIVE'),
};

export const listRulesSchema = {
  params: Joi.object(wh),
  querystring: Joi.object({ type: Joi.string().valid(...RULE_TYPES) }),
};

export const summarySchema = { params: Joi.object(wh) };

export const createRuleSchema = {
  params: Joi.object(wh),
  body: Joi.object({
    ...fields,
    type: Joi.string()
      .valid(...RULE_TYPES)
      .required(),
    name: fields.name.required(),
    subjectCategoryIds: fields.subjectCategoryIds.required(),
  }),
};

export const updateRuleSchema = {
  params: Joi.object({ ...wh, ruleId: ID.required() }),
  body: Joi.object({ ...fields, expectedVersion: VERSION.required() }).or(
    'name',
    'subjectCategoryIds',
    'keepAwayCategoryIds',
    'allowedZoneId',
    'minDistance',
    'notes',
    'status',
  ),
};

export const ruleParams = { params: Joi.object({ ...wh, ruleId: ID.required() }) };
