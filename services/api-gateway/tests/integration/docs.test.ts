import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/** Stand-in for catalog-service: publishes only its spec. The other services are "down". */
let upstream: FastifyInstance;
let gateway: FastifyInstance;
const DOWN = 'http://127.0.0.1:9'; // discard port: connection refused at once

beforeAll(async () => {
  upstream = Fastify();
  upstream.get('/api-docs.json', () => ({
    openapi: '3.0.3',
    tags: [{ name: 'Catalog · Categories', description: 'tree' }],
    paths: {
      '/catalog/categories': { get: { tags: ['Catalog · Categories'], summary: 'Tree' } },
      '/health/live': { get: { tags: ['Health'] } },
    },
    components: { schemas: { CategoryNode: { type: 'object' } } },
  }));
  await upstream.listen({ port: 0, host: '127.0.0.1' });
  const address = upstream.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  gateway = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    AUTH_SERVICE_URL: DOWN,
    MEDIA_SERVICE_URL: DOWN,
    FARM_SERVICE_URL: DOWN,
    PRODUCT_SERVICE_URL: DOWN,
    USER_SERVICE_URL: DOWN,
    ORDER_SERVICE_URL: DOWN,
    INVENTORY_SERVICE_URL: DOWN,
    PAYMENT_SERVICE_URL: DOWN,
    CATALOG_SERVICE_URL: `http://127.0.0.1:${String(port)}`,
  });
});

afterAll(async () => {
  await gateway.close();
  await upstream.close();
});

describe('single Swagger at the gateway', () => {
  it('merges every service spec under public gateway paths', async () => {
    const res = await gateway.inject({ method: 'GET', url: '/api-docs.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<{
      paths: Record<string, unknown>;
      tags: { name: string }[];
      info: { description: string };
    }>();
    expect(Object.keys(spec.paths)).toEqual(['/v1/catalog/categories']);
    expect(spec.tags.map((t) => t.name)).toEqual(['Catalog · Categories']);
    expect(spec.info.description).toContain('`auth-service`');
    expect(spec.info.description).toContain('unavailable');
  });

  it('serves the Swagger UI and the same spec to it', async () => {
    expect((await gateway.inject({ method: 'GET', url: '/api-docs' })).headers.location).toBe(
      '/api-docs/',
    );
    const html = await gateway.inject({ method: 'GET', url: '/api-docs/' });
    expect(html.statusCode).toBe(200);
    expect(html.body).toContain('farmx-docs.js');
    const json = await gateway.inject({ method: 'GET', url: '/api-docs/json' });
    expect(Object.keys(json.json<{ paths: object }>().paths)).toContain('/v1/catalog/categories');
  });

  it('never exposes a per-service Swagger through the proxy', async () => {
    for (const url of ['/v1/auth/api-docs', '/v1/auth/api-docs.json', '/v1/media/api-docs/']) {
      expect((await gateway.inject({ method: 'GET', url })).statusCode).toBe(404);
    }
  });
});
