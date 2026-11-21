import { DEFAULT_PAGE_LIMIT } from '@farmx/database';
import Joi from 'joi';

import {
  CONTENT_KINDS,
  CONTENT_STATUSES,
  CTA_TYPES,
  PRODUCTION_TYPES,
  SEVERITIES,
} from './content.types.js';

const ID = Joi.string().guid();
const text = (max: number) => Joi.string().trim().min(1).max(max);
const url = Joi.string()
  .uri({ scheme: ['https', 'http'] })
  .max(500);
const reason = Joi.string().trim().min(10).max(500);
const publicNote = Joi.string().trim().min(10).max(300);
const MAX_FEED_LIMIT = 50;

// ── Body pieces ──

const block = Joi.object({
  type: Joi.string().valid('heading', 'paragraph', 'list', 'callout', 'image', 'video').required(),
  text: Joi.when('type', {
    is: Joi.valid('heading'),
    then: text(160).required(),
    otherwise: Joi.when('type', {
      is: Joi.valid('paragraph', 'callout'),
      then: text(4000).required(),
      otherwise: Joi.forbidden(),
    }),
  }),
  style: Joi.when('type', {
    is: 'list',
    then: Joi.string().valid('bullet', 'numbered').required(),
    otherwise: Joi.forbidden(),
  }),
  items: Joi.when('type', {
    is: 'list',
    then: Joi.array().items(text(500)).min(1).max(30).required(),
    otherwise: Joi.forbidden(),
  }),
  tone: Joi.when('type', {
    is: 'callout',
    then: Joi.string().valid('info', 'warning').default('info'),
    otherwise: Joi.forbidden(),
  }),
  url: Joi.when('type', {
    is: Joi.valid('image', 'video'),
    then: url.required(),
    otherwise: Joi.forbidden(),
  }),
  caption: Joi.when('type', {
    is: 'image',
    then: Joi.string().trim().max(200).allow(null),
    otherwise: Joi.forbidden(),
  }),
  durationSec: Joi.when('type', {
    is: 'video',
    then: Joi.number().integer().min(1).max(36_000).allow(null),
    otherwise: Joi.forbidden(),
  }),
});

const source = Joi.object({
  title: text(200).required(),
  publisher: text(120).required(),
  url: url.allow(null),
  referenceDate: Joi.date().iso().max('now').required(),
});

const cta = Joi.object({
  type: Joi.string()
    .valid(...CTA_TYPES)
    .required(),
  target: Joi.when('type', {
    is: Joi.valid('PRODUCT', 'CATEGORY'),
    then: ID.required(),
    otherwise: Joi.when('type', {
      is: 'DEEP_LINK',
      then: Joi.string().trim().max(300).required(),
      otherwise: Joi.valid(null),
    }),
  }),
  label: text(40).required(),
  style: Joi.string().valid('primary', 'secondary').default('secondary'),
});

const asset = Joi.object({
  url: url.required(),
  mediaId: ID.allow(null),
  kind: Joi.string().valid('video', 'pdf').required(),
  sizeBytes: Joi.number().integer().min(1).max(200_000_000).allow(null),
  durationSec: Joi.number().integer().min(1).max(36_000).allow(null),
  pageCount: Joi.number().integer().min(1).max(2000).allow(null),
});

const area = Joi.object({
  lat: Joi.number().min(-90).max(90).required(),
  lng: Joi.number().min(-180).max(180).required(),
}).description('Centre of the affected AREA (rounded to ~1 km on save; never shown to readers)');

/** Reader-visible fields shared by create / edit / correction. */
const fields = {
  title: text(160),
  summary: text(400),
  heroImageUrl: url.allow(null),
  heroMediaId: ID.allow(null),
  blocks: Joi.array().items(block).max(60),
  sources: Joi.array().items(source).max(5),
  ctas: Joi.array().items(cta).max(3),
  tags: Joi.array().items(Joi.string().trim().lowercase().max(40)).max(15).unique(),
  relatedIds: Joi.array().items(ID).max(6).unique(),
  asset: asset.allow(null),
  severity: Joi.string()
    .valid(...SEVERITIES)
    .allow(null),
  placeLabel: Joi.string().trim().max(80).allow(null),
  area: area.allow(null),
};

const targeting = {
  productionTypes: Joi.array()
    .items(Joi.string().valid(...PRODUCTION_TYPES))
    .max(PRODUCTION_TYPES.length)
    .unique(),
  territoryCodes: Joi.array()
    .items(
      Joi.string()
        .uppercase()
        .pattern(/^[A-Z]{2,3}$/),
    )
    .max(50)
    .unique(),
};

const editable = {
  ...fields,
  ...targeting,
  topicId: ID,
  isFeatured: Joi.boolean(),
  notify: Joi.boolean(),
  expiresAt: Joi.date().iso().allow(null),
};

const idParams = Joi.object({ id: ID.required() });

// ── Reader ──

export const topicsListSchema = {};

