import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

// The pg pool connects lazily, so these tests need no running database.
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const caller = {
  id: '01900000-0000-7000-8000-000000000001',
  sessionId: 's',
  roles: [],
} as unknown as AuthUser;
const auth = { authorization: 'Bearer test-token' };

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (withToken = true) => {
  app = await buildApp(ENV);
  if (withToken)
    app.diContainer.register({ tokenVerifier: asValue(() => Promise.resolve(caller)) });
  return app;
};

describe('example routes', () => {
  it('fails closed (401) until token verification is configured', async () => {
    const a = await build(false);
    expect((await a.inject({ method: 'GET', url: '/examples', headers: auth })).statusCode).toBe(
      401,
    );
  });

  it('creates (201) and lists (200) with the response envelope', async () => {
    const a = await build();
    const created = await a.inject({
      method: 'POST',
      url: '/examples',
      headers: auth,
      payload: { name: 'First' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      success: true,
      data: { name: 'First', ownerId: caller.id },
    });

    const list = await a.inject({ method: 'GET', url: '/examples', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ success: true, meta: { limit: 20 } });
  });

  it('validates the body (422)', async () => {
    const a = await build();
    const res = await a.inject({ method: 'POST', url: '/examples', headers: auth, payload: {} });
    expect(res.statusCode).toBe(422);
  });

  it('documents the feature in Swagger (/api-docs.json)', async () => {
    const a = await build(false);
    const res = await a.inject({ method: 'GET', url: '/api-docs.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<{
      paths: Record<string, { get?: { tags?: string[]; security?: unknown } }>;
    }>();
    expect(spec.paths['/examples']?.get?.tags).toEqual(['Examples']);
    expect(spec.paths['/examples']?.get?.security).toEqual([{ bearerAuth: [] }]);
  });
});
