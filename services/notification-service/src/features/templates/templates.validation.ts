import Joi from 'joi';

import { CHANNELS } from '../../domain.js';
import { REASON, idParams } from '../../middleware/http.js';

const KEY = Joi.string()
  .max(80)
  .pattern(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/)
  .messages({ 'string.pattern.base': 'must be dotted lower-case, e.g. order.confirmed' });

const variable = Joi.object({
  name: Joi.string()
    .pattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/)
    .required(),
  type: Joi.string().valid('string', 'number', 'money', 'date').required(),
  required: Joi.boolean(),
  maxLength: Joi.number().integer().min(1).max(2000),
});

const content = {
  title: Joi.string().max(200).allow(null),
  body: Joi.string().trim().min(1).max(4000),
  htmlBody: Joi.string().max(100_000).allow(null),
  description: Joi.string().max(300).allow(null),
};

export const listTemplatesSchema = {
  querystring: Joi.object({
    key: KEY,
    channel: Joi.string().valid(...CHANNELS),
    active: Joi.boolean().description('Only the active version of each family'),
  }),
};

export const templateIdSchema = idParams;

export const createTemplateSchema = {
  body: Joi.object({
    key: KEY.required(),
    channel: Joi.string()
      .valid(...CHANNELS)
      .required(),
    locale: Joi.string().valid('en', 'hi').default('en'),
    ...content,
    body: content.body.required(),
    variables: Joi.array().items(variable).max(20).unique('name').default([]),
    reason: REASON.required(),
  }),
};

export const newVersionSchema = {
  ...idParams,
  body: Joi.object({
    ...content,
    body: content.body.required(),
    activate: Joi.boolean().default(true),
    reason: REASON.required(),
  }),
};

export const activateSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };

export const previewSchema = {
  ...idParams,
  body: Joi.object({
    vars: Joi.object()
      .pattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, [Joi.string().max(2000), Joi.number()])
      .max(20)
      .default({}),
  }),
};
