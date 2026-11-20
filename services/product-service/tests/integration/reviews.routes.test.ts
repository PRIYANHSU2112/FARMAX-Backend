import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const user = (userType: string, id: string) =>
  ({
    id,
    sessionId: 's',
    jti: 'j',
    userType,
    roles: [],
    scope: 'full',
    expiresAt: 0,
  }) as unknown as AuthUser;
const staff = user('INTERNAL', '01900000-0000-7000-8000-000000000001');
const buyer = user('CUSTOMER', '01900000-0000-7000-8000-000000000002');
const auth = { authorization: 'Bearer test-token' };
const P = '01900000-0000-7000-8000-0000000000aa';
const R = '01900000-0000-7000-8000-0000000000bb';

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

const build = async (caller: AuthUser | null, permissions: string[] = []) => {
  const reviews = {
    publicList: vi.fn(() =>
      Promise.resolve({ items: [{ id: R, rating: 5 }], nextCursor: null, limit: 20 }),
    ),
    summary: vi.fn(() => Promise.resolve({ productId: P, ratingAvg: '4.50', ratingCount: 2 })),
    create: vi.fn(() => Promise.resolve({ id: R, version: 0, status: 'PUBLISHED' })),
    update: vi.fn(() => Promise.resolve({ id: R, version: 1 })),
    remove: vi.fn(() => Promise.resolve()),
    vote: vi.fn(() => Promise.resolve({ helpfulCount: 1 })),
    report: vi.fn(() => Promise.resolve({ reportId: R })),
    mine: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
    pending: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
    votedIds: vi.fn(() => Promise.resolve([R])),
  };
  const moderation = {
    list: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
    moderate: vi.fn(() => Promise.resolve({ id: R, version: 2, status: 'HIDDEN' })),
    bulk: vi.fn(() => Promise.resolve([{ id: R, ok: true, status: 'PUBLISHED' }])),
    analytics: vi.fn(() => Promise.resolve({ totals: {} })),
  };
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    accessClient: asValue({
      hasPermission: (_user: string, key: string) => Promise.resolve(permissions.includes(key)),
    } as never),
    reviewsService: asValue(reviews as never),
    moderationService: asValue(moderation as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return { a: app, reviews, moderation };
};

describe('storefront reviews', () => {
  it('public list + summary with envelope and ETag (no token)', async () => {
    const { a, reviews } = await build(null);
    const list = await a.inject({ url: `/catalog/products/${P}/reviews?sort=helpful&rating=5` });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ success: true, data: [{ id: R }], meta: { limit: 20 } });
    expect(list.headers.etag).toBeDefined();
    expect(reviews.publicList).toHaveBeenCalledWith(
      P,
      expect.objectContaining({ sort: 'helpful', rating: 5 }),
    );
    const sum = await a.inject({ url: `/catalog/products/enrocin-10/rating-summary` });
    expect(sum.json()).toMatchObject({ success: true, data: { ratingAvg: '4.50' } });
  });

  it('422 on a bad sort or rating', async () => {
    const { a } = await build(null);
    const res = await a.inject({ url: `/catalog/products/${P}/reviews?sort=best&rating=9` });
    expect(res.statusCode).toBe(422);
    const body = res.json<{ error: { details: { issues: unknown[] } } }>();
    expect(body.error.details.issues.length).toBeGreaterThan(0);
  });
});

