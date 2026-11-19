import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { etagOf } from '../../src/features/brands/brands.service.js';
import type { BrandRow } from '../../src/features/brands/brands.types.js';

// pg connects lazily; Redis, cache, repository and transactions are stubbed (no infrastructure).
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const USER_ID = '01900000-0000-7000-8000-000000000001';
const user = {
  id: USER_ID,
  sessionId: 's',
  jti: 'j',
  userType: 'INTERNAL',
  roles: [],
  scope: 'full',
  expiresAt: 0,
} as unknown as AuthUser;
const auth = { authorization: 'Bearer test-token' };

const A = '01900000-0000-7000-8000-000000000201';
const B = '01900000-0000-7000-8000-000000000202';
const row = (id: string, slug: string, extra: Partial<BrandRow> = {}): BrandRow => ({
  id,
  name: slug,
  slug,
  code: slug.toUpperCase(),
  description: null,
  logoUrl: null,
  bannerUrl: null,
  websiteUrl: null,
  countryOfOrigin: null,
  isFeatured: false,
  isActive: true,
  sortOrder: 0,
  version: 0,
  ...extra,
});
const rows = [row(A, 'zoetis', { isFeatured: true }), row(B, 'venkys')];
const snapshot = { rows, etag: etagOf(rows) };
const record = (r: BrandRow) => ({
  ...r,
  createdByUserId: USER_ID,
  updatedByUserId: USER_ID,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

const redisDown = {
  eval: () => Promise.reject(new Error('down')),
  get: () => Promise.resolve(null),
  mget: () => Promise.resolve([null, null]),
};

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (caller: AuthUser | null, allow = false) => {
  const repo = {
    lock: vi.fn(() => Promise.resolve()),
    loadActive: vi.fn(() => Promise.resolve(rows)),
    findLive: vi.fn((id: string) => {
      const r = rows.find((x) => x.id === id);
      return Promise.resolve(r === undefined ? null : record(r));
    }),
    list: vi.fn(() => Promise.resolve({ items: rows.map(record), nextCursor: null, limit: 20 })),
    conflicts: vi.fn(() => Promise.resolve([] as string[])),
    slugsStartingWith: vi.fn(() => Promise.resolve(new Set<string>())),
    create: vi.fn((_tx: unknown, data: Omit<BrandRow, 'version'>) =>
      Promise.resolve(record({ ...data, version: 0 })),
    ),
    update: vi.fn((_tx: unknown, id: string, data: Partial<BrandRow>) =>
      Promise.resolve(record({ ...rows.find((x) => x.id === id)!, ...data, version: 1 })),
    ),
    softDelete: vi.fn(() => Promise.resolve()),
  };
  const audit = { record: vi.fn(() => Promise.resolve()), history: vi.fn() };
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    cache: asValue({
      getOrSet: () => Promise.resolve(snapshot),
      invalidate: () => Promise.resolve(),
    } as never),
    accessClient: asValue({ hasPermission: () => Promise.resolve(allow) } as never),
    brandsRepository: asValue(repo as never),
    auditService: asValue(audit as never),
    runInTransaction: asValue(((work: (tx: unknown) => Promise<unknown>) =>
      work({ outboxEvent: { create: () => Promise.resolve() } })) as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return { a: app, repo, audit };
};

describe('storefront brand routes (public, cache-first)', () => {
  it('lists brands with envelope, meta, ETag; filters isFeatured and q', async () => {
    const { a } = await build(null);
    const res = await a.inject({ method: 'GET', url: '/catalog/brands' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe(snapshot.etag);
    const body = res.json<{
      success: boolean;
      data: { slug: string }[];
      meta: { nextCursor: null };
    }>();
    expect(body.success).toBe(true);
    expect(body.data.map((b) => b.slug)).toEqual(['zoetis', 'venkys']);
    expect(body.meta.nextCursor).toBeNull();
    const featured = await a.inject({ method: 'GET', url: '/catalog/brands?isFeatured=true' });
    expect(featured.json<{ data: { id: string }[] }>().data.map((b) => b.id)).toEqual([A]);
    const q = await a.inject({ method: 'GET', url: '/catalog/brands?q=venk' });
    expect(q.json<{ data: { id: string }[] }>().data.map((b) => b.id)).toEqual([B]);
  });

  it('304 when If-None-Match matches', async () => {
    const { a } = await build(null);
    const res = await a.inject({
      method: 'GET',
      url: '/catalog/brands',
      headers: { 'if-none-match': snapshot.etag },
    });
    expect(res.statusCode).toBe(304);
  });

  it('brand by slug or id; unknown → 404; bad param → 422', async () => {
    const { a } = await build(null);
    expect((await a.inject({ method: 'GET', url: '/catalog/brands/zoetis' })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: `/catalog/brands/${B}` })).statusCode).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/catalog/brands/nope' })).statusCode).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/catalog/brands/Bad_Slug!' })).statusCode).toBe(
      422,
    );
  });
});

