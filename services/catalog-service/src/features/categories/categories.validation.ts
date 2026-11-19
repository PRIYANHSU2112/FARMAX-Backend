import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const SLUG = Joi.string()
  .lowercase()
  .max(100)
  .pattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .messages({ 'string.pattern.base': 'must be lower-case letters, digits and single hyphens' });
export const REASON = Joi.string().trim().min(10).max(500).required();
const NAME = Joi.string().trim().min(2).max(80);
const NAME_TE = Joi.string().trim().min(1).max(120).allow(null);
const DESCRIPTION = Joi.string().trim().max(1000).allow(null, '');
const IMAGE_URL = Joi.string()
  .uri({ scheme: ['https', 'http'] })
  .max(500)
  .allow(null);
const SORT_ORDER = Joi.number().integer().min(0).max(1_000_000);
const PARENT_ID = ID.allow(null);
const LEVELS = Joi.number().integer().min(1).max(20);

export const treeSchema = { querystring: Joi.object({ maxDepth: LEVELS }) };

export const slugParamsSchema = { params: Joi.object({ slug: SLUG.required() }) };

export const subcategoriesSchema = {
  params: Joi.object({ slug: SLUG.required() }),
  querystring: Joi.object({ maxDepth: LEVELS.default(1) }),
};

export const adminListSchema = {
  querystring: Joi.object({
    parentId: Joi.alternatives().try(Joi.string().valid('root'), ID),
    q: Joi.string().trim().min(1).max(80),
    isActive: Joi.boolean(),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const idParamsSchema = { params: Joi.object({ id: ID.required() }) };

export const historySchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object({
    cursor: ID,
    limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const createSchema = {
  body: Joi.object({
    parentId: PARENT_ID,
    name: NAME.required(),
    nameTe: NAME_TE,
    slug: SLUG,
    description: DESCRIPTION,
    imageUrl: IMAGE_URL,
    sortOrder: SORT_ORDER,
    isActive: Joi.boolean(),
    reason: REASON,
  }),
};

export const updateSchema = {
  params: Joi.object({ id: ID.required() }),
  // Parent changes go through /move (subtree rewrite); everything else is editable here.
  body: Joi.object({
    name: NAME,
    nameTe: NAME_TE,
    slug: SLUG,
    description: DESCRIPTION,
    imageUrl: IMAGE_URL,
    sortOrder: SORT_ORDER,
    isActive: Joi.boolean(),
    reason: REASON,
  }).min(2),
};

export const moveSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({
    parentId: PARENT_ID.required(),
    sortOrder: SORT_ORDER,
    reason: REASON,
  }),
};

export const reorderSchema = {
  body: Joi.object({
    parentId: PARENT_ID.required(),
    orderedIds: Joi.array().items(ID.required()).min(1).max(500).unique().required(),
    reason: REASON,
  }),
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
