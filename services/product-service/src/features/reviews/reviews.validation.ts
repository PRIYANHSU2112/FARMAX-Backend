import Joi from 'joi';

import { ID, PAGE, REASON, SLUG, idParams } from '../../middleware/http.js';
import { REVIEW_LIMITS } from './reviews.rules.js';
import {
  MODERATION_ACTIONS,
  REPORT_REASONS,
  REPORT_STATUSES,
  REVIEW_STATUSES,
} from './reviews.types.js';

const RATING = Joi.number().integer().min(1).max(5);
const TITLE = Joi.string().trim().max(REVIEW_LIMITS.titleMax).allow(null, '');
const BODY = Joi.string().trim().max(REVIEW_LIMITS.bodyMax).allow(null, '');
const IMAGES = Joi.array()
  .items(
    Joi.object({
      mediaId: ID.required(),
      url: Joi.string()
        .uri({ scheme: ['https', 'http'] })
        .max(500)
        .required(),
    }),
  )
  .max(REVIEW_LIMITS.maxImages);

const slugOrId = Joi.object({ slugOrId: Joi.alternatives().try(ID, SLUG).required() });

export const publicListSchema = {
  params: slugOrId,
  querystring: Joi.object({
    sort: Joi.string().valid('recent', 'helpful', 'rating_high', 'rating_low').default('recent'),
    rating: RATING,
    withImages: Joi.boolean(),
    ...PAGE,
  }),
};

export const summarySchema = { params: slugOrId };

export const createSchema = {
  params: slugOrId,
  body: Joi.object({
    orderId: ID,
    rating: RATING.required(),
    title: TITLE,
    body: BODY,
    images: IMAGES.default([]),
  }),
};

export const updateSchema = {
  ...idParams,
  body: Joi.object({ rating: RATING, title: TITLE, body: BODY, images: IMAGES }).min(1),
};

export const pageSchema = { querystring: Joi.object({ ...PAGE }) };

export const votesSchema = {
  querystring: Joi.object({
    reviewIds: Joi.alternatives().try(Joi.array().items(ID).max(100), ID).required(),
  }),
};

export const reportSchema = {
  ...idParams,
  body: Joi.object({
    reason: Joi.string()
      .valid(...REPORT_REASONS)
      .required(),
    note: Joi.string()
      .trim()
      .max(500)
      .allow(null, '')
      .when('reason', {
        is: 'OTHER',
        then: Joi.string().trim().min(10).max(500).required(),
      }),
  }),
};

// ── Admin ──

export const adminListSchema = {
  querystring: Joi.object({
    q: Joi.string().trim().min(2).max(100),
    status: Joi.string().valid(...REVIEW_STATUSES),
    rating: RATING,
    productId: ID,
    userId: ID,
    orderId: ID,
    hasImages: Joi.boolean(),
    flagged: Joi.boolean(),
    hasOpenReports: Joi.boolean(),
    from: Joi.date().iso(),
    to: Joi.date().iso().min(Joi.ref('from')),
    sort: Joi.string()
      .valid('newest', 'oldest', 'rating_high', 'rating_low', 'helpful', 'most_reported')
      .default('newest'),
    ...PAGE,
  }),
};

export const historySchema = { ...idParams, querystring: Joi.object({ ...PAGE }) };

export const moderateSchema = {
  ...idParams,
  body: Joi.object({ reason: Joi.string().trim().min(10).max(500).allow(null) }).default({}),
};

export const bulkSchema = {
  body: Joi.object({
    ids: Joi.array().items(ID).min(1).max(100).unique().required(),
    action: Joi.string()
      .valid(...MODERATION_ACTIONS)
      .required(),
    reason: Joi.string().trim().min(10).max(500).allow(null),
  }),
};

export const reportListSchema = {
  querystring: Joi.object({
    status: Joi.string()
      .valid(...REPORT_STATUSES)
      .default('OPEN'),
    reason: Joi.string().valid(...REPORT_REASONS),
    reviewId: ID,
    ...PAGE,
  }),
};

export const resolveSchema = {
  ...idParams,
  body: Joi.object({ decision: Joi.string().valid('UPHOLD', 'DISMISS').required(), note: REASON }),
};

export const productSummarySchema = { params: Joi.object({ productId: ID.required() }) };

export const analyticsSchema = {
  querystring: Joi.object({
    from: Joi.date().iso(),
    to: Joi.date().iso().min(Joi.ref('from')),
    productId: ID,
  }),
};

export const toIdArray = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);