export const feedSchema = {
  querystring: Joi.object({
    farmId: ID,
    topic: Joi.string().uppercase().max(30),
    kind: Joi.string().valid(...CONTENT_KINDS),
    sort: Joi.string().valid('latest', 'trending').default('latest'),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(MAX_FEED_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const searchSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(2).max(100).required(),
    farmId: ID,
    topic: Joi.string().uppercase().max(30),
    kind: Joi.string().valid(...CONTENT_KINDS),
    cursor: Joi.string()
      .pattern(/^\d{1,3}$/)
      .description('Opaque offset cursor from the previous page'),
    limit: Joi.number().integer().min(1).max(MAX_FEED_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const detailSchema = {
  params: Joi.object({
    idOrSlug: Joi.alternatives(
      ID,
      Joi.string()
        .max(120)
        .pattern(/^[a-z0-9-]+$/),
    ).required(),
  }),
  querystring: Joi.object({ farmId: ID }),
};

export const saveSchema = {
  params: idParams,
  body: Joi.object({
    offline: Joi.boolean().default(false),
    downloadedVersion: Joi.number().integer().min(1).allow(null),
  }).default({}),
};

export const unsaveSchema = { params: idParams };

export const feedbackSchema = {
  params: idParams,
  body: Joi.object({ helpful: Joi.boolean().required() }),
};

export const shareSchema = { params: idParams };

export const librarySchema = {
  querystring: Joi.object({
    offline: Joi.boolean(),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(MAX_FEED_LIMIT).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const syncSchema = {
  body: Joi.object({
    held: Joi.array()
      .items(
        Joi.object({
          contentId: ID.required(),
          version: Joi.number().integer().min(1).required(),
        }),
      )
      .max(100)
      .unique('contentId')
      .default([]),
  }),
};

// ── Admin ──

export const adminListSchema = {
  querystring: Joi.object({
    status: Joi.string().valid(...CONTENT_STATUSES),
    kind: Joi.string().valid(...CONTENT_KINDS),
    topic: Joi.string().uppercase().max(30),
    q: Joi.string().trim().min(2).max(100),
    expiringWithin: Joi.number()
      .integer()
      .min(1)
      .max(24 * 30)
      .description('Hours: live alerts expiring within this window'),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(100).default(DEFAULT_PAGE_LIMIT),
  }),
};

export const adminIdSchema = { params: idParams };

export const createSchema = {
  body: Joi.object({
    ...editable,
    kind: Joi.string()
      .valid(...CONTENT_KINDS)
      .required(),
    topicId: ID.required(),
    title: fields.title.required(),
    summary: fields.summary.required(),
  }),
};

export const updateSchema = {
  params: idParams,
  body: Joi.object(editable).min(1),
};

export const reasonSchema = {
  params: idParams,
  body: Joi.object({ reason: reason.required() }),
};

export const optionalReasonSchema = {
  params: idParams,
  body: Joi.object({ reason }).default({}),
};

export const publishSchema = {
  params: idParams,
  body: Joi.object({
    publishAt: Joi.date().iso().greater('now'),
    notify: Joi.boolean(),
    reason,
  }).default({}),
};

export const extendSchema = {
  params: idParams,
  body: Joi.object({
    expiresAt: Joi.date().iso().greater('now').required(),
    reason: reason.required(),
  }),
};

export const retractSchema = {
  params: idParams,
  body: Joi.object({
    reason: reason.required(),
    publicNote: publicNote.required().description('Shown to readers: why it was withdrawn'),
  }),
};

export const correctionSchema = {
  params: idParams,
  body: Joi.object({
    changes: Joi.object(fields).min(1).required(),
    changeNote: publicNote.required().description('Shown to readers as "Updated <date>: <note>"'),
  }),
};

const revisionParams = Joi.object({ id: ID.required(), revisionId: ID.required() });

export const revisionSchema = { params: revisionParams };

export const approveRevisionSchema = {
  params: revisionParams,
  body: Joi.object({ notify: Joi.boolean().default(false) }).default({}),
};

export const rejectRevisionSchema = {
  params: revisionParams,
  body: Joi.object({ reason: reason.required() }),
};

// ── Topics / reviewers ──

export const topicCreateSchema = {
  body: Joi.object({
    code: Joi.string()
      .uppercase()
      .pattern(/^[A-Z][A-Z0-9_]{1,29}$/)
      .required(),
    name: text(60).required(),
    clinical: Joi.boolean().default(false),
    sortOrder: Joi.number().integer().min(0).max(10_000).default(0),
  }),
};

export const topicUpdateSchema = {
  params: idParams,
  body: Joi.object({
    name: text(60),
    clinical: Joi.boolean(),
    sortOrder: Joi.number().integer().min(0).max(10_000),
    isActive: Joi.boolean(),
  }).min(1),
};

export const reviewerCreateSchema = {
  body: Joi.object({
    userId: ID.required(),
    displayName: text(100).required(),
    qualification: text(60).required(),
    registrationNo: text(40).required(),
    validUntil: Joi.date().iso().greater('now').required(),
    reason: reason.required(),
  }),
};

export const reviewerUpdateSchema = {
  params: idParams,
  body: Joi.object({
    displayName: text(100),
    qualification: text(60),
    registrationNo: text(40),
    validUntil: Joi.date().iso().greater('now'),
    isActive: Joi.boolean(),
    reason: reason.required(),
  }).or('displayName', 'qualification', 'registrationNo', 'validUntil', 'isActive'),
};

// ── Internal ──

export const audienceSchema = {
  params: idParams,
  querystring: Joi.object({
    scope: Joi.string().valid('segment', 'savers', 'both').required(),
    cursor: ID,
    limit: Joi.number().integer().min(1).max(1000).default(500),
  }),
};

/** `If-Match: 3` / `"3"` / `W/"3"` → 3. Absent or malformed → undefined (the version is still guarded). */
export const parseIfMatch = (header: string | string[] | undefined): number | undefined => {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return undefined;
  const n = Number(raw.replace(/^W\//, '').replaceAll('"', ''));
  return Number.isInteger(n) && n >= 0 ? n : undefined;
};
