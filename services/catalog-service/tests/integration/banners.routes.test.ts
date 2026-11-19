import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import { etagOf } from '../../src/features/banners/banners.service.js';
import type {
  BannerRecord,
  PlacementRecord,
  SnapshotPlacement,
} from '../../src/features/banners/banners.types.js';

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

const P1 = '01900000-0000-7000-8000-000000000301';
const B1 = '01900000-0000-7000-8000-000000000501';
const B2 = '01900000-0000-7000-8000-000000000502';
const CAT = '01900000-0000-7000-8000-000000000401';
const FUTURE = Date.now() + 86_400_000;

const sb = (id: string, startsAt: number | null = null) => ({
  id,
  title: id,
  subtitle: null,
  imageUrl: 'https://cdn.farmx.in/b.webp',
  mobileImageUrl: null,
  actionType: 'NONE',
  actionTarget: null,
  sortOrder: 0,
  startsAt,
  endsAt: null,
  version: 0,
});
const placements: SnapshotPlacement[] = [
  {
    id: P1,
    code: 'FARMER_HOME_HERO',
    app: 'FARMER',
    page: 'HOME',
    position: 'HERO_SLIDER',
    aspectRatio: '16:9',
    maxItems: 5,
    version: 0,
    banners: [sb(B1), sb(B2, FUTURE)],
  },
];
const snapshot = { placements, etag: etagOf(placements) };

const stamps = {
  createdByUserId: USER_ID,
  updatedByUserId: USER_ID,
  createdAt: new Date(0),
  updatedAt: new Date(0),
};
const placementRecord: PlacementRecord = {
  id: P1,
  code: 'FARMER_HOME_HERO',
  name: 'Hero',
  app: 'FARMER',
  page: 'HOME',
  position: 'HERO_SLIDER',
  aspectRatio: '16:9',
  maxItems: 5,
  isActive: true,
  version: 0,
  ...stamps,
};
const bannerRecord: BannerRecord = {
  id: B1,
  placementId: P1,
  title: 'Sale',
  subtitle: null,
  imageUrl: 'https://cdn.farmx.in/b.webp',
  mobileImageUrl: null,
  actionType: 'NONE',
  actionTarget: null,
  sortOrder: 0,
  isActive: true,
  startDate: null,
  endDate: null,
  version: 0,
  ...stamps,
};

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
    loadSnapshot: vi.fn(() => Promise.resolve(placements)),
    findPlacement: vi.fn((id: string) => Promise.resolve(id === P1 ? placementRecord : null)),
    listPlacements: vi.fn(() =>
      Promise.resolve({ items: [placementRecord], nextCursor: null, limit: 20 }),
    ),
    codeTaken: vi.fn(() => Promise.resolve(false)),
    createPlacement: vi.fn((_tx: unknown, d: Partial<PlacementRecord>) =>
      Promise.resolve({ ...placementRecord, ...d }),
    ),
    updatePlacement: vi.fn((_tx: unknown, _id: string, d: Partial<PlacementRecord>) =>
      Promise.resolve({ ...placementRecord, ...d, version: 1 }),
    ),
    softDeletePlacement: vi.fn(() => Promise.resolve()),
    liveBannerCount: vi.fn(() => Promise.resolve(0)),
    findBanner: vi.fn((id: string) => Promise.resolve(id === B1 ? bannerRecord : null)),
    listBanners: vi.fn(() => Promise.resolve({ items: [bannerRecord], nextCursor: B1, limit: 1 })),
    createBanner: vi.fn((_tx: unknown, d: Partial<BannerRecord>) =>
      Promise.resolve({ ...bannerRecord, ...d }),
    ),
    updateBanner: vi.fn((_tx: unknown, _id: string, d: Partial<BannerRecord>) =>
      Promise.resolve({ ...bannerRecord, ...d, version: 1 }),
    ),
    softDeleteBanner: vi.fn(() => Promise.resolve()),
    countInPlacement: vi.fn((_tx: unknown, _p: string, ids: string[]) =>
      Promise.resolve(ids.length),
    ),
    reorder: vi.fn((_tx: unknown, ids: string[]) => Promise.resolve(ids.length)),
  };
  const audit = { record: vi.fn(() => Promise.resolve()), history: vi.fn() };
  const cache = {
    getOrSet: vi.fn(() => Promise.resolve(snapshot)),
    invalidate: vi.fn(() => Promise.resolve()),
  };
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    cache: asValue(cache as never),
    accessClient: asValue({ hasPermission: () => Promise.resolve(allow) } as never),
    bannersRepository: asValue(repo as never),
    auditService: asValue(audit as never),
    runInTransaction: asValue(((work: (tx: unknown) => Promise<unknown>) => work({})) as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return { a: app, repo, audit, cache };
};

