import Joi from 'joi';

import {
  DATA_SOURCES,
  FEED_KEYS,
  LANGS,
  LAYOUT_STATUSES,
  PAGES,
  PLATFORMS,
  REF_TYPES,
  USER_TYPES,
  WIDGETS,
} from './home.types.js';

/** `If-Match: 3`, `"3"` or `W/"3"` → 3. Anything else → undefined (writes then answer 428). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};

// ── Primitives (also used by home.widgets.ts) ──

export const ID = Joi.string().guid({ version: ['uuidv7', 'uuidv4'] });
export const CODE = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z][A-Z0-9_]{1,59}$/);
export const REGION = Joi.string()
  .trim()
  .uppercase()
  .pattern(/^[A-Z]{2,3}$/);
export const SECTION_KEY = Joi.string()
  .trim()
  .lowercase()
  .pattern(/^[a-z][a-z0-9-]{1,59}$/)
  .messages({ 'string.pattern.base': 'must be a slug like `featured` or `flash-deals`' });
export const SEMVER = Joi.string().pattern(/^\d{1,4}(\.\d{1,4}){0,2}$/);
const PHONE = Joi.string()
  .trim()
  .pattern(/^\+?[0-9]{8,15}$/);
const REASON = Joi.string().trim().min(10).max(500).required();

/** Translatable text: `en` required (fallback), `hi` optional. No other languages. */
export const L = (max: number) =>
  Joi.object({
    en: Joi.string().trim().min(1).max(max).required(),
    hi: Joi.string().trim().min(1).max(max),
  });

/** `farmx://…` or `https://…` (the https host is checked against HOME_LINK_HOSTS in the service). */
export const LINK = Joi.string()
  .trim()
  .max(500)
  .pattern(/^(farmx:\/\/\S+|https:\/\/\S+)$/)
  .messages({ 'string.pattern.base': 'must be a farmx:// deep link or an https:// URL' });

/** Media reference (the https host is checked against HOME_IMAGE_HOSTS in the service). */
export const IMAGE = Joi.object({
  mediaId: ID,
  url: Joi.string()
    .trim()
    .uri({ scheme: ['https'] })
    .max(1000)
    .required(),
  width: Joi.number().integer().min(1).max(10_000),
  height: Joi.number().integer().min(1).max(10_000),
});

const TARGETING = Joi.object({
  platforms: Joi.array()
    .items(Joi.string().valid(...PLATFORMS))
    .unique()
    .min(1),
  userTypes: Joi.array()
    .items(Joi.string().valid(...USER_TYPES))
    .unique()
    .min(1),
  regions: Joi.array().items(REGION).unique().min(1).max(50),
  excludeRegions: Joi.array().items(REGION).unique().min(1).max(50),
  farmTypes: Joi.array().items(CODE).unique().min(1).max(20),
  flockStages: Joi.array().items(CODE).unique().min(1).max(20),
  isNewUser: Joi.boolean(),
  hasActiveOrder: Joi.boolean(),
  segments: Joi.array().items(Joi.string().trim().min(1).max(40)).unique().min(1).max(20),
  activeFrom: Joi.string().isoDate(),
  activeUntil: Joi.string().isoDate(),
  minAppVersion: SEMVER,
  rollout: Joi.object({
    percent: Joi.number().integer().min(1).max(100).required(),
    salt: Joi.string().trim().min(1).max(40).required(),
    offset: Joi.number().integer().min(0).max(99).default(0),
  }).custom((value: { percent: number; offset: number }, helpers) =>
    value.offset + value.percent > 100 ? helpers.error('rollout.range') : value,
  ),
})
  .custom((value: { activeFrom?: string; activeUntil?: string }, helpers) =>
    value.activeFrom !== undefined &&
    value.activeUntil !== undefined &&
    Date.parse(value.activeUntil) <= Date.parse(value.activeFrom)
      ? helpers.error('targeting.window')
      : value,
  )
  .messages({
    'targeting.window': 'activeUntil must be after activeFrom',
    'rollout.range': 'rollout offset + percent must be at most 100',
  });

const ITEM = Joi.object({
  refType: Joi.string()
    .valid(...REF_TYPES)
    .required(),
  refId: ID.allow(null)
    .default(null)
    .when('refType', {
      is: Joi.valid('CATEGORY', 'DISEASE', 'BRAND', 'PRODUCT'),
      then: ID.required(),
    }),
  refCode: CODE.allow(null)
    .default(null)
    .when('refType', { is: 'FLOCK_STAGE', then: CODE.required() }),
  label: L(80).required(),
  subtitle: L(160).allow(null).default(null),
  badge: L(40).allow(null).default(null),
  image: IMAGE.allow(null).default(null),
  deepLink: LINK.required(),
  displayOrder: Joi.number().integer().min(0).max(100_000),
  isEnabled: Joi.boolean().default(true),
  targeting: TARGETING.allow(null).default(null),
});

