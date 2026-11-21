import Joi from 'joi';

import { ID, REASON, SLUG } from '../../middleware/http.js';

const NAME = Joi.string().trim().min(2).max(80);
const DISEASE_SLUG = SLUG.max(100);
const DESCRIPTION = Joi.string().trim().max(500).allow(null, '');
const ICON_URL = Joi.string()
  .trim()
  .uri({ scheme: ['https', 'http'] })
  .max(500)
  .allow(null);
const SORT = Joi.number().integer().min(0).max(1_000_000);

export const publicListSchema = {
  querystring: Joi.object({
    hideEmpty: Joi.boolean().description(
      'true = leave out diseases with no storefront-visible product (Shop by Problem cards).',
    ),
  }),
};

export const adminListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(80).description('Search name or slug.'),
    isActive: Joi.boolean().description('Active flag.'),
  }),
};

export const createSchema = {
  body: Joi.object({
    name: NAME.required(),
    slug: DISEASE_SLUG,
    description: DESCRIPTION,
    iconUrl: ICON_URL,
    iconMediaId: ID.allow(null),
    sortOrder: SORT,
    isActive: Joi.boolean(),
    reason: REASON,
  }),
};

export const updateSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({
    name: NAME,
    slug: DISEASE_SLUG,
    description: DESCRIPTION,
    iconUrl: ICON_URL,
    iconMediaId: ID.allow(null),
    sortOrder: SORT,
    isActive: Joi.boolean(),
    reason: REASON,
  }).min(2),
};
