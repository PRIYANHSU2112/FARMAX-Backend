import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * Production 2026-11-25: /orders, /notifications/unread-count and /farms answered
 * 500 INTERNAL_ERROR because those services were not running and @fastify/reply-from maps a
 * refused connection to a generic 500. A missing upstream must be 503 SERVICE_UNAVAILABLE, while a
 * real upstream error (or a real empty list) must pass through untouched.
 */
const DOWN = 'http://127.0.0.1:9'; // discard port: connection refused at once
let order: FastifyInstance;
let gateway: FastifyInstance;

beforeAll(async () => {
  // Stand-in order-service: an empty list for one tab, a genuine 500 for another.
  order = Fastify();
  order.get('/orders', (request, reply) => {
    const tab = (request.query as { tab?: string }).tab;
    if (tab === 'broken') {
      return reply.code(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          requestId: 'upstream-req',
        },
      });
    }
    return { success: true, data: [], meta: { nextCursor: null, limit: 50 } };
  });
  await order.listen({ port: 0, host: '127.0.0.1' });
  const address = order.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  gateway = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    AUTH_SERVICE_URL: DOWN,
    MEDIA_SERVICE_URL: DOWN,
    FARM_SERVICE_URL: DOWN,
    CATALOG_SERVICE_URL: DOWN,
    PRODUCT_SERVICE_URL: DOWN,
    USER_SERVICE_URL: DOWN,
    ORDER_SERVICE_URL: `http://127.0.0.1:${String(port)}`,
    INVENTORY_SERVICE_URL: DOWN,
    PAYMENT_SERVICE_URL: DOWN,
    NOTIFICATION_SERVICE_URL: DOWN,
  });
});

afterAll(async () => {
  await gateway.close();
  await order.close();
});

describe('gateway → unavailable upstream', () => {
  it.each([
    '/v1/notifications/unread-count?app=CUSTOMER',
    '/v1/farms',
    '/v1/catalog/banners?app=FARMER&page=HOME',
    '/v1/catalog/products?limit=50',
  ])('%s answers 503 SERVICE_UNAVAILABLE (not 500) when the service is down', async (url) => {
    const res = await gateway.inject({ method: 'GET', url });
    expect(res.statusCode).toBe(503);
    const body = res.json<{
      success: boolean;
      error: { code: string; message: string; requestId?: string };
    }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(body.error.message).toBe('Service temporarily unavailable');
    expect(typeof body.error.requestId).toBe('string');
    // Nothing internal leaks (upstream address, errno, stack).
    expect(res.body).not.toMatch(/127\.0\.0\.1|ECONNREFUSED|stack/);
  });

  it('passes a real empty list through as 200', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/v1/orders?tab=active&limit=50' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: [], meta: { nextCursor: null, limit: 50 } });
  });

  it('does not hide a genuine upstream 500', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/v1/orders?tab=broken' });
    expect(res.statusCode).toBe(500);
    expect(res.json<{ error: { requestId: string } }>().error.requestId).toBe('upstream-req');
  });

  it('still blocks internal routes before proxying', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/v1/orders/internal/anything' });
    expect(res.statusCode).toBe(404);
  });
});