const SECTION = Joi.object({
  sectionKey: SECTION_KEY.required(),
  widgetType: Joi.string()
    .valid(...WIDGETS)
    .required(),
  dataSource: Joi.string()
    .valid(...DATA_SOURCES)
    .required(),
  feedKey: Joi.string()
    .valid(...FEED_KEYS)
    .allow(null)
    .default(null),
  eyebrow: L(40).allow(null).default(null),
  title: L(80).allow(null).default(null),
  subtitle: L(160).allow(null).default(null),
  viewAllLink: LINK.allow(null).default(null),
  displayOrder: Joi.number().integer().min(0).max(100_000),
  isEnabled: Joi.boolean().default(true),
  itemLimit: Joi.number().integer().min(1).max(50).default(10),
  minItems: Joi.number().integer().min(0).max(50).default(1),
  inline: Joi.boolean().default(false),
  experimentKey: Joi.string()
    .trim()
    .pattern(/^[a-z0-9][a-z0-9_-]{1,59}$/)
    .allow(null)
    .default(null),
  /** Checked per widget in home.widgets.ts (unknown keys rejected there). */
  config: Joi.object().unknown(true).default({}),
  targeting: TARGETING.allow(null).default(null),
  items: Joi.array().items(ITEM).max(50).default([]),
});

export const LIMITS = { sections: 30, items: 50, inline: 3, batchKeys: 6 } as const;

// ── Public ──

const PAGE = Joi.string()
  .valid(...PAGES)
  .default('HOME');

export const layoutSchema = { querystring: Joi.object({ page: PAGE }) };

/** `GET /home/categories` takes no query (unknown params are stripped, like every route). */
export const categoriesPageSchema = { querystring: Joi.object({}) };

export const sectionsBatchSchema = {
  querystring: Joi.object({
    page: PAGE,
    keys: Joi.string()
      .lowercase()
      .pattern(/^[a-z][a-z0-9-]{1,59}(,[a-z][a-z0-9-]{1,59}){0,5}$/)
      .required()
      .description('Comma list, at most 6 section keys.'),
  }),
};

export const sectionPageSchema = {
  params: Joi.object({ sectionKey: SECTION_KEY.required() }),
  querystring: Joi.object({
    page: PAGE,
    cursor: Joi.string().max(200),
    limit: Joi.number().integer().min(1).max(50).default(10),
  }),
};

export const feedsSchema = {
  querystring: Joi.object({
    keys: Joi.string()
      .uppercase()
      .required()
      .custom((value: string, helpers) => {
        const keys = value.split(',');
        const valid = new Set<string>(FEED_KEYS);
        return keys.length > FEED_KEYS.length || keys.some((k) => !valid.has(k))
          ? helpers.error('any.invalid')
          : value;
      })
      .messages({ 'any.invalid': `must be a comma list of: ${FEED_KEYS.join(', ')}` })
      .description(`Comma list of feed keys: ${FEED_KEYS.join(', ')}.`),
  }),
};

// ── Admin ──

const idParams = Joi.object({ id: ID.required() });

export const idParamsSchema = { params: idParams };

export const adminListSchema = {
  querystring: Joi.object({
    page: Joi.string().valid(...PAGES),
    status: Joi.string().valid(...LAYOUT_STATUSES),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const historySchema = {
  params: idParams,
  querystring: Joi.object({
    cursor: ID,
    limit: Joi.number().integer().min(1).max(100).default(20),
  }),
};

export const createSchema = {
  body: Joi.object({
    page: Joi.string()
      .valid(...PAGES)
      .required(),
    name: Joi.string().trim().min(1).max(120).required(),
    notes: Joi.string().trim().max(1000),
    cloneFromId: ID,
  }),
};

export const replaceSchema = {
  params: idParams,
  body: Joi.object({
    name: Joi.string().trim().min(1).max(120).required(),
    notes: Joi.string().trim().max(1000).allow(null),
    settings: Joi.object({
      orderPhones: Joi.object({
        default: PHONE,
        byRegion: Joi.object().pattern(/^[A-Z]{2,3}$/, PHONE.required()),
      }),
    }).default({}),
    sections: Joi.array().items(SECTION).max(LIMITS.sections).required(),
  }),
};

export const reorderSchema = {
  params: idParams,
  body: Joi.object({
    keys: Joi.array().items(SECTION_KEY).unique().min(1).max(LIMITS.sections).required(),
  }),
};

export const publishSchema = {
  params: idParams,
  body: Joi.object({
    reason: REASON,
    scheduledPublishAt: Joi.date()
      .iso()
      .greater('now')
      .description('Future go-live time. Omit to publish now.'),
  }),
};

export const reasonSchema = { params: idParams, body: Joi.object({ reason: REASON }) };

export const previewSchema = {
  params: idParams,
  querystring: Joi.object({
    platform: Joi.string().valid(...PLATFORMS),
    region: REGION,
    userType: Joi.string().valid(...USER_TYPES),
    farmType: Joi.array().items(CODE).single().max(20),
    sdui: Joi.number().integer().min(1).max(99),
    appVersion: SEMVER,
    lang: Joi.string().valid(...LANGS),
    at: Joi.date().iso(),
    deviceId: Joi.string().pattern(/^[A-Za-z0-9._-]{8,64}$/),
  }),
};
