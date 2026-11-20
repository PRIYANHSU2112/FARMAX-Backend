import type { DocsOptions, ServiceModule } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import type { NotificationConfig } from '../config/index.js';
import { audienceModule } from '../features/audience/index.js';
import { auditModule } from '../features/audit/index.js';
import { DEVICES_TAG, devicesModule } from '../features/devices/index.js';
import { eventsModule } from '../features/events/index.js';
import {
  ADMIN_NOTIFICATIONS_TAG,
  INBOX_TAG,
  notificationsAdminModule,
  notificationsModule,
} from '../features/notifications/index.js';
import { PREFERENCES_TAG, preferencesModule } from '../features/preferences/index.js';
import { TEMPLATES_TAG, templatesModule } from '../features/templates/index.js';

/**
 * notification-service: in-app inbox, push (FCM), email, SMS and live updates (SSE) for every
 * FarmX app, fed by business events (RabbitMQ) and admin sends. Gateway maps (Phase 7)
 *   /v1/notifications/*                → /notifications/*                  any signed-in user (own inbox)
 *   /v1/admin/notifications/*          → /admin/notifications/*            staff
 *   /v1/admin/notification-templates/* → /admin/notification-templates/*   staff
 * `/metrics` is never routed by the gateway.
 */
export const features: readonly ServiceModule[] = [
  auditModule,
  templatesModule,
  preferencesModule,
  audienceModule,
  notificationsModule,
  notificationsAdminModule,
  devicesModule,
  eventsModule,
];

/** `/metrics` (Prometheus text). Off when METRICS_ENABLED=0. */
export const opsRoutes: FastifyPluginAsync = async (app) => {
  if (!app.diContainer.resolve('config').METRICS_ENABLED) return;
  app.get('/metrics', { schema: { hide: true }, logLevel: 'warn' }, async (_request, reply) => {
    const metrics = app.diContainer.resolve('metrics');
    const body = await metrics.render();
    return reply.header('content-type', metrics.contentType).send(body);
  });
};

/** Spec only (`/api-docs.json`); the gateway merges it into the single FarmX Swagger UI. */
export const createDocsOptions = (config: NotificationConfig): DocsOptions => ({
  title: 'FarmX Notification Service API',
  version: config.SERVICE_VERSION,
  description:
    'Notifications for every FarmX app: in-app inbox (read / unread), live updates (SSE), push (FCM), email and SMS, user preferences and device tokens; staff send, schedule and track deliveries. Event-driven and at-least-once: duplicates are suppressed by a dedupe key, failed deliveries retry with backoff.',
  tags: [
    { name: 'Health', description: 'Public liveness and readiness probes.' },
    {
      name: INBOX_TAG,
      description:
        'Any signed-in user: own inbox per app (list, unread count, read, read-all) and live updates (SSE).',
    },
    {
      name: PREFERENCES_TAG,
      description: 'Any signed-in user: which channels (push / email / SMS) each category may use.',
    },
    { name: DEVICES_TAG, description: 'Any signed-in user: FCM push tokens of own devices.' },
    {
      name: ADMIN_NOTIFICATIONS_TAG,
      description:
        'Staff: send / schedule / cancel, history, delivery status, failed deliveries (DLQ) + retry, analytics.',
    },
    {
      name: TEMPLATES_TAG,
      description:
        'Staff: versioned templates per key, channel and language; preview, activate, roll back.',
    },
  ],
});
