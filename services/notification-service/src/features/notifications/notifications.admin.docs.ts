import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_ADMIN, IDS, ok } from '../../docs/shared.js';
import { APPS, CATEGORIES, CHANNELS, DELIVERY_STATUSES, PRIORITIES } from '../../domain.js';

export const ADMIN_NOTIFICATIONS_TAG = 'Admin Notifications';

const STATUSES = ['SCHEDULED', 'PROCESSING', 'SENT', 'CANCELLED', 'EXPIRED'];

const notification = Joi.object({
  id: Joi.string().guid(),
  status: Joi.string()
    .valid(...STATUSES)
    .description('SCHEDULED → PROCESSING (fan-out) → SENT; or CANCELLED / EXPIRED'),
  source: Joi.string().valid('event', 'admin'),
  app: Joi.string().valid(...APPS),
  category: Joi.string().valid(...CATEGORIES),
  priority: Joi.string().valid(...PRIORITIES),
  audienceType: Joi.string().valid('USER', 'USERS', 'PERMISSION', 'APP'),
  audience: Joi.object().unknown(true).description('{userIds} | {permission, warehouseId} | {}'),
  channels: Joi.array().items(Joi.string().valid(...CHANNELS)),
  templateKey: Joi.string(),
  templateVersion: Joi.number().integer().allow(null),
  title: Joi.string(),
  body: Joi.string(),
  data: Joi.object().unknown(true),
  entityType: Joi.string().allow(null),
  entityId: Joi.string().allow(null),
  sourceEventId: Joi.string().guid().allow(null),
  createdBy: Joi.string().guid().allow(null),
  reason: Joi.string().allow(null),
  scheduledFor: Joi.date().iso().allow(null),
  expiresAt: Joi.date().iso().allow(null),
  recipientCount: Joi.number().integer(),
  cancelledAt: Joi.date().iso().allow(null),
  cancelledBy: Joi.string().guid().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'AdminNotification' });

const detail = notification
  .keys({
    content: Joi.object().unknown(true).description('Rendered PUSH / EMAIL / SMS content'),
    deliveryStats: Joi.object()
      .unknown(true)
      .description('Per channel per status')
      .example({ PUSH: { SENT: 118, SKIPPED: 4 }, EMAIL: { SENT: 60, FAILED: 1 } }),
  })
  .meta({ className: 'AdminNotificationDetail' });

const example = {
  id: IDS.notification,
  status: 'SENT',
  source: 'admin',
  app: 'CUSTOMER',
  category: 'SYSTEM',
  priority: 'NORMAL',
  audienceType: 'APP',
  audience: {},
  channels: ['PUSH'],
  templateKey: 'admin.message',
  templateVersion: 1,
  title: 'Scheduled maintenance',
  body: 'The app will be unavailable 2–3 am tonight.',
  data: {},
  entityType: null,
  entityId: null,
  sourceEventId: null,
  createdBy: IDS.user,
  reason: 'Planned database upgrade',
  scheduledFor: null,
  expiresAt: '2026-11-25T03:00:00.000Z',
  recipientCount: 12840,
  cancelledAt: null,
  cancelledBy: null,
  createdAt: '2026-11-24T10:15:00.000Z',
};
const detailExample = {
  ...example,
  content: {
    PUSH: { title: 'Scheduled maintenance', body: 'The app will be unavailable 2–3 am tonight.' },
  },
  deliveryStats: { PUSH: { SENT: 11890, SKIPPED: 950 } },
};

const delivery = Joi.object({
  id: Joi.string().guid(),
  notificationId: Joi.string().guid(),
  title: Joi.string(),
  userId: Joi.string().guid(),
  channel: Joi.string().valid(...CHANNELS),
  priority: Joi.string().valid(...PRIORITIES),
  status: Joi.string().valid(...DELIVERY_STATUSES),
  attempts: Joi.number().integer(),
  skipReason: Joi.string()
    .allow(null)
    .description(
      'OPTED_OUT · NO_DEVICE · NO_ADDRESS · USER_INACTIVE · EXPIRED · CANCELLED · PROVIDER_DISABLED',
    ),
  lastError: Joi.string().allow(null),
  provider: Joi.string().allow(null),
  providerMessageId: Joi.string().allow(null),
  nextAttemptAt: Joi.date().iso().allow(null),
  sentAt: Joi.date().iso().allow(null),
  failedAt: Joi.date().iso().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'AdminDelivery' });

const retried = Joi.object({ retried: Joi.number().integer() });

const SEND_DESC = [
  'Sends now, or later with `scheduledFor`. Audiences:',
  '- `USER` / `USERS` (≤ 1000 ids): created at once for ≤ 500, in the background above.',
  '- `PERMISSION`: staff holding a permission (GLOBAL, or at `warehouseId`); ADMIN / WAREHOUSE app only.',
  '- `APP`: every active user of the app (broadcast, background fan-out).',
  '',
  'Content comes from a template (`templateKey`, default `admin.message` with `vars.title` + `vars.body`); values are validated per variable (422). User opt-outs apply (PROMO is opt-in); SECURITY / CRITICAL are not available here.',
  '',
  '**Idempotent:** the `Idempotency-Key` header is required. Repeating it returns the first result with 200 and `idempotent-replay: true` (nothing is sent twice). `reason` required; audited.',
].join('\n');

