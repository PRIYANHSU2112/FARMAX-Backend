import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { CategoryRow } from '../../src/features/categories/categories.types.js';
import { etagOf } from '../../src/features/categories/category.tree.js';

// pg connects lazily and Redis/cache are replaced, so no running infrastructure is needed.
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
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
const ID = '01900000-0000-7000-8000-0000000000aa';

const cat = (
  id: string,
  parentId: string | null,
  slug: string,
  extra: Partial<CategoryRow> = {},
) => ({
  id,
  parentId,
  path: parentId === null ? `/${id}/` : `/${parentId}/${id}/`,
  depth: parentId === null ? 0 : 1,
  name: slug,
  nameTe: null,
  slug,
  description: null,
  imageUrl: null,
  sortOrder: 10,
  isActive: true,
  version: 0,
  ...extra,
});
const ROOT = '01900000-0000-7000-8000-000000000101';
const rows: CategoryRow[] = [
  cat(ROOT, null, 'vaccines'),
  cat('01900000-0000-7000-8000-000000000102', ROOT, 'live-vaccines'),
  cat('01900000-0000-7000-8000-000000000103', ROOT, 'hidden', { isActive: false }),
];
const snapshot = { rows, etag: etagOf(rows) };

/** Redis stub: rate-limit store "down" (requests are allowed). Cache serves the fixed snapshot. */
const redisDown = {
  eval: () => Promise.reject(new Error('down')),
  get: () => Promise.resolve(null),
  mget: () => Promise.resolve([null, null]),
};
const cacheStub = {
  getOrSet: () => Promise.resolve(snapshot),
  invalidate: () => Promise.resolve(),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (caller: AuthUser | null, allow = false) => {
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    cache: asValue(cacheStub as never),
    accessClient: asValue({ hasPermission: () => Promise.resolve(allow) } as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return app;
};

describe('storefront category routes (public, cache-first)', () => {
  it('serves the visible tree without auth, with ETag and cache headers', async () => {
    const a = await build(null);
    const res = await a.inject({ method: 'GET', url: '/catalog/categories' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(snapshot.etag);
    expect(res.headers['cache-control']).toContain('max-age=60');
    const tree = res.json<{
      data: { slug: string; childCount: number; children: { slug: string }[] }[];
    }>().data;
    expect(tree.map((n) => n.slug)).toEqual(['vaccines']);
    expect(tree[0]?.children.map((n) => n.slug)).toEqual(['live-vaccines']);
    expect(tree[0]?.childCount).toBe(1);
  });

  it('answers 304 when If-None-Match matches', async () => {
    const a = await build(null);
    const res = await a.inject({
      method: 'GET',
      url: '/catalog/categories',
      headers: { 'if-none-match': snapshot.etag },
    });
    expect(res.statusCode).toBe(304);
    expect(res.body).toBe('');
  });

  it('category page has breadcrumbs; hidden and unknown slugs are 404', async () => {
    const a = await build(null);
    const page = await a.inject({ method: 'GET', url: '/catalog/categories/live-vaccines' });
    expect(page.statusCode).toBe(200);
    expect(page.json<{ data: { breadcrumbs: { slug: string }[] } }>().data.breadcrumbs).toEqual([
      expect.objectContaining({ slug: 'vaccines' }),
    ]);
    expect((await a.inject({ method: 'GET', url: '/catalog/categories/hidden' })).statusCode).toBe(
      404,
    );
    expect((await a.inject({ method: 'GET', url: '/catalog/categories/nope' })).statusCode).toBe(
      404,
    );
  });

  it('lists sub-categories of a slug', async () => {
    const a = await build(null);
    const res = await a.inject({
      method: 'GET',
      url: '/catalog/categories/vaccines/subcategories',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { slug: string }[] }>().data.map((n) => n.slug)).toEqual([
      'live-vaccines',
    ]);
  });

  it('422 on a malformed slug', async () => {
    const a = await build(null);
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/categories/Bad_Slug' })).statusCode,
    ).toBe(422);
  });
});

describe('admin category guards', () => {
  it('401 without a valid token', async () => {
    const a = await build(null);
    const res = await a.inject({ method: 'GET', url: '/admin/catalog/categories', headers: auth });
    expect(res.statusCode).toBe(401);
  });

  it('403 for customers and for staff without the permission', async () => {
    const asCustomer = await build(user('CUSTOMER'), true);
    expect(
      (
        await asCustomer.inject({
          method: 'GET',
          url: '/admin/catalog/categories/tree',
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
    await asCustomer.close();
    const asStaff = await build(user('INTERNAL'), false);
    expect(
      (
        await asStaff.inject({
          method: 'GET',
          url: '/admin/catalog/categories/tree',
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('serves the admin tree (inactive included) to permitted staff', async () => {
    const a = await build(user('INTERNAL'), true);
    const res = await a.inject({
      method: 'GET',
      url: '/admin/catalog/categories/tree',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const kids = res.json<{ data: { children: { slug: string; effectiveActive: boolean }[] }[] }>()
      .data[0]?.children;
    expect(kids?.map((k) => [k.slug, k.effectiveActive])).toEqual([
      ['hidden', false],
      ['live-vaccines', true],
    ]);
  });

  it('422 lists every invalid field before touching the database', async () => {
    const a = await build(user('INTERNAL'), true);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/categories',
      headers: auth,
      payload: { parentId: 'nope', name: 'x', slug: 'Bad Slug', reason: 'short' },
    });
    expect(res.statusCode).toBe(422);
    const paths = res
      .json<{ error: { details: { issues: { path: string }[] } } }>()
      .error.details.issues.map((i) => i.path);
    expect(paths).toEqual(
      expect.arrayContaining(['body.parentId', 'body.name', 'body.slug', 'body.reason']),
    );
  });

  it('422 when delete has no reason', async () => {
    const a = await build(user('INTERNAL'), true);
    const res = await a.inject({
      method: 'DELETE',
      url: `/admin/catalog/categories/${ID}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(422);
  });
});

describe('OpenAPI spec', () => {
  interface Spec {
    paths: Record<
      string,
      Record<string, { tags?: string[]; security?: unknown[]; description?: string }>
    >;
    components: { schemas: Record<string, unknown> };
  }

  it('documents every category route with tags, auth and permissions', async () => {
    const a = await build(null);
    const res = await a.inject({ method: 'GET', url: '/api-docs.json' });
    expect(res.statusCode).toBe(200);
    const spec = res.json<Spec>();
    const expected: [string, string][] = [
      ['/catalog/categories', 'get'],
      ['/catalog/categories/{slug}', 'get'],
      ['/catalog/categories/{slug}/subcategories', 'get'],
      ['/admin/catalog/categories', 'get'],
      ['/admin/catalog/categories', 'post'],
      ['/admin/catalog/categories/tree', 'get'],
      ['/admin/catalog/categories/reorder', 'post'],
      ['/admin/catalog/categories/{id}', 'get'],
      ['/admin/catalog/categories/{id}', 'patch'],
      ['/admin/catalog/categories/{id}', 'delete'],
      ['/admin/catalog/categories/{id}/move', 'post'],
      ['/admin/catalog/categories/{id}/history', 'get'],
    ];
    for (const [path, method] of expected) expect(spec.paths[path]?.[method]).toBeDefined();
    expect(spec.paths['/catalog/categories']?.get?.security).toBeUndefined();
    expect(spec.paths['/admin/catalog/categories/{id}/move']?.post?.description).toContain(
      'catalogue.update',
    );
    expect(Object.keys(spec.components.schemas)).toEqual(
      expect.arrayContaining(['Category', 'CategoryNode', 'CategoryPage', 'CategoryDetail']),
    );
  });

  it('serves no Swagger UI of its own (the gateway hosts the single UI)', async () => {
    const a = await build(null);
    expect((await a.inject({ method: 'GET', url: '/api-docs/' })).statusCode).toBe(404);
  });
});