describe('customer reviews', () => {
  it('401 without a token; 403 for staff (customers only)', async () => {
    const anon = await build(null);
    expect(
      (
        await anon.a.inject({
          method: 'POST',
          url: `/catalog/products/${P}/reviews`,
          payload: { rating: 5 },
        })
      ).statusCode,
    ).toBe(401);
    await anon.a.close();
    const { a } = await build(staff);
    const res = await a.inject({
      method: 'POST',
      url: `/catalog/products/${P}/reviews`,
      headers: auth,
      payload: { rating: 5 },
    });
    expect(res.statusCode).toBe(403);
  });

  it('create → 201 with ETag; rating 1–5 and ≤ 5 images enforced', async () => {
    const { a, reviews } = await build(buyer);
    const ok = await a.inject({
      method: 'POST',
      url: `/catalog/products/${P}/reviews`,
      headers: auth,
      payload: { rating: 5, title: 'Works', body: 'Cleared CRD fast' },
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.headers.etag).toBe('"0"');
    expect(reviews.create).toHaveBeenCalledWith(
      P,
      expect.objectContaining({ rating: 5 }),
      expect.objectContaining({ userId: buyer.id }),
    );
    const bad = await a.inject({
      method: 'POST',
      url: `/catalog/products/${P}/reviews`,
      headers: auth,
      payload: {
        rating: 6,
        images: Array.from({ length: 6 }, () => ({ mediaId: R, url: 'https://cdn/x.jpg' })),
      },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('edit passes If-Match; delete → 204; helpful vote; report needs a note for OTHER', async () => {
    const { a, reviews } = await build(buyer);
    const edit = await a.inject({
      method: 'PATCH',
      url: `/catalog/reviews/${R}`,
      headers: { ...auth, 'if-match': '"0"' },
      payload: { rating: 3 },
    });
    expect(edit.statusCode).toBe(200);
    expect(reviews.update).toHaveBeenCalledWith(R, { rating: 3 }, 0, expect.anything());
    expect(
      (await a.inject({ method: 'DELETE', url: `/catalog/reviews/${R}`, headers: auth }))
        .statusCode,
    ).toBe(204);
    const vote = await a.inject({
      method: 'PUT',
      url: `/catalog/reviews/${R}/helpful`,
      headers: auth,
    });
    expect(vote.json()).toMatchObject({ data: { helpfulCount: 1 } });
    const noNote = await a.inject({
      method: 'POST',
      url: `/catalog/reviews/${R}/reports`,
      headers: auth,
      payload: { reason: 'OTHER' },
    });
    expect(noNote.statusCode).toBe(422);
    const report = await a.inject({
      method: 'POST',
      url: `/catalog/reviews/${R}/reports`,
      headers: auth,
      payload: { reason: 'SPAM' },
    });
    expect(report.statusCode).toBe(201);
  });
});

describe('admin reviews', () => {
  it('403 without reviews.view; list with it', async () => {
    const denied = await build(staff, []);
    expect(
      (await denied.a.inject({ url: '/admin/catalog/reviews', headers: auth })).statusCode,
    ).toBe(403);
    await denied.a.close();
    const { a, moderation } = await build(staff, ['reviews.view']);
    const res = await a.inject({
      url: '/admin/catalog/reviews?status=PENDING&flagged=true&q=whatsapp',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(moderation.list).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'PENDING', flagged: true, q: 'whatsapp' }),
    );
  });

  it('moderation needs reviews.moderate (view is not enough); hide sends the reason + If-Match', async () => {
    const viewer = await build(staff, ['reviews.view']);
    expect(
      (
        await viewer.a.inject({
          method: 'POST',
          url: `/admin/catalog/reviews/${R}/hide`,
          headers: auth,
          payload: { reason: 'Contains a phone number' },
        })
      ).statusCode,
    ).toBe(403);
    await viewer.a.close();
    const { a, moderation } = await build(staff, ['reviews.moderate']);
    const res = await a.inject({
      method: 'POST',
      url: `/admin/catalog/reviews/${R}/hide`,
      headers: { ...auth, 'if-match': '1' },
      payload: { reason: 'Contains a phone number' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"2"');
    expect(moderation.moderate).toHaveBeenCalledWith(
      R,
      'hide',
      'Contains a phone number',
      1,
      expect.objectContaining({ userId: staff.id }),
    );
    const bulk = await a.inject({
      method: 'POST',
      url: '/admin/catalog/reviews/bulk-status',
      headers: auth,
      payload: { ids: [R], action: 'approve' },
    });
    expect(bulk.json()).toMatchObject({ data: { succeeded: 1, failed: 0 } });
  });

  it('publishes the review routes in the OpenAPI spec', async () => {
    const { a } = await build(null);
    const spec = (await a.inject({ url: '/api-docs.json' })).json<{
      paths: Record<string, unknown>;
    }>();
    const paths = Object.keys(spec.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/catalog/products/{slugOrId}/reviews',
        '/catalog/products/{slugOrId}/rating-summary',
        '/catalog/reviews/{id}',
        '/admin/catalog/reviews/{id}/approve',
        '/admin/catalog/reviews/reports/{id}/resolve',
        '/admin/catalog/reviews/analytics',
      ]),
    );
  });
});
