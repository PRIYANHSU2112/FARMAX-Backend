import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';

// pg connects lazily; Redis and the feature services are replaced, so no infrastructure is needed.
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const staff = {
  id: '01900000-0000-7000-8000-000000000001',
  sessionId: 's',
  jti: 'j',
  userType: 'INTERNAL',
  roles: [],
  scope: 'full',
  expiresAt: 0,
} as unknown as AuthUser;
const auth = { authorization: 'Bearer test-token' };
const ID = '01900000-0000-7000-8000-0000000000d1';

const redisDown = {
  eval: () => Promise.reject(new Error('down')),
  get: () => Promise.resolve(null),
  mget: () => Promise.resolve([null, null]),
};

const card = {
  id: ID,
  name: 'Coccidiosis',
  slug: 'coccidiosis',
  description: null,
  iconUrl: null,
  productCount: 4,
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (caller: AuthUser | null, permissions: string[] = []) => {
  const diseases = {
    publicList: vi.fn(() => Promise.resolve([card])),
    list: vi.fn(() => Promise.resolve([])),
    detail: vi.fn(() => Promise.resolve({ ...card, version: 2 })),
    create: vi.fn((input: object) => Promise.resolve({ id: ID, ...input, version: 0 })),
    update: vi.fn(() => Promise.resolve({ ...card, version: 3 })),
    remove: vi.fn(() => Promise.resolve()),
  };
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    accessClient: asValue({
      hasPermission: (_user: string, key: string) => Promise.resolve(permissions.includes(key)),
    } as never),
    diseasesService: asValue(diseases as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return { a: app, diseases };
};

describe('storefront disease cards (public)', () => {
  it('lists cards with envelope + ETag; hideEmpty passed through; 304 on match', async () => {
    const { a, diseases } = await build(null);
    const res = await a.inject({ method: 'GET', url: '/catalog/diseases?hideEmpty=true' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: [card] });
    expect(diseases.publicList).toHaveBeenCalledWith({ hideEmpty: true });
    const again = await a.inject({
      method: 'GET',
      url: '/catalog/diseases?hideEmpty=true',
      headers: { 'if-none-match': String(res.headers.etag) },
    });
    expect(again.statusCode).toBe(304);
  });

  it('422 on a non-boolean hideEmpty', async () => {
    const { a } = await build(null);
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/diseases?hideEmpty=maybe' })).statusCode,
    ).toBe(422);
  });
});

describe('admin disease routes', () => {
  const body = { name: 'Coccidiosis', reason: 'home screen Shop by Problem' };

  it('401 without a token, 403 without catalogue.manage', async () => {
    const anon = await build(null);
    expect(
      (await anon.a.inject({ method: 'POST', url: '/admin/catalog/diseases', payload: body }))
        .statusCode,
    ).toBe(401);
    await anon.a.close();
    const denied = await build(staff, []);
    expect(
      (
        await denied.a.inject({
          method: 'POST',
          url: '/admin/catalog/diseases',
          headers: auth,
          payload: body,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('create → 201 with ETag; invalid slug / short reason → 422', async () => {
    const { a, diseases } = await build(staff, ['catalogue.manage']);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/diseases',
      headers: auth,
      payload: { ...body, iconUrl: 'https://cdn.farmx.in/i.png' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"0"');
    expect(diseases.create).toHaveBeenCalled();

    const bad = await a.inject({
      method: 'POST',
      url: '/admin/catalog/diseases',
      headers: auth,
      payload: { name: 'X', slug: 'Bad Slug', reason: 'short' },
    });
    expect(bad.statusCode).toBe(422);
    const paths = bad
      .json<{ error: { details: { issues: { path: string }[] } } }>()
      .error.details.issues.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(['body.name', 'body.slug', 'body.reason']));
  });

  it('update passes If-Match; delete needs a reason → 204', async () => {
    const { a, diseases } = await build(staff, ['catalogue.manage']);
    const upd = await a.inject({
      method: 'PATCH',
      url: `/admin/catalog/diseases/${ID}`,
      headers: { ...auth, 'if-match': '"2"' },
      payload: { sortOrder: 1, reason: 'reorder the home cards' },
    });
    expect(upd.statusCode).toBe(200);
    expect(diseases.update).toHaveBeenCalledWith(
      ID,
      { sortOrder: 1, reason: 'reorder the home cards' },
      2,
      expect.objectContaining({ userId: staff.id }),
    );

    expect(
      (
        await a.inject({
          method: 'DELETE',
          url: `/admin/catalog/diseases/${ID}`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(422);
    const del = await a.inject({
      method: 'DELETE',
      url: `/admin/catalog/diseases/${ID}?reason=${encodeURIComponent('merged into CRD card')}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
  });
});
