import { NotFoundError } from '../../errors/index.js';
import { createLogger } from '../../logger/index.js';
import { getRequestContext } from '../../middleware/index.js';
import type { Cradle } from '@fastify/awilix';
import { asFunction, createContainer } from 'awilix';
import Fastify, { type FastifyInstance, type FastifyPluginAsync } from 'fastify';
import Joi from 'joi';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ServiceOptions, buildService, registerDocsUi } from '../index.js';

interface Greeter {
  greet: (name: string) => string;
}

declare module '@fastify/awilix' {
  interface Cradle {
    greeter: Greeter;
  }
}

const config = {
  NODE_ENV: 'test',
  APP_ENV: 'local',
  SERVICE_NAME: 'test-service',
  SERVICE_VERSION: '0.0.0',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  SHUTDOWN_TIMEOUT_MS: 5_000,
} as const;

const routes: FastifyPluginAsync = async (app) => {
  app.get('/greet/:name', {
    schema: { params: Joi.object({ name: Joi.string().min(2).required() }) },
    handler: async (request) => {
      const { name } = request.params as { name: string };
      return { message: request.diScope.resolve('greeter').greet(name) };
    },
  });

  app.post('/users', {
    schema: {
      body: Joi.object({ email: Joi.string().email().required(), age: Joi.number().min(18) }),
    },
    handler: async (request, reply) => reply.status(201).send({ received: request.body }),
  });

  app.get('/missing', async () => {
    throw new NotFoundError('Order');
  });

  app.get('/crash', async () => {
    throw new Error('db password=secret leaked in message');
  });

  app.get('/context', async (request) => ({
    contextId: getRequestContext()?.requestId,
    requestId: request.id,
    scopedId: request.diScope.resolve('requestId'),
  }));
};

let app: FastifyInstance | undefined;