describe('admin brand routes (catalogue.manage)', () => {
  it('401 without a token, 403 without the permission', async () => {
    const anon = await build(null);
    expect((await anon.a.inject({ method: 'GET', url: '/admin/catalog/brands' })).statusCode).toBe(
      401,
    );
    await anon.a.close();
    const denied = await build(user, false);
    expect(
      (await denied.a.inject({ method: 'GET', url: '/admin/catalog/brands', headers: auth }))
        .statusCode,
    ).toBe(403);
  });

  it('create → 201 with upper-cased code, audited', async () => {
    const { a, audit } = await build(user, true);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/brands',
      headers: auth,
      payload: { name: 'Hipra', code: 'hipra', countryOfOrigin: 'es', reason: 'onboarding Hipra' },
    });
    expect(res.statusCode).toBe(201);
    const data = res.json<{ data: { code: string; slug: string; countryOfOrigin: string } }>().data;
    expect(data).toMatchObject({ code: 'HIPRA', slug: 'hipra', countryOfOrigin: 'ES' });
    expect(audit.record).toHaveBeenCalled();
  });

  it('duplicate → 409; invalid body → 422 with issues', async () => {
    const { a, repo } = await build(user, true);
    repo.conflicts.mockResolvedValueOnce(['slug']);
    const dup = await a.inject({
      method: 'POST',
      url: '/admin/catalog/brands',
      headers: auth,
      payload: { name: 'Zoetis', code: 'ZOETIS', reason: 'duplicate brand' },
    });
    expect(dup.statusCode).toBe(409);
    const bad = await a.inject({
      method: 'POST',
      url: '/admin/catalog/brands',
      headers: auth,
      payload: { name: 'X', code: 'bad code!' },
    });
    expect(bad.statusCode).toBe(422);
    expect(
      bad.json<{ error: { details: { issues: unknown[] } } }>().error.details.issues.length,
    ).toBeGreaterThan(0);
  });

  it('status toggle returns the new version as ETag; stale If-Match → 409', async () => {
    const { a } = await build(user, true);
    const res = await a.inject({
      method: 'PATCH',
      url: `/admin/catalog/brands/${B}/status`,
      headers: auth,
      payload: { isFeatured: true, reason: 'feature for campaign' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    const stale = await a.inject({
      method: 'PATCH',
      url: `/admin/catalog/brands/${B}/status`,
      headers: { ...auth, 'if-match': '"7"' },
      payload: { isActive: false, reason: 'hide this brand' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('delete → 204 (soft delete); reason required', async () => {
    const { a, repo } = await build(user, true);
    const res = await a.inject({
      method: 'DELETE',
      url: `/admin/catalog/brands/${A}?reason=${encodeURIComponent('brand discontinued')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(repo.softDelete).toHaveBeenCalled();
    expect(
      (await a.inject({ method: 'DELETE', url: `/admin/catalog/brands/${A}`, headers: auth }))
        .statusCode,
    ).toBe(422);
  });
});
