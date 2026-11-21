import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

// pg connects lazily and Redis is replaced: guards, validation and docs need no infrastructure.
const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
  INTERNAL_SERVICE_TOKEN: TOKEN,
} as NodeJS.ProcessEnv;

const user = (userType: AuthUser['userType']) =>
  ({
    id: '01900000-0000-7000-8000-000000000001',
    sessionId: 's',
    jti: 'j',
    userType,
    roles: [],
    scope: 'full',
    expiresAt: 0,
  }) as unknown as AuthUser;
const auth = { authorization: 'Bearer test-token' };
const ID = '01900000-0000-7000-8000-0000000000c1';

const redisDown = {
  eval: () => Promise.reject(new Error('down')),
  get: () => Promise.resolve(null),
  set: () => Promise.resolve('OK'),
  incr: () => Promise.resolve(1),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (caller: AuthUser | null, permissions: string[] = []) => {
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    accessClient: asValue({
      hasPermission: (_u: string, key: string) => Promise.resolve(permissions.includes(key)),
    } as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return app;
};

describe('content routes: guards and validation', () => {
  it('401 without a token on reader routes', async () => {
    const a = await build(null);
    const res = await a.inject({ method: 'GET', url: '/farms/content/feed', headers: auth });
    expect(res.statusCode).toBe(401);
  });

  it('403: customers on admin routes, staff on reader routes', async () => {
    const c = await build(user('CUSTOMER'));
    expect(
      (await c.inject({ method: 'GET', url: '/admin/farms/content', headers: auth })).statusCode,
    ).toBe(403);
    await c.close();
    const s = await build(user('INTERNAL'), ['content.view']);
    expect(
      (await s.inject({ method: 'GET', url: '/farms/content/topics', headers: auth })).statusCode,
    ).toBe(403);
  });

  it('separate permissions: manage cannot publish or sign off; review cannot publish', async () => {
    const a = await build(user('INTERNAL'), ['content.view', 'content.manage']);
    for (const path of ['publish', 'sign-off']) {
      const res = await a.inject({
        method: 'POST',
        url: `/admin/farms/content/${ID}/${path}`,
        headers: auth,
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    }
    await a.close();
    const r = await build(user('INTERNAL'), ['content.review']);
    const res = await r.inject({
      method: 'POST',
      url: `/admin/farms/content/${ID}/expire-now`,
      headers: auth,
      payload: { reason: 'Outbreak contained per AHD' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('422: retraction needs a reason and a public note; corrections need a note', async () => {
    const a = await build(user('INTERNAL'), ['content.publish', 'content.manage']);
    const retract = await a.inject({
      method: 'POST',
      url: `/admin/farms/content/${ID}/retract`,
      headers: auth,
      payload: { reason: 'short' },
    });
    expect(retract.statusCode).toBe(422);
    const paths = retract
      .json<{ error: { details: { issues: { path: string }[] } } }>()
      .error.details.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['body.reason', 'body.publicNote']));
    const correction = await a.inject({
      method: 'POST',
      url: `/admin/farms/content/${ID}/corrections`,
      headers: auth,
      payload: { changes: { territoryCodes: ['WG'] } },
    });
    expect(correction.statusCode).toBe(422);
  });

  it('422: an impossible alert area and a PRODUCT CTA without a target are rejected', async () => {
    const a = await build(user('INTERNAL'), ['content.manage']);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/farms/content',
      headers: auth,
      payload: {
        kind: 'ALERT',
        topicId: ID,
        title: 'ND near Tanuku',
        summary: 'Confirmed',
        area: { lat: 123, lng: 81.6 },
        ctas: [{ type: 'PRODUCT', label: 'Buy' }],
      },
    });
    expect(res.statusCode).toBe(422);
  });

  it('internal audience route needs the service token', async () => {
    const a = await build(null);
    const res = await a.inject({
      method: 'GET',
      url: `/internal/farms/content/${ID}/audience?scope=segment`,
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('content OpenAPI', () => {
  interface Spec {
    tags: { name: string }[];
    paths: Record<string, Record<string, { description?: string; tags?: string[] }>>;
  }

  it('documents every reader and admin route; internal routes stay hidden', async () => {
    const a = await build(null);
    const spec = (await a.inject({ method: 'GET', url: '/api-docs.json' })).json<Spec>();
    const paths = Object.keys(spec.paths);
    for (const p of [
      '/farms/content/topics',
      '/farms/content/feed',
      '/farms/content/search',
      '/farms/content/library',
      '/farms/content/library/sync',
      '/farms/content/{idOrSlug}',
      '/farms/content/{id}/save',
      '/farms/content/{id}/feedback',
      '/farms/content/{id}/share',
      '/admin/farms/content',
      '/admin/farms/content/{id}',
      '/admin/farms/content/{id}/submit',
      '/admin/farms/content/{id}/sign-off',
      '/admin/farms/content/{id}/publish',
      '/admin/farms/content/{id}/extend',
      '/admin/farms/content/{id}/expire-now',
      '/admin/farms/content/{id}/retract',
      '/admin/farms/content/{id}/corrections',
      '/admin/farms/content/{id}/corrections/{revisionId}/approve',
      '/admin/farms/content/topics',
      '/admin/farms/content/reviewers',
    ]) {
      expect(paths).toContain(p);
    }
    expect(paths.some((p) => p.startsWith('/internal'))).toBe(false);
    expect(spec.tags.map((t) => t.name)).toEqual(
      expect.arrayContaining(['News & knowledge', 'Admin · Content']),
    );
    expect(spec.paths['/admin/farms/content/{id}/publish']?.post?.description).toContain(
      'content.publish',
    );
    expect(spec.paths['/admin/farms/content/{id}/sign-off']?.post?.description).toContain(
      'content.review',
    );
  });
});