describe('storefront banner routes (public, cache-first)', () => {
  it('lists live banners by app/page; scheduled hidden; ETag + 304', async () => {
    const { a } = await build(null);
    const res = await a.inject({ method: 'GET', url: '/catalog/banners?app=farmer&page=HOME' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      success: boolean;
      data: { code: string; banners: { id: string }[] }[];
    }>();
    expect(body.success).toBe(true);
    expect(body.data.map((p) => p.code)).toEqual(['FARMER_HOME_HERO']);
    expect(body.data[0]!.banners.map((b) => b.id)).toEqual([B1]);
    const etag = res.headers.etag!;
    const again = await a.inject({
      method: 'GET',
      url: '/catalog/banners?app=FARMER&page=HOME',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
  });

  it('serves the second request from memory (one cache load)', async () => {
    const { a, cache } = await build(null);
    await a.inject({ method: 'GET', url: '/catalog/banners?app=FARMER' });
    await a.inject({ method: 'GET', url: '/catalog/banners/placements/FARMER_HOME_HERO' });
    expect(cache.getOrSet).toHaveBeenCalledTimes(1);
  });

  it('by code; unknown → 404; app required → 422', async () => {
    const { a } = await build(null);
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/banners/placements/FARMER_HOME_HERO' }))
        .statusCode,
    ).toBe(200);
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/banners/placements/NOPE_SLOT' })).statusCode,
    ).toBe(404);
    expect((await a.inject({ method: 'GET', url: '/catalog/banners' })).statusCode).toBe(422);
  });
});

describe('admin banner + placement routes (catalogue.manage)', () => {
  it('401 without a token, 403 without the permission', async () => {
    const anon = await build(null);
    expect((await anon.a.inject({ method: 'GET', url: '/admin/catalog/banners' })).statusCode).toBe(
      401,
    );
    await anon.a.close();
    const denied = await build(user, false);
    expect(
      (
        await denied.a.inject({
          method: 'GET',
          url: '/admin/catalog/banner-placements',
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('create placement → 201 upper-cased, audited, cache dropped; duplicate → 409', async () => {
    const { a, repo, audit, cache } = await build(user, true);
    const payload = {
      code: 'farmer_cart_popup',
      name: 'Cart popup',
      app: 'farmer',
      page: 'checkout',
      position: 'popup',
      aspectRatio: '1:1',
      reason: 'new popup slot on checkout',
    };
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banner-placements',
      headers: auth,
      payload,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"0"');
    expect(res.json<{ data: { code: string; app: string } }>().data).toMatchObject({
      code: 'FARMER_CART_POPUP',
      app: 'FARMER',
    });
    expect(audit.record).toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalled();
    repo.codeTaken.mockResolvedValueOnce(true);
    const dup = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banner-placements',
      headers: auth,
      payload,
    });
    expect(dup.statusCode).toBe(409);
  });

  it('delete placement in use → 409 PLACEMENT_IN_USE', async () => {
    const { a, repo } = await build(user, true);
    repo.liveBannerCount.mockResolvedValueOnce(2);
    const res = await a.inject({
      method: 'DELETE',
      url: `/admin/catalog/banner-placements/${P1}?reason=${encodeURIComponent('slot retired now')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'PLACEMENT_IN_USE',
    );
  });

  it('create banner → 201; unknown placement → 404; bad action → 422', async () => {
    const { a } = await build(user, true);
    const base = {
      placementId: P1,
      title: 'Sale',
      imageUrl: 'https://cdn.farmx.in/b.webp',
      actionType: 'CATEGORY',
      actionTarget: CAT,
      reason: 'winter campaign banner',
    };
    const ok = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banners',
      headers: auth,
      payload: base,
    });
    expect(ok.statusCode).toBe(201);
    const missing = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banners',
      headers: auth,
      payload: { ...base, placementId: B2 },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banners',
      headers: auth,
      payload: { ...base, actionTarget: 'not-a-uuid' },
    });
    expect(bad.statusCode).toBe(422);
  });

  it('list → cursor meta; status → new ETag; stale If-Match → 409', async () => {
    const { a } = await build(user, true);
    const list = await a.inject({
      method: 'GET',
      url: `/admin/catalog/banners?placementId=${P1}&state=LIVE&limit=1`,
      headers: auth,
    });
    expect(list.json<{ meta: { nextCursor: string } }>().meta.nextCursor).toBe(B1);
    const res = await a.inject({
      method: 'PATCH',
      url: `/admin/catalog/banners/${B1}/status`,
      headers: auth,
      payload: { isActive: false, reason: 'pause this campaign' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers.etag).toBe('"1"');
    const stale = await a.inject({
      method: 'PATCH',
      url: `/admin/catalog/banners/${B1}`,
      headers: { ...auth, 'if-match': '"7"' },
      payload: { title: 'New title', reason: 'rename the banner' },
    });
    expect(stale.statusCode).toBe(409);
  });

  it('reorder: foreign id → 422; ok → updated count', async () => {
    const { a, repo } = await build(user, true);
    const payload = { placementId: P1, ids: [B2, B1], reason: 'move sale banner first' };
    repo.countInPlacement.mockResolvedValueOnce(1);
    const bad = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banners/reorder',
      headers: auth,
      payload,
    });
    expect(bad.statusCode).toBe(422);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/banners/reorder',
      headers: auth,
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ data: { updated: number } }>().data.updated).toBe(2);
  });

  it('delete banner → 204; reason required → 422', async () => {
    const { a, repo } = await build(user, true);
    const res = await a.inject({
      method: 'DELETE',
      url: `/admin/catalog/banners/${B1}?reason=${encodeURIComponent('campaign is over')}`,
      headers: auth,
    });
    expect(res.statusCode).toBe(204);
    expect(repo.softDeleteBanner).toHaveBeenCalled();
    expect(
      (await a.inject({ method: 'DELETE', url: `/admin/catalog/banners/${B1}`, headers: auth }))
        .statusCode,
    ).toBe(422);
  });
});
