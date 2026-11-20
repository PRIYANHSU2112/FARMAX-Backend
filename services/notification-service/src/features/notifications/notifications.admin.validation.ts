import Joi from 'joi';

import { APPS, CATEGORIES, DELIVERY_STATUSES } from '../../domain.js';
import { ID, PAGE, REASON, idParams } from '../../middleware/http.js';

const STATUSES = ['SCHEDULED', 'PROCESSING', 'SENT', 'CANCELLED', 'EXPIRED'];
/** SECURITY is system-only (it bypasses opt-outs); CRITICAL likewise. */
const ADMIN_CATEGORIES = CATEGORIES.filter((c) => c !== 'SECURITY');
const MAX_SCHEDULE_DAYS = 30;

const KEY = Joi.string()
  .max(80)
  .pattern(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);

export const sendSchema = {
  body: Joi.object({
    app: Joi.string()
      .valid(...APPS)
      .required()
      .description('Whose inbox: the notification never appears in another app'),
    category: Joi.string()
      .valid(...ADMIN_CATEGORIES)
      .default('SYSTEM')
      .description('PROMO is opt-in (only users who enabled it get push / email / SMS)'),
    priority: Joi.string().valid('LOW', 'NORMAL', 'HIGH').default('NORMAL'),
    audience: Joi.object({
      type: Joi.string().valid('USER', 'USERS', 'PERMISSION', 'APP').required(),
      userIds: Joi.when('type', {
        switch: [
          { is: 'USER', then: Joi.array().items(ID).length(1).required() },
          { is: 'USERS', then: Joi.array().items(ID).min(1).max(1000).unique().required() },
        ],
        otherwise: Joi.forbidden(),
      }),
      permission: Joi.when('type', {
        is: 'PERMISSION',
        then: Joi.string()
          .pattern(/^[a-z_]+\.[a-z_]+$/)
          .max(80)
          .required(),
        otherwise: Joi.forbidden(),
      }),
      warehouseId: Joi.when('type', { is: 'PERMISSION', then: ID, otherwise: Joi.forbidden() }),
    }).required(),
    channels: Joi.array()
      .items(Joi.string().valid('PUSH', 'EMAIL', 'SMS'))
      .unique()
      .default([])
      .description('In-app is always on. SMS is only used for HIGH priority.'),
    templateKey: KEY.default('admin.message'),
    vars: Joi.object()
      .pattern(/^[A-Za-z][A-Za-z0-9_]{0,39}$/, [Joi.string().max(2000), Joi.number()])
      .max(20)
      .default({}),
    data: Joi.object({
      entityType: Joi.string()
        .pattern(/^[a-z_]{1,30}$/)
        .description('Deep link target, e.g. order, product, offer'),
      entityId: Joi.string().max(64),
    }),
    scheduledFor: Joi.date()
      .iso()
      .greater('now')
      .max(Date.now() + MAX_SCHEDULE_DAYS * 86_400_000)
      .description(`Send later (≤ ${String(MAX_SCHEDULE_DAYS)} days ahead)`),
    expiresAt: Joi.date().iso().greater('now').description('Hidden and not delivered after this'),
    reason: REASON.required(),
  }),
};

export const listSchema = {
  querystring: Joi.object({
    status: Joi.string().valid(...STATUSES),
    source: Joi.string().valid('event', 'admin'),
    app: Joi.string().valid(...APPS),
    category: Joi.string().valid(...CATEGORIES),
    templateKey: KEY,
    entityType: Joi.string().max(30),
    entityId: Joi.string().max(64),
    from: Joi.date().iso(),
    to: Joi.date().iso(),
    ...PAGE,
  }),
};

export const getSchema = idParams;

export const cancelSchema = { ...idParams, body: Joi.object({ reason: REASON.required() }) };

export const deliveriesSchema = {
  querystring: Joi.object({
    status: Joi.string()
      .valid(...DELIVERY_STATUSES)
      .description('FAILED = the delivery dead-letter list'),
    channel: Joi.string().valid('PUSH', 'EMAIL', 'SMS'),
    notificationId: ID,
    userId: ID,
    ...PAGE,
  }),
};

export const retryOneSchema = cancelSchema;

export const retryFailedSchema = {
  body: Joi.object({
    notificationId: ID,
    channel: Joi.string().valid('PUSH', 'EMAIL', 'SMS'),
    reason: REASON.required(),
  }),
};

export const analyticsSchema = {
  querystring: Joi.object({
    from: Joi.date().iso().description('Default: 7 days before `to`'),
    to: Joi.date().iso().description('Default: now. Range ≤ 92 days'),
  }),
};