const build = async (overrides: Partial<ServiceOptions> = {}) => {
  const container = createContainer<Cradle>({ strict: true });
  container.register({
    greeter: asFunction(() => ({ greet: (name: string) => `hello ${name}` })).singleton(),
  });

  app = await buildService({
    config,
    logger: createLogger({ service: 'test-service', level: 'silent', pretty: false }),
    container,
    routes,
    routePrefix: '/v1',
    ...overrides,
  });
  return app;
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('buildService', () => {
  it('serves liveness and readiness', async () => {
    const service = await build({ healthChecks: { db: async () => {} } });

    const live = await service.inject({ method: 'GET', url: '/health/live' });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });

    const ready = await service.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toEqual({ status: 'ok', checks: { db: 'up' } });
  });

  it('returns 503 when a readiness check fails or times out', async () => {
    const service = await build({
      healthChecks: {
        db: async () => {},
        redis: () => Promise.reject(new Error('ECONNREFUSED')),
        slow: () => new Promise((resolve) => setTimeout(resolve, 5_000)),
      },
    });

    const ready = await service.inject({ method: 'GET', url: '/health/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({
      status: 'degraded',
      checks: { db: 'up', redis: 'down', slow: 'down' },
    });
  }, 10_000);

  it('resolves dependencies from the Awilix container', async () => {
    const service = await build();
    const res = await service.inject({ method: 'GET', url: '/v1/greet/farmer' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ message: 'hello farmer' });
  });

  it('validates with Joi and returns every issue with its location', async () => {
    const service = await build();
    const res = await service.inject({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'not-an-email', age: 12 },
    });

    expect(res.statusCode).toBe(422);
    const body = res.json<{ success: boolean; error: { code: string; details: unknown } }>();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details).toEqual({
      issues: [
        { path: 'body.email', message: '"email" must be a valid email' },
        { path: 'body.age', message: '"age" must be greater than or equal to 18' },
      ],
    });
  });

  it('strips unknown body fields', async () => {
    const service = await build();
    const res = await service.inject({
      method: 'POST',
      url: '/v1/users',
      payload: { email: 'a@farmx.in', isAdmin: true },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ received: { email: 'a@farmx.in' } });
  });

  it('maps AppErrors to the error envelope with requestId', async () => {
    const service = await build();
    const res = await service.inject({ method: 'GET', url: '/v1/missing' });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'Order not found',
        requestId: res.headers['x-request-id'],
      },
    });
  });

  it('hides the details of unexpected errors', async () => {
    const service = await build();
    const res = await service.inject({ method: 'GET', url: '/v1/crash' });

    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret');
    expect(res.json()).toMatchObject({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
  });

  it('returns the envelope for unknown routes and malformed JSON', async () => {
    const service = await build();

    const notFound = await service.inject({ method: 'GET', url: '/nope' });
    expect(notFound.statusCode).toBe(404);
    expect(notFound.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });

    const badJson = await service.inject({
      method: 'POST',
      url: '/v1/users',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(badJson.statusCode).toBe(400);
    expect(badJson.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
  });

  it('reuses a valid incoming x-request-id and replaces an unsafe one', async () => {
    const service = await build();

    const valid = await service.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { 'x-request-id': 'gateway-req-12345' },
    });
    expect(valid.headers['x-request-id']).toBe('gateway-req-12345');
    expect(valid.json()).toEqual({
      contextId: 'gateway-req-12345',
      requestId: 'gateway-req-12345',
      scopedId: 'gateway-req-12345',
    });

    const unsafe = await service.inject({
      method: 'GET',
      url: '/v1/context',
      headers: { 'x-request-id': 'bad\nid injected' },
    });
    expect(unsafe.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets security headers', async () => {
    const service = await build();
    const res = await service.inject({ method: 'GET', url: '/health/live' });
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toContain('max-age=31536000');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('allows CORS only for configured origins', async () => {
    const service = await build({ corsOrigins: ['https://farmx.in'] });

    const allowed = await service.inject({
      method: 'OPTIONS',
      url: '/v1/greet/ab',
      headers: { origin: 'https://farmx.in', 'access-control-request-method': 'GET' },
    });
    expect(allowed.headers['access-control-allow-origin']).toBe('https://farmx.in');

    const blocked = await service.inject({
      method: 'OPTIONS',
      url: '/v1/greet/ab',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' },
    });
    expect(blocked.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('generates OpenAPI 3.0.3 from Joi schemas at /api-docs.json', async () => {
    const service = await build({ docs: { title: 'Test API', version: '1.0.0' } });
    const res = await service.inject({ method: 'GET', url: '/api-docs.json' });

    expect(res.statusCode).toBe(200);
    const spec = res.json<{ openapi: string; paths: Record<string, unknown> }>();
    expect(spec.openapi).toBe('3.0.3');
    expect(Object.keys(spec.paths)).toContain('/v1/users');
    // Health routes are documented as public (no security).
    expect(JSON.stringify(spec.paths['/health/live'])).not.toContain('bearerAuth');
    expect(JSON.stringify(spec.paths['/v1/users'])).toContain('"format":"email"');
    expect(Object.keys(spec.paths)).not.toContain('/api-docs.json');
  });

  it('serves only the spec from a service (no per-service Swagger UI)', async () => {
    const service = await build({ docs: { title: 'Test API', version: '1.0.0' } });
    expect((await service.inject({ method: 'GET', url: '/api-docs/' })).statusCode).toBe(404);
  });

  it('registerDocsUi serves the single Swagger UI with a freshly loaded spec', async () => {
    const merged = {
      openapi: '3.0.3',
      info: { title: 'All', version: '1' },
      paths: { '/v1/x': {} },
    };
    const load = vi.fn(() => Promise.resolve(merged));
    const ui = Fastify();
    await ui.register(async (scope) => {
      await registerDocsUi(scope, { title: 'FarmX API', load });
    });
    app = ui;

    const html = await ui.inject({ method: 'GET', url: '/api-docs/' });
    expect(html.statusCode).toBe(200);
    // Relative asset URLs, so the page also works behind a prefix.
    expect(html.body).toContain('./static/theme/farmx-docs.js');
    const redirect = await ui.inject({ method: 'GET', url: '/api-docs' });
    expect(redirect.statusCode).toBe(302);
    expect(redirect.headers.location).toBe('/api-docs/');
    const script = await ui.inject({ method: 'GET', url: '/api-docs/static/theme/farmx-docs.js' });
    expect(script.body).toContain('farmx-auth-banner');

    expect((await ui.inject({ method: 'GET', url: '/api-docs/json' })).json()).toEqual(merged);
    expect((await ui.inject({ method: 'GET', url: '/api-docs.json' })).json()).toEqual(merged);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('disposes DI resources when the app closes', async () => {
    const close = vi.fn();
    const container = createContainer<Cradle>({ strict: true });
    container.register({
      greeter: asFunction(() => ({ greet: () => '' }))
        .singleton()
        .disposer(close),
    });
    const service = await build({ container });
    await service.inject({ method: 'GET', url: '/v1/greet/ab' });

    await service.close();
    app = undefined;
    expect(close).toHaveBeenCalledOnce();
  });
});
