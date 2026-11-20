import type { RouteDocs } from '@farmx/common/server';
import Joi from 'joi';

import { AUTH_USER, IDS, ok } from '../../docs/shared.js';
import { CATEGORIES, PRIORITIES } from '../../domain.js';

export const INBOX_TAG = 'Notifications';

const inboxItem = Joi.object({
  id: Joi.string()
    .guid()
    .description('Notification id (same for every recipient; also in push payloads)'),
  category: Joi.string().valid(...CATEGORIES),
  priority: Joi.string().valid(...PRIORITIES),
  title: Joi.string().example('Order ORD-26-0091842 confirmed'),
  body: Joi.string().example('Your order ORD-26-0091842 is confirmed and is being prepared.'),
  data: Joi.object()
    .unknown(true)
    .description(
      'Deep link for the app: `entityType` + `entityId` (+ ids such as `orderNo`). Never personal data.',
    )
    .example({ entityType: 'order', entityId: IDS.order, orderNo: 'ORD-26-0091842' }),
  read: Joi.boolean(),
  readAt: Joi.date().iso().allow(null),
  createdAt: Joi.date().iso(),
}).meta({ className: 'InboxItem' });

const item = {
  id: IDS.notification,
  category: 'ORDER',
  priority: 'NORMAL',
  title: 'Order ORD-26-0091842 confirmed',
  body: 'Your order ORD-26-0091842 is confirmed and is being prepared.',
  data: { entityType: 'order', entityId: IDS.order, orderNo: 'ORD-26-0091842' },
  read: false,
  readAt: null,
  createdAt: '2026-11-24T10:15:00.000Z',
};

const unread = Joi.object({ unreadCount: Joi.number().integer().min(0) }).meta({
  className: 'UnreadCount',
});

const NOT_FOUND = { message: 'Notification not found' };
const WRONG_APP = { message: 'This app is not available for your account' };

export const INBOX_DOCS = {
  list: {
    tag: INBOX_TAG,
    summary: 'My notifications (newest first)',
    description:
      'Cursor paging: pass `meta.nextCursor` as `cursor` for the next page (stable while new notifications arrive). Expired notifications are hidden. Each app has its own inbox; an admin message for the warehouse panel never appears in the customer app.',
    operationId: 'listMyNotifications',
    auth: AUTH_USER,
    success: {
      status: 200,
      description: 'One page of the inbox',
      data: inboxItem,
      paginated: true,
      example: ok([item], { nextCursor: IDS.notification, limit: 20 }),
    },
    errors: [422],
    errorExamples: { 403: WRONG_APP },
  },
  unreadCount: {
    tag: INBOX_TAG,
    summary: 'Unread count (badge)',
    description: 'Cheap (index-only). Live updates arrive on the SSE stream as `unread_count`.',
    operationId: 'getMyUnreadCount',
    auth: AUTH_USER,
    success: {
      status: 200,
      description: 'Unread count',
      data: unread,
      example: ok({ unreadCount: 3 }),
    },
    errors: [422],
    errorExamples: { 403: WRONG_APP },
  },
  get: {
    tag: INBOX_TAG,
    summary: 'One of my notifications',
    operationId: 'getMyNotification',
    auth: AUTH_USER,
    success: { status: 200, description: 'Inbox entry', data: inboxItem, example: ok(item) },
    errors: [404, 422],
    errorExamples: { 404: NOT_FOUND },
  },
  read: {
    tag: INBOX_TAG,
    summary: 'Mark as read',
    description: 'Idempotent. Returns the new unread count; other open devices get it live.',
    operationId: 'markMyNotificationRead',
    auth: AUTH_USER,
    rateLimit: '120 per user per minute',
    success: {
      status: 200,
      description: 'Read',
      data: Joi.object({
        id: Joi.string().guid(),
        read: Joi.boolean(),
        unreadCount: Joi.number().integer(),
      }),
      example: ok({ id: IDS.notification, read: true, unreadCount: 2 }),
    },
    errors: [404, 422],
    errorExamples: { 404: NOT_FOUND },
  },
  readAll: {
    tag: INBOX_TAG,
    summary: 'Mark all as read',
    operationId: 'markAllMyNotificationsRead',
    auth: AUTH_USER,
    rateLimit: '30 per user per minute',
    requestExample: { app: 'CUSTOMER', before: '2026-11-24T10:15:00.000Z' },
    success: {
      status: 200,
      description: 'How many changed',
      data: Joi.object({ updated: Joi.number().integer(), unreadCount: Joi.number().integer() }),
      example: ok({ updated: 3, unreadCount: 0 }),
    },
    errors: [422],
    errorExamples: { 403: WRONG_APP },
  },
  stream: {
    tag: INBOX_TAG,
    summary: 'Live updates (Server-Sent Events)',
    description: [
      "`text/event-stream`. Open with `fetch` (or an SSE client that sends headers) and the `Authorization` header; browsers' native `EventSource` cannot send it.",
      '',
      'Events:',
      '- `unread_count` `{ unreadCount }`: first frame, and after reads on any device.',
      '- `notification` (an InboxItem): a new notification for this app.',
      '- `reauth` `{}`: the access token is about to expire; the stream closes. Refresh the token and reconnect.',
      '',
      'A comment frame (`: ping`) every 25 s keeps proxies open. Best effort: after a reconnect, re-read `unread-count` / the inbox (the inbox is the source of truth). At most 5 open streams per user (6th → 429).',
    ].join('\n'),
    operationId: 'streamMyNotifications',
    auth: AUTH_USER,
    rateLimit: '5 concurrent streams per user',
    success: { status: 200, description: 'Event stream (never a JSON body)' },
    errors: [422],
    errorExamples: { 403: WRONG_APP },
  },
} satisfies Record<string, RouteDocs>;
