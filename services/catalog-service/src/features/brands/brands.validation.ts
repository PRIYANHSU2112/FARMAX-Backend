import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
const SLUG = Joi.string()
  .lowercase()
  .max(100)
  .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .messages({ 'string.pattern.base': 'must be lower-case letters, digits and single hyphens' });
const REASON = Joi.string().trim().min(10).max(500).required();
const NAME = Joi.string().trim().min(2).max(80);
/** Stored upper-case: `zoetis` → `ZOETIS`. */
const CODE = Joi.string()
  .trim()
  .uppercase()
  .min(2)
  .max(20)
  .pattern(/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/)
  .messages({ 'string.pattern.base': 'must be letters, digits and single hyphens' });
const DESCRIPTION = Joi.string().trim().max(1000).allow(null, '');
const URL = Joi.string()
  .uri({ scheme: ['https', 'http'] })
  .max(500)
  .allow(null);
const COUNTRY = Joi.string()
  .uppercase()
  .length(2)
  .pattern(/^[A-Z]{2}$/)
  .allow(null)
  .messages({ 'string.pattern.base': 'must be an ISO 3166-1 alpha-2 code (e.g. IN)' });
const SORT_ORDER = Joi.number().integer().min(0).max(1_000_000);
const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};

const SLUG_OR_ID = Joi.alternatives().try(ID, SLUG).required();

export const publicListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(80),
    isFeatured: Joi.boolean(),
    ...PAGE,
  }),
};

export const slugOrIdParamsSchema = { params: Joi.object({ slugOrId: SLUG_OR_ID }) };

export const adminListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(1).max(80),
    isFeatured: Joi.boolean(),
    isActive: Joi.boolean(),
    ...PAGE,
  }),
};

export const idParamsSchema = { params: Joi.object({ id: ID.required() }) };

export const historySchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object(PAGE),
};

const FIELDS = {
  name: NAME,
  slug: SLUG,
  code: CODE,
  description: DESCRIPTION,
  logoUrl: URL,
  bannerUrl: URL,
  websiteUrl: URL,
  countryOfOrigin: COUNTRY,
  isFeatured: Joi.boolean(),
  isActive: Joi.boolean(),
  sortOrder: SORT_ORDER,
};

export const createSchema = {
  body: Joi.object({ ...FIELDS, name: NAME.required(), code: CODE.required(), reason: REASON }),
};

export const updateSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ ...FIELDS, reason: REASON }).min(2),
};

export const statusSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ isActive: Joi.boolean(), isFeatured: Joi.boolean(), reason: REASON }).or(
    'isActive',
    'isFeatured',
  ),
};

export const deleteSchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object({ reason: REASON }),
};

/** `If-Match: 3`, `"3"` or `W/"3"` → 3. Anything else is ignored (no check). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};
