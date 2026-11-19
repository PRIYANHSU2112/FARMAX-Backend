import Joi from 'joi';

import { ID, REASON } from '../../middleware/http.js';
import { ATTRIBUTE_DATA_TYPES, DOC_TYPES, DRUG_SCHEDULES } from './attributes.types.js';

const KEY = Joi.string()
  .trim()
  .min(2)
  .max(60)
  .pattern(/^[a-z][a-zA-Z0-9]*$/)
  .messages({
    'string.pattern.base': 'must be camelCase (letters and digits, starting lower-case)',
  });
const LABEL = Joi.string().trim().min(1).max(80);
const UNIT = Joi.string().trim().max(20).allow(null);
const OPTIONS = Joi.array().items(Joi.string().trim().min(1).max(80)).max(100).unique();
const SORT = Joi.number().integer().min(0).max(1_000_000);

export const categoryQuerySchema = { querystring: Joi.object({ categoryId: ID.required() }) };

export const createAttributeSchema = {
  body: Joi.object({
    categoryId: ID.required(),
    key: KEY.required(),
    label: LABEL.required(),
    dataType: Joi.string()
      .valid(...ATTRIBUTE_DATA_TYPES)
      .required(),
    unit: UNIT,
    options: OPTIONS,
    isRequired: Joi.boolean(),
    isFilterable: Joi.boolean(),
    sortOrder: SORT,
    reason: REASON,
  }),
};

export const updateAttributeSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({
    label: LABEL,
    unit: UNIT,
    options: OPTIONS,
    isRequired: Joi.boolean(),
    isFilterable: Joi.boolean(),
    sortOrder: SORT,
    reason: REASON,
  }).min(2),
};

export const categoryParamsSchema = { params: Joi.object({ categoryId: ID.required() }) };

export const putProfileSchema = {
  params: Joi.object({ categoryId: ID.required() }),
  body: Joi.object({
    requiresRegistration: Joi.boolean(),
    requiresDrugLicense: Joi.boolean(),
    requiresManufacturingLicense: Joi.boolean(),
    requiresWithdrawal: Joi.boolean(),
    requiresColdChain: Joi.boolean(),
    requiredDocTypes: Joi.array()
      .items(Joi.string().valid(...DOC_TYPES))
      .unique(),
    allowedSchedules: Joi.array()
      .items(Joi.string().valid(...DRUG_SCHEDULES))
      .unique(),
    reason: REASON,
  }).min(2),
};
