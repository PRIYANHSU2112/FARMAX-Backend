import Joi from 'joi';

import { VERSION, idParams } from '../../middleware/http.js';

const fields = {
  name: Joi.string().trim().min(2).max(120),
  accreditation: Joi.string().trim().max(120).allow(null),
  type: Joi.string().valid('IN_HOUSE', 'EXTERNAL'),
  tatDays: Joi.number().integer().min(1).max(60),
  contactName: Joi.string().trim().max(120).allow(null),
  contactPhone: Joi.string()
    .trim()
    .pattern(/^\+?[0-9]{7,15}$/)
    .allow(null),
  contactEmail: Joi.string().trim().email({ tlds: false }).max(254).allow(null),
  address: Joi.string().trim().max(300).allow(null),
  status: Joi.string().valid('ACTIVE', 'INACTIVE'),
};

export const listSchema = { querystring: Joi.object({ status: fields.status }) };
export const getSchema = idParams;
export const createSchema = {
  body: Joi.object({
    code: Joi.string()
      .trim()
      .uppercase()
      .pattern(/^[A-Z0-9-]{2,20}$/)
      .required(),
    ...fields,
    name: fields.name.required(),
    type: fields.type.required(),
  }),
};
export const updateSchema = {
  ...idParams,
  body: Joi.object({ ...fields, expectedVersion: VERSION.required() }).min(2),
};