export const ADMIN_DOCS = {
  send: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Send or schedule a notification',
    description: SEND_DESC,
    operationId: 'sendNotification',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    headers: {
      'Idempotency-Key': {
        description: '8–64 chars [A-Za-z0-9._:-], unique per send',
        required: true,
      },
    },
    requestExample: {
      app: 'CUSTOMER',
      category: 'SYSTEM',
      priority: 'NORMAL',
      audience: { type: 'APP' },
      channels: ['PUSH'],
      templateKey: 'admin.message',
      vars: { title: 'Scheduled maintenance', body: 'The app will be unavailable 2–3 am tonight.' },
      expiresAt: '2026-11-25T03:00:00.000Z',
      reason: 'Planned database upgrade',
    },
    success: {
      status: 201,
      description: 'Created (200 on an idempotent replay)',
      data: detail,
      example: ok(detailExample),
    },
    errors: [400, 422],
    errorExamples: {
      400: { message: 'Idempotency-Key header is required (8–64 of A-Z a-z 0-9 . _ : -)' },
    },
  },
  list: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Notification history',
    description:
      'Newest first; cursor paging. Filter by status, source (event / admin), app, category, template or business entity (e.g. every notification of one order).',
    operationId: 'listNotifications',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    success: {
      status: 200,
      description: 'One page',
      data: notification,
      paginated: true,
      example: ok([example], { nextCursor: null, limit: 20 }),
    },
    errors: [422],
  },
  get: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Notification detail + delivery status',
    operationId: 'getNotification',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    success: { status: 200, description: 'Detail', data: detail, example: ok(detailExample) },
    errors: [404, 422],
  },
  cancel: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Cancel a scheduled (or still fanning-out) notification',
    description:
      'SCHEDULED or PROCESSING only. Inbox entries already created stay; their pending push / email / SMS are skipped. `reason` required; audited.',
    operationId: 'cancelNotification',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    requestExample: { reason: 'Campaign postponed by marketing' },
    success: {
      status: 200,
      description: 'Cancelled',
      data: detail,
      example: ok({ ...detailExample, status: 'CANCELLED' }),
    },
    errors: [404, 409, 422],
    errorExamples: {
      409: {
        message: 'Only scheduled or still-sending notifications can be cancelled',
        details: { reason: 'NOT_CANCELLABLE', status: 'SENT' },
      },
    },
  },
  deliveries: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Deliveries (status FAILED = dead-letter list)',
    description: 'Per user, per channel. Addresses and device tokens are never shown.',
    operationId: 'listNotificationDeliveries',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    success: {
      status: 200,
      description: 'One page',
      data: delivery,
      paginated: true,
      example: ok(
        [
          {
            id: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d7d01',
            notificationId: IDS.notification,
            title: 'Order ORD-26-0091842 confirmed',
            userId: IDS.user,
            channel: 'EMAIL',
            priority: 'NORMAL',
            status: 'FAILED',
            attempts: 6,
            skipReason: null,
            lastError: 'attempts exhausted: ETIMEDOUT: connect timeout',
            provider: 'smtp',
            providerMessageId: null,
            nextAttemptAt: null,
            sentAt: null,
            failedAt: '2026-11-24T11:02:00.000Z',
            createdAt: '2026-11-24T10:15:00.000Z',
          },
        ],
        { nextCursor: null, limit: 20 },
      ),
    },
    errors: [422],
  },
  retryOne: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Retry a FAILED delivery',
    description:
      'FAILED → PENDING with a fresh attempt budget, queued at once. Not for cancelled / expired notifications (409). `reason` required; audited.',
    operationId: 'retryNotificationDelivery',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    requestExample: { reason: 'SMTP provider outage resolved' },
    success: { status: 200, description: 'Queued', data: retried, example: ok({ retried: 1 }) },
    errors: [404, 409, 422],
  },
  retryFailed: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Retry FAILED deliveries in bulk',
    description:
      'Up to 1000 per call (repeat while `retried` = 1000). Optionally one notification and / or channel. `reason` required; audited.',
    operationId: 'retryFailedNotificationDeliveries',
    auth: AUTH_ADMIN,
    permission: 'notifications.manage',
    rateLimit: '30 writes per user per minute',
    requestExample: { channel: 'EMAIL', reason: 'SMTP provider outage resolved' },
    success: { status: 200, description: 'Queued', data: retried, example: ok({ retried: 37 }) },
    errors: [422],
  },
  analytics: {
    tag: ADMIN_NOTIFICATIONS_TAG,
    summary: 'Notification analytics',
    description:
      'Created per category / source, and per channel: sent, failed, skipped, in flight, success rate (sent / (sent + failed)) and average latency (created → provider accepted).',
    operationId: 'getNotificationAnalytics',
    auth: AUTH_ADMIN,
    permission: 'notifications.view',
    success: {
      status: 200,
      description: 'Aggregates',
      data: Joi.object({
        from: Joi.date().iso(),
        to: Joi.date().iso(),
        notifications: Joi.array().items(
          Joi.object({
            category: Joi.string(),
            source: Joi.string(),
            count: Joi.number().integer(),
          }),
        ),
        deliveries: Joi.array().items(
          Joi.object({
            channel: Joi.string(),
            sent: Joi.number().integer(),
            failed: Joi.number().integer(),
            skipped: Joi.number().integer(),
            inFlight: Joi.number().integer(),
            successRate: Joi.number().allow(null),
            avgLatencySeconds: Joi.number().allow(null),
          }),
        ),
      }).meta({ className: 'NotificationAnalytics' }),
      example: ok({
        from: '2026-11-17T00:00:00.000Z',
        to: '2026-11-24T00:00:00.000Z',
        notifications: [{ category: 'ORDER', source: 'event', count: 4210 }],
        deliveries: [
          {
            channel: 'PUSH',
            sent: 8120,
            failed: 12,
            skipped: 640,
            inFlight: 3,
            successRate: 0.9985,
            avgLatencySeconds: 1.42,
          },
        ],
      }),
    },
    errors: [422],
  },
} satisfies Record<string, RouteDocs>;
