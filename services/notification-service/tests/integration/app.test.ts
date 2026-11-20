import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('notification-service app', () => {
  it('serves liveness and Prometheus metrics with the service label', async () => {
    app = await buildApp(ENV);
    expect((await app.inject({ url: '/health/live' })).statusCode).toBe(200);
    const { metrics } = app.diContainer.cradle;
    metrics.created.inc({ category: 'ORDER', source: 'event' });
    metrics.onScrape(() => Promise.reject(new Error('collector down')));
    const res = await app.inject({ url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain(
      'notifications_created_total{category="ORDER",source="event",service="notification-service"} 1',
    );
    expect(res.body).toContain('process_cpu_user_seconds_total');
  });

  it('METRICS_ENABLED=0 removes /metrics; the spec hides it', async () => {
    app = await buildApp({ ...ENV, METRICS_ENABLED: '0' });
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(404);
    await app.close();
    app = await buildApp(ENV);
    const spec = (await app.inject({ url: '/api-docs.json' })).json<{
      paths: Record<string, unknown>;
      info: { title: string };
    }>();
    expect(spec.info.title).toBe('FarmX Notification Service API');
    expect(Object.keys(spec.paths)).not.toContain('/metrics');
  });

  it('documents every user route with a unique operationId and shared schemas', async () => {
    app = await buildApp(ENV);
    const spec = (await app.inject({ url: '/api-docs.json' })).json<{
      paths: Record<string, Record<string, { operationId?: string; tags?: string[] }>>;
      components: { schemas: Record<string, unknown> };
    }>();
    const ops = Object.values(spec.paths).flatMap((byMethod) => Object.values(byMethod));
    const ids = ops.map((op) => op.operationId).filter((id) => id !== undefined);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        'listMyNotifications',
        'getMyUnreadCount',
        'streamMyNotifications',
        'markMyNotificationRead',
        'markAllMyNotificationsRead',
        'getMyNotificationPreferences',
        'updateMyNotificationPreferences',
        'registerMyDevice',
        'removeMyDevice',
      ]),
    );
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['InboxItem', 'UnreadCount', 'NotificationPreference', 'Device']),
    );
    expect(Object.keys(spec.paths).some((path) => path.startsWith('/internal'))).toBe(false);
  });
});
