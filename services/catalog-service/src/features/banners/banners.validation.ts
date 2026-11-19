import { DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

import { ACTION_TYPES } from './banners.types.js';

/** `If-Match: 3`, `"3"` or `W/"3"` → 3. Anything else is ignored (no check). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
const REASON = Joi.string().trim().min(10).max(500).required();
/** Upper-case key: `farmer` → `FARMER`, `hero_slider` → `HERO_SLIDER`. */
const KEY = (max: number) =>
  Joi.string()
    .trim()
    .uppercase()
    .min(2)
    .max(max)
    .pattern(/^[A-Z][A-Z0-9_]*$/)
    .messages({ 'string.pattern.base': 'must be letters, digits and underscores (A_Z)' });
const CODE = KEY(60).min(3);
const RATIO = Joi.string()
  .pattern(/^\d{1,3}:\d{1,3}$/)
  .messages({ 'string.pattern.base': 'must look like 16:9' });
const MAX_ITEMS = Joi.number().integer().min(1).max(20);
const IMAGE = Joi.string()
  .uri({ scheme: ['https'] })
  .max(500);
const SORT_ORDER = Joi.number().integer().min(0).max(1_000_000);
const PAGE = {
  cursor: ID,
  limit: Joi.number().integer().min(1).max(MAX_PAGE_LIMIT).default(DEFAULT_PAGE_LIMIT),
};

/** actionTarget shape depends on actionType (NONE → must be absent/null). */
const ACTION_TARGET = Joi.when('actionType', {
  switch: [
    { is: Joi.valid('PRODUCT', 'CATEGORY', 'BRAND').required(), then: ID.required() },
    {
      is: 'EXTERNAL_URL',
      then: Joi.string()
        .uri({ scheme: ['https'] })
        .max(500)
        .required(),
    },
    {
      is: 'DEEP_LINK',
      then: Joi.string()
        .max(500)
        .pattern(/^farmx:\/\/[\w\-./?=&%]+$/)
        .required()
        .messages({ 'string.pattern.base': 'must be a farmx:// deep link' }),
    },
    { is: 'NONE', then: Joi.valid(null).default(null) },
  ],
  otherwise: Joi.forbidden(),
});

// ── Public ──

export const publicListSchema = {
  querystring: Joi.object({ app: KEY(30).required(), page: KEY(40), position: KEY(40) }),
};

export const codeParamsSchema = { params: Joi.object({ code: CODE.required() }) };

// ── Shared admin ──

export const idParamsSchema = { params: Joi.object({ id: ID.required() }) };

export const historySchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object(PAGE),
};

export const statusSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ isActive: Joi.boolean().required(), reason: REASON }),
};

export const deleteSchema = {
  params: Joi.object({ id: ID.required() }),
  querystring: Joi.object({ reason: REASON }),
};

// ── Placements ──

const PLACEMENT_FIELDS = {
  name: Joi.string().trim().min(2).max(100),
  app: KEY(30),
  page: KEY(40),
  position: KEY(40),
  aspectRatio: RATIO,
  maxItems: MAX_ITEMS,
  isActive: Joi.boolean(),
};

export const placementListSchema = {
  querystring: Joi.object({
    app: KEY(30),
    page: KEY(40),
    position: KEY(40),
    isActive: Joi.boolean(),
    q: Joi.string().trim().min(1).max(60),
    ...PAGE,
  }),
};

export const createPlacementSchema = {
  body: Joi.object({
    ...PLACEMENT_FIELDS,
    code: CODE.required(),
    name: PLACEMENT_FIELDS.name.required(),
    app: KEY(30).required(),
    page: KEY(40).required(),
    position: KEY(40).required(),
    aspectRatio: RATIO.required(),
    reason: REASON,
  }),
};

export const updatePlacementSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ ...PLACEMENT_FIELDS, reason: REASON }).min(2),
};

// ── Banners ──

const BANNER_FIELDS = {
  placementId: ID,
  title: Joi.string().trim().min(2).max(120),
  subtitle: Joi.string().trim().max(250).allow(null, ''),
  imageUrl: IMAGE,
  mobileImageUrl: IMAGE.allow(null),
  actionType: Joi.string().valid(...ACTION_TYPES),
  actionTarget: ACTION_TARGET,
  sortOrder: SORT_ORDER,
  isActive: Joi.boolean(),
  startDate: Joi.date().iso().allow(null),
  endDate: Joi.date()
    .iso()
    .allow(null)
    .when('startDate', {
      is: Joi.date().required(),
      then: Joi.date().greater(Joi.ref('startDate')),
    }),
};

export const bannerListSchema = {
  querystring: Joi.object({
    placementId: ID,
    isActive: Joi.boolean(),
    state: Joi.string().valid('LIVE', 'SCHEDULED', 'EXPIRED', 'INACTIVE'),
    q: Joi.string().trim().min(1).max(120),
    ...PAGE,
  }),
};

export const createBannerSchema = {
  body: Joi.object({
    ...BANNER_FIELDS,
    placementId: ID.required(),
    title: BANNER_FIELDS.title.required(),
    imageUrl: IMAGE.required(),
    actionType: BANNER_FIELDS.actionType.default('NONE'),
    reason: REASON,
  }),
};

/** actionType and actionTarget change together (the pair is validated as one). */
export const updateBannerSchema = {
  params: Joi.object({ id: ID.required() }),
  body: Joi.object({ ...BANNER_FIELDS, reason: REASON })
    .min(2)
    .and('actionType', 'actionTarget')
    .messages({ 'object.and': 'send actionType and actionTarget together' }),
};

export const reorderSchema = {
  body: Joi.object({
    placementId: ID.required(),
    ids: Joi.array().items(ID).min(1).max(100).unique().required(),
    reason: REASON,
  }),
};
