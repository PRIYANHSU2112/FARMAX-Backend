import { ServiceUnavailableError, UnauthorizedError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { createCache } from '@farmx/infra/redis';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';
import type { LayoutTree, SectionInput } from '../../src/features/home/home.types.js';

// pg connects lazily; the home repository, Redis and every upstream service are faked in memory.
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const FARMER = '01900000-0000-7000-8000-000000000001';
const STAFF = '01900000-0000-7000-8000-000000000003';
const P1 = '01900000-0000-7000-8000-000000000201';
const P2 = '01900000-0000-7000-8000-000000000202';
const P3 = '01900000-0000-7000-8000-000000000203';
const GONE = '01900000-0000-7000-8000-000000000299';
const C1 = '01900000-0000-7000-8000-000000000301';
const C2 = '01900000-0000-7000-8000-000000000302';
const FARM_A = '01900000-0000-7000-8000-000000000401';
const FARM_B = '01900000-0000-7000-8000-000000000402';
const NODE = '01900000-0000-7000-8000-000000000501';

const userOf = (id: string, userType: string) =>
  ({
    id,
    sessionId: 's',
    jti: 'j',
    userType,
    roles: [],
    scope: 'full',
    expiresAt: 0,
  }) as unknown as AuthUser;
const BEARER = { authorization: 'Bearer t' };
const APP = { 'x-platform': 'android', 'x-device-id': 'device-0001', 'x-sdui-version': '1' };

/** Redis double: strings + a working rate-limit counter (`eval`). */
const fakeRedis = () => {
  const store = new Map<string, string>();
  const counters = new Map<string, number>();
  return {
    store,
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    set: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    },
    del: (...ks: string[]) => {
      for (const k of ks) store.delete(k);
      return Promise.resolve(ks.length);
    },
    mget: (...ks: string[]) => Promise.resolve(ks.map((k) => store.get(k) ?? null)),
    eval: (_script: string, _n: number, key: string) => {
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return Promise.resolve([count, 60]);
    },
    pipeline: () => ({ set: () => undefined, exec: () => Promise.resolve([]) }),
  };
};

type Layout = LayoutTree;

/** In-memory HomeRepository (same contract). Enforces one PUBLISHED / SCHEDULED per page. */
const homeRepo = () => {
  const layouts: Layout[] = [];
  let seq = 600;
  const nextId = () => `01900000-0000-7000-8000-${String((seq += 1)).padStart(12, '0')}`;
  const find = (id: string) => layouts.find((l) => l.id === id);
  const row = (l: Layout) => {
    const copy: Partial<Layout> = structuredClone(l);
    delete copy.sections;
    return copy as Omit<Layout, 'sections'>;
  };
  const repo = {
    layouts,
    lockPage: () => Promise.resolve(),
    nextLayoutNo: (_tx: unknown, page: string) =>
      Promise.resolve(
        Math.max(0, ...layouts.filter((l) => l.page === page).map((l) => l.layoutNo)) + 1,
      ),
    nextPublishRev: (_tx: unknown, page: string) =>
      Promise.resolve(
        Math.max(0, ...layouts.filter((l) => l.page === page).map((l) => l.publishRev ?? 0)) + 1,
      ),
    create: (
      _tx: unknown,
      d: {
        page: 'HOME';
        layoutNo: number;
        name: string;
        notes: string | null;
        settings: object;
        userId: string;
      },
    ) => {
      const l: Layout = {
        id: nextId(),
        page: d.page,
        layoutNo: d.layoutNo,
        name: d.name,
        status: 'DRAFT',
        notes: d.notes,
        settings: d.settings,
        scheduledPublishAt: null,
        publishedAt: null,
        publishedByUserId: null,
        publishRev: null,
        version: 0,
        createdByUserId: d.userId,
        updatedByUserId: d.userId,
        createdAt: new Date(),
        updatedAt: new Date(),
        sections: [],
      };
      layouts.push(l);
      return Promise.resolve(row(l));
    },
    findRow: (id: string) => Promise.resolve(find(id) ? row(find(id)!) : null),
    tree: (id: string) => Promise.resolve(find(id) ? structuredClone(find(id)!) : null),
    live: (page: string) => {
      const l = layouts.find((x) => x.page === page && x.status === 'PUBLISHED');
      return Promise.resolve(l ? structuredClone(l) : null);
    },
    scheduled: (page: string) => {
      const l = layouts.find((x) => x.page === page && x.status === 'SCHEDULED');
      return Promise.resolve(l ? row(l) : null);
    },
    published: (_tx: unknown, page: string) => {
      const l = layouts.find((x) => x.page === page && x.status === 'PUBLISHED');
      return Promise.resolve(l ? row(l) : null);
    },
    list: (q: { limit: number }) =>
      Promise.resolve({
        items: layouts.map((l) => ({ ...row(l), sectionCount: l.sections.length })),
        nextCursor: null,
        limit: q.limit,
      }),
    update: (
      _tx: unknown,
      id: string,
      guard: { version?: number; status?: string },
      patch: Record<string, unknown>,
    ) => {
      const l = find(id);
      if (
        !l ||
        (guard.version !== undefined && l.version !== guard.version) ||
        (guard.status !== undefined && l.status !== guard.status)
      )
        return Promise.resolve(false);
      Object.assign(l, patch, { version: l.version + 1 });
      if (
        (l.status === 'PUBLISHED' || l.status === 'SCHEDULED') &&
        layouts.some((o) => o !== l && o.page === l.page && o.status === l.status)
      )
        throw new Error(`unique violation: two ${l.status} layouts`);
      return Promise.resolve(true);
    },
    replaceSections: (_tx: unknown, id: string, sections: SectionInput[]) => {
      find(id)!.sections = sections.map((s, i) => ({
        ...s,
        id: nextId(),
        displayOrder: s.displayOrder ?? (i + 1) * 10,
        items: s.items.map((it, j) => ({
          ...it,
          id: nextId(),
          displayOrder: it.displayOrder ?? (j + 1) * 10,
          refBroken: false,
        })),
      }));
      return Promise.resolve();
    },
    setDisplayOrder: (_tx: unknown, id: string, keys: string[]) => {
      keys.forEach((k, i) => {
        const s = find(id)!.sections.find((x) => x.sectionKey === k);
        if (s) s.displayOrder = (i + 1) * 10;
      });
      return Promise.resolve();
    },
    markBroken: (_tx: unknown, id: string, ids: string[]) => {
      for (const s of find(id)!.sections)
        for (const it of s.items) it.refBroken = ids.includes(it.id);
      return Promise.resolve();
    },
  };
  return repo;
};

const sec = (key: string, extra: Partial<SectionInput>): SectionInput => ({
  sectionKey: key,
  widgetType: 'PRODUCT_GRID_2X2',
  dataSource: 'DYNAMIC_QUERY',
  feedKey: null,
  eyebrow: null,
  title: { en: key, hi: `${key}-hi` },
  subtitle: null,
  viewAllLink: null,
  isEnabled: true,
  itemLimit: 4,
  minItems: 1,
  inline: false,
  experimentKey: null,
  config: {},
  targeting: null,
  items: [],
  ...extra,
});

const item = (refType: 'CATEGORY' | 'PRODUCT' | 'CUSTOM', refId: string | null, extra = {}) => ({
  refType,
  refId,
  refCode: null,
  label: { en: `label-${refId ?? 'x'}` },
  subtitle: null,
  badge: null,
  image: null,
  deepLink: 'farmx://x',
  isEnabled: true,
  targeting: null,
  ...extra,
});

/** The live layout the tests start from (layout #1, publishRev 1). */
const LIVE_SECTIONS: SectionInput[] = [
  sec('hero', {
    widgetType: 'BANNER_CAROUSEL',
    dataSource: 'BANNER_PLACEMENT',
    config: { placementCode: 'HOME_TOP' },
  }),
  sec('categories', {
    widgetType: 'CATEGORY_GRID',
    dataSource: 'STATIC_ITEMS',
    items: [item('CATEGORY', C1), item('CATEGORY', C2, { targeting: { regions: ['WG'] } })],
  }),
  sec('live-order', {
    widgetType: 'LIVE_ORDER_STRIP',
    dataSource: 'REMOTE_FEED',
    feedKey: 'ORDER_LIVE',
  }),
  sec('appointment', {
    widgetType: 'APPOINTMENT_CARD',
    dataSource: 'REMOTE_FEED',
    feedKey: 'APPOINTMENT_NEXT',
  }),
  sec('featured', { inline: true, config: { query: { isFeatured: true, inStock: true } } }),
  sec('clearance', {
    widgetType: 'PRODUCT_HORIZONTAL_RAIL',
    dataSource: 'MANUAL_PRODUCTS',
    itemLimit: 2,
    items: [item('PRODUCT', P1), item('PRODUCT', P2), item('PRODUCT', P3)],
  }),
  sec('ios-only', { config: { query: {} }, targeting: { platforms: ['ios'] } }),
  sec('ab-test', {
    config: { query: {} },
    experimentKey: 'rail-test',
    targeting: { rollout: { percent: 50, salt: 'rail-test' } },
  }),
];

const card = (id: string) => ({
  id,
  name: id,
  slug: id,
  imageUrl: null,
  available: true,
  isPrescriptionRequired: id === P1,
  inStock: true,
});

interface Opts {
  caller?: AuthUser | null;
  expired?: boolean;
  permissions?: string[];
  productsDown?: boolean;
  catalogDown?: boolean;
}

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (opts: Opts = {}, repo = homeRepo()) => {
  if (repo.layouts.length === 0) {
    const live = await repo.create(null, {
      page: 'HOME',
      layoutNo: 1,
      name: 'Launch',
      notes: null,
      settings: { orderPhones: { default: '+911111111111', byRegion: { WG: '+912222222222' } } },
      userId: STAFF,
    });
    await repo.replaceSections(null, live.id, LIVE_SECTIONS);
    Object.assign(repo.layouts[0]!, { status: 'PUBLISHED', publishRev: 1, version: 1 });
  }
  const redis = fakeRedis();
  const productClient = {
    cards: vi.fn((ids: string[]) =>
      opts.productsDown === true
        ? Promise.reject(new ServiceUnavailableError('Product service unavailable'))
        : Promise.resolve(
            new Map(ids.filter((id) => id !== GONE).map((id) => [id, card(id)] as const)),
          ),
    ),
    list: vi.fn(() =>
      opts.productsDown === true
        ? Promise.reject(new Error('down'))
        : Promise.resolve({ items: [card(P1), card(P2)], nextCursor: 'next-1' }),
    ),
    diseaseIds: vi.fn(() => Promise.resolve(new Set<string>())),
    flockStageCodes: vi.fn(() => Promise.resolve(new Set(['GROWER']))),
  };
  const catalogClient = {
    placement: vi.fn((code: string) =>
      opts.catalogDown === true
        ? Promise.reject(new Error('down'))
        : Promise.resolve(
            code === 'HOME_TOP'
              ? {
                  code,
                  aspectRatio: '16:9',
                  maxItems: 5,
                  banners: [{ id: 'b1', title: 'Offer', imageUrl: 'https://cdn.farmx.in/b1.webp' }],
                }
              : null,
          ),
    ),
    categories: vi.fn(() => Promise.resolve([])),
    categoryIds: vi.fn(() => Promise.resolve(new Set([C1, C2]))),
    brandExists: vi.fn(() => Promise.resolve(true)),
  };
  const farmClient = {
    context: vi.fn((_bearer: string, farmId: string | undefined) =>
      Promise.resolve({
        farmId: farmId === FARM_B ? FARM_B : FARM_A,
        farmName: 'Shed farm',
        category: 'POULTRY_FARM',
        productionTypes: ['LAYER'],
        totalBirdCapacity: 18_500,
        territoryCode: farmId === FARM_B ? 'KR' : 'WG',
        primaryNodeId: NODE,
      }),
    ),
    latestNews: vi.fn(() => Promise.resolve([{ id: 'n1', title: 'Biosecurity checks' }])),
  };
  const orderClient = {
    latestActiveOrder: vi.fn(() =>
      Promise.resolve({ id: 'o1', orderNo: 'ORD-91842', status: 'IN_FULFILMENT' }),
    ),
  };
  const audit = {
    record: vi.fn(() => Promise.resolve()),
    history: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
  };
  const caller = opts.caller ?? null;
  app = await buildApp(ENV);
  app.diContainer.register({
    redis: asValue(redis as never),
    cache: asValue(createCache(redis as never)),
    accessClient: asValue({
      hasPermission: (_u: string, key: string) =>
        Promise.resolve((opts.permissions ?? []).includes(key)),
    } as never),
    homeRepository: asValue(repo as never),
    auditService: asValue(audit as never),
    productClient: asValue(productClient as never),
    catalogClient: asValue(catalogClient as never),
    farmClient: asValue(farmClient as never),
    orderClient: asValue(orderClient as never),
    runInTransaction: asValue(((work: (tx: unknown) => Promise<unknown>) => work({})) as never),
    tokenVerifier: asValue(() =>
      opts.expired === true
        ? Promise.reject(new UnauthorizedError('expired'))
        : caller === null
          ? Promise.reject(new UnauthorizedError())
          : Promise.resolve(caller),
    ),
  });
  return { a: app, repo, redis, productClient, catalogClient, farmClient, orderClient, audit };
};

interface SectionJson {
  key: string;
  title: string | null;
  items?: { refId: string }[];
  data?: { items: { id: string; actions: { primary: string; call: { tel: string } | null } }[] };
  fetch?: unknown;
  banners?: unknown[];
}
const keysOf = (body: { data: { sections: SectionJson[] } }) =>
  body.data.sections.map((s) => s.key);
const layout = async (a: FastifyInstance, headers: Record<string, string> = {}) => {
  const res = await a.inject({
    method: 'GET',
    url: '/home/layout?page=HOME',
    headers: { ...APP, ...headers },
  });
  return {
    res,
    body: res.json<{
      data: { layoutNo: number; publishRev: number; sections: SectionJson[] };
      meta: { authState: string; region: string | null; degraded: string[] };
    }>(),
  };
};

describe('home layout (/home/layout)', () => {
  it('guest: ordered sections, inline first page, targeted / future / login-only widgets hidden, 304 on ETag', async () => {
    const { a, productClient } = await build();
    const { res, body } = await layout(a);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const keys = keysOf(body);
    expect(keys.slice(0, 2)).toEqual(['hero', 'categories']);
    expect(keys).toContain('clearance');
    expect(keys).not.toContain('ios-only'); // platform targeting
    expect(keys).not.toContain('live-order'); // needs login, fallback HIDE
    expect(keys).not.toContain('appointment'); // ⏳ Future feed
    const categories = body.data.sections.find((s) => s.key === 'categories')!;
    expect(categories.items!.map((i) => i.refId)).toEqual([C1]); // C2 is WG-only; a guest has no region
    const featured = body.data.sections.find((s) => s.key === 'featured')!;
    expect(featured.data!.items.map((i) => i.id)).toEqual([P1, P2]);
    expect(featured.data!.items[0]!.actions.primary).toBe('UPLOAD_RX');
    expect(featured.data!.items[0]!.actions.call).toEqual({
      type: 'PHONE_ORDER',
      tel: '+911111111111',
    });
    expect(body.data.sections.find((s) => s.key === 'clearance')!.fetch).toBeDefined();
    expect(body.meta.authState).toBe('none');
    // No depot for a guest: the stock filter is network-wide.
    expect(productClient.list).toHaveBeenCalledWith(
      expect.not.objectContaining({ nodeId: NODE }),
      350,
    );

    const again = await a.inject({
      method: 'GET',
      url: '/home/layout?page=HOME',
      headers: { ...APP, 'if-none-match': res.headers.etag! },
    });
    expect(again.statusCode).toBe(304);
  });

  it('expired token → 200 as a guest with authState "expired" (never 401)', async () => {
    const { a } = await build({ expired: true });
    const { res, body } = await layout(a, BEARER);
    expect(res.statusCode).toBe(200);
    expect(body.meta.authState).toBe('expired');
    expect(keysOf(body)).not.toContain('live-order');
  });

  it('farmer: region + depot from the farm (X-Region ignored), region phone, login widgets shown', async () => {
    const { a, productClient, farmClient } = await build({ caller: userOf(FARMER, 'CUSTOMER') });
    const { body } = await layout(a, { ...BEARER, 'x-region': 'KR' });
    expect(body.meta.region).toBe('WG');
    expect(keysOf(body)).toContain('live-order');
    const categories = body.data.sections.find((s) => s.key === 'categories')!;
    expect(categories.items!.map((i) => i.refId)).toEqual([C1, C2]);
    const featured = body.data.sections.find((s) => s.key === 'featured')!;
    expect(featured.data!.items[0]!.actions.call?.tel).toBe('+912222222222');
    expect(productClient.list).toHaveBeenCalledWith(expect.objectContaining({ nodeId: NODE }), 350);
    expect(farmClient.context).toHaveBeenCalledWith('t', undefined, 300);

    // A guest sending X-Region: WG still gets no WG-only item.
    const guest = await layout(a, { 'x-region': 'WG' });
    expect(guest.body.data.sections.find((s) => s.key === 'categories')!.items).toHaveLength(1);
  });

  it('X-Farm-Id picks which farm decides the region', async () => {
    const { a, farmClient } = await build({ caller: userOf(FARMER, 'CUSTOMER') });
    const { body } = await layout(a, { ...BEARER, 'x-farm-id': FARM_B });
    expect(farmClient.context).toHaveBeenCalledWith('t', FARM_B, 300);
    expect(body.meta.region).toBe('KR');
  });

  it('same device id → same A/B variant before and after login', async () => {
    const { a } = await build({ caller: userOf(FARMER, 'CUSTOMER') });
    for (const device of ['device-0001', 'device-0002', 'device-0003', 'device-0004']) {
      const guest = keysOf((await layout(a, { 'x-device-id': device })).body).includes('ab-test');
      const user = keysOf((await layout(a, { ...BEARER, 'x-device-id': device })).body).includes(
        'ab-test',
      );
      expect(user).toBe(guest);
    }
  });

  it('product-service down → layout still 200, rail degraded; catalog down → no banners, still 200', async () => {
    const down = await build({ productsDown: true });
    const { res, body } = await layout(down.a);
    expect(res.statusCode).toBe(200);
    expect(body.meta.degraded).toContain('featured');
    expect(body.data.sections.find((s) => s.key === 'featured')!.data).toBeUndefined();
    await down.a.close();

    const cat = await build({ catalogDown: true });
    const r2 = await layout(cat.a);
    expect(r2.res.statusCode).toBe(200);
    expect(keysOf(r2.body)).not.toContain('hero');
    expect(r2.body.meta.degraded).toContain('hero');
  });
});

describe('home sections + feeds', () => {
  it('manual rail pages by cursor; batch returns OK / NOT_FOUND', async () => {
    const { a } = await build();
    const p1 = await a.inject({
      method: 'GET',
      url: '/home/sections/clearance?limit=2',
      headers: APP,
    });
    expect(p1.statusCode).toBe(200);
    const page1 = p1.json<{ data: { items: { id: string }[]; nextCursor: string } }>().data;
    expect(page1.items.map((i) => i.id)).toEqual([P1, P2]);
    const p2 = await a.inject({
      method: 'GET',
      url: `/home/sections/clearance?limit=2&cursor=${page1.nextCursor}`,
      headers: APP,
    });
    expect(p2.json<{ data: { items: { id: string }[]; nextCursor: null } }>().data).toMatchObject({
      items: [{ id: P3 }],
      nextCursor: null,
    });
    expect(
      (await a.inject({ method: 'GET', url: '/home/sections/ios-only', headers: APP })).statusCode,
    ).toBe(404);

    const batch = await a.inject({
      method: 'GET',
      url: '/home/sections?keys=featured,clearance,hero',
      headers: APP,
    });
    expect(
      batch.json<{ data: { key: string; status: string }[] }>().data.map((d) => d.status),
    ).toEqual(['OK', 'OK', 'NOT_FOUND']);
  });

  it('feeds: allowlisted keys; ORDER_LIVE latest only; Future keys NOT_AVAILABLE; guests AUTH_REQUIRED', async () => {
    const farmer = await build({ caller: userOf(FARMER, 'CUSTOMER') });
    const res = await farmer.a.inject({
      method: 'GET',
      url: '/home/feeds?keys=ORDER_LIVE,APPOINTMENT_NEXT,FLOCK_CONTEXT,NEWS_LATEST',
      headers: { ...APP, ...BEARER },
    });
    const data = res.json<{
      data: { key: string; status: string; data: Record<string, unknown> | null }[];
    }>().data;
    expect(data.map((d) => [d.key, d.status])).toEqual([
      ['ORDER_LIVE', 'OK'],
      ['APPOINTMENT_NEXT', 'NOT_AVAILABLE'],
      ['FLOCK_CONTEXT', 'OK'],
      ['NEWS_LATEST', 'OK'],
    ]);
    expect(farmer.orderClient.latestActiveOrder).toHaveBeenCalledWith('t', 400);
    expect(data[2]!.data).toMatchObject({ birdCount: 18_500, region: 'WG', stage: null });
    await farmer.a.close();

    const guest = await build();
    const g = await guest.a.inject({
      method: 'GET',
      url: '/home/feeds?keys=ORDER_LIVE',
      headers: APP,
    });
    expect(g.json<{ data: { status: string }[] }>().data[0]!.status).toBe('AUTH_REQUIRED');
    const bad = await guest.a.inject({
      method: 'GET',
      url: '/home/feeds?keys=EVIL_URL',
      headers: APP,
    });
    expect(bad.statusCode).toBe(422);
  });

  it('rate limit: 31st feeds call in a minute → 429', async () => {
    const { a } = await build();
    let last = 0;
    for (let i = 0; i < 31; i += 1)
      last = (await a.inject({ method: 'GET', url: '/home/feeds?keys=ORDER_LIVE', headers: APP }))
        .statusCode;
    expect(last).toBe(429);
  });
});

describe('admin home layouts (/admin/home)', () => {
  const ALL = ['home_layout.view', 'home_layout.manage', 'home_layout.publish'];
  const staff = { caller: userOf(STAFF, 'INTERNAL'), permissions: ALL };
  const H = (version?: number) => ({
    ...BEARER,
    ...(version === undefined ? {} : { 'if-match': `"${String(version)}"` }),
  });
  const draftBody = (extra: Partial<SectionInput> = {}) => ({
    name: 'Diwali',
    sections: [
      sec('featured', { config: { query: { isFeatured: true } }, ...extra }),
      sec('cats', {
        widgetType: 'CATEGORY_GRID',
        dataSource: 'STATIC_ITEMS',
        items: [item('CATEGORY', C1)],
      }),
    ],
  });

  it('needs the permission', async () => {
    const { a } = await build({ caller: userOf(STAFF, 'INTERNAL'), permissions: [] });
    expect(
      (await a.inject({ method: 'GET', url: '/admin/home/layouts', headers: BEARER })).statusCode,
    ).toBe(403);
  });

  it('draft: If-Match required / stale → 409; en required; publish archives the old one and bumps publishRev; rollback re-checks refs', async () => {
    const { a, repo } = await build(staff);
    const created = await a.inject({
      method: 'POST',
      url: '/admin/home/layouts',
      headers: BEARER,
      payload: { page: 'HOME', name: 'Diwali' },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ data: { id: string; layoutNo: number } }>().data.id;
    const url = `/admin/home/layouts/${id}`;

    expect(
      (await a.inject({ method: 'PUT', url, headers: H(), payload: draftBody() })).statusCode,
    ).toBe(400);
    expect(
      (await a.inject({ method: 'PUT', url, headers: H(7), payload: draftBody() })).statusCode,
    ).toBe(409);
    const noEn = await a.inject({
      method: 'PUT',
      url,
      headers: H(0),
      payload: draftBody({ title: { hi: 'केवल हिंदी' } as never }),
    });
    expect(noEn.statusCode).toBe(422);
    const saved = await a.inject({ method: 'PUT', url, headers: H(0), payload: draftBody() });
    expect(saved.statusCode).toBe(200);
    expect(saved.headers.etag).toBe('"1"');

    const pub = await a.inject({
      method: 'POST',
      url: `${url}/publish`,
      headers: H(1),
      payload: { reason: 'Diwali campaign layout' },
    });
    expect(pub.statusCode).toBe(200);
    const [first, second] = repo.layouts;
    expect(first!.status).toBe('ARCHIVED');
    expect(second!.status).toBe('PUBLISHED');
    expect(second!.publishRev).toBe(2);
    // Cache dropped on publish: the app sees the new layout at once.
    expect((await layout(a)).body.data.layoutNo).toBe(2);

    // Rollback to #1, but one of its products is gone now → 422, nothing changes.
    first!.sections.find((s) => s.sectionKey === 'clearance')!.items[0]!.refId = GONE;
    const blocked = await a.inject({
      method: 'POST',
      url: `/admin/home/layouts/${first!.id}/rollback`,
      headers: H(first!.version),
      payload: { reason: 'Back to launch layout' },
    });
    expect(blocked.statusCode).toBe(422);
    expect(second!.status).toBe('PUBLISHED');

    first!.sections.find((s) => s.sectionKey === 'clearance')!.items[0]!.refId = P1;
    const back = await a.inject({
      method: 'POST',
      url: `/admin/home/layouts/${first!.id}/rollback`,
      headers: H(first!.version),
      payload: { reason: 'Back to launch layout' },
    });
    expect(back.statusCode).toBe(200);
    expect(first!.status).toBe('PUBLISHED');
    expect(first!.publishRev).toBe(3); // new revision: no old cached section pages come back
    expect(second!.status).toBe('ARCHIVED');
  });

  it('schedule: a new schedule replaces the old; it goes live on the first read after its time', async () => {
    const { a, repo } = await build(staff);
    const mk = async (name: string) => {
      const r = await a.inject({
        method: 'POST',
        url: '/admin/home/layouts',
        headers: BEARER,
        payload: { page: 'HOME', name },
      });
      const id = r.json<{ data: { id: string } }>().data.id;
      await a.inject({
        method: 'PUT',
        url: `/admin/home/layouts/${id}`,
        headers: H(0),
        payload: { ...draftBody(), name },
      });
      return id;
    };
    const s1 = await mk('One');
    const s2 = await mk('Two');
    const at = new Date(Date.now() + 3_600_000).toISOString();
    const sched = (id: string) =>
      a.inject({
        method: 'POST',
        url: `/admin/home/layouts/${id}/publish`,
        headers: H(1),
        payload: { reason: 'Festival layout schedule', scheduledPublishAt: at },
      });
    expect((await sched(s1)).statusCode).toBe(200);
    expect((await sched(s2)).statusCode).toBe(200);
    const byId = (id: string) => repo.layouts.find((l) => l.id === id)!;
    expect(byId(s1).status).toBe('DRAFT');
    expect(byId(s2).status).toBe('SCHEDULED');

    byId(s2).scheduledPublishAt = new Date(Date.now() - 1000); // its time has come
    const { body } = await layout(a);
    expect(body.data.layoutNo).toBe(byId(s2).layoutNo);
    expect(byId(s2).status).toBe('PUBLISHED');
    expect(repo.layouts[0]!.status).toBe('ARCHIVED');
  });

  it('publish with a broken reference → 422 HOME_LAYOUT_BROKEN_REFS', async () => {
    const { a } = await build(staff);
    const r = await a.inject({
      method: 'POST',
      url: '/admin/home/layouts',
      headers: BEARER,
      payload: { page: 'HOME', name: 'Bad' },
    });
    const id = r.json<{ data: { id: string } }>().data.id;
    await a.inject({
      method: 'PUT',
      url: `/admin/home/layouts/${id}`,
      headers: H(0),
      payload: {
        name: 'Bad',
        sections: [
          sec('picks', {
            widgetType: 'PRODUCT_HORIZONTAL_RAIL',
            dataSource: 'MANUAL_PRODUCTS',
            items: [item('PRODUCT', GONE)],
          }),
        ],
      },
    });
    const pub = await a.inject({
      method: 'POST',
      url: `/admin/home/layouts/${id}/publish`,
      headers: H(1),
      payload: { reason: 'Publishing the bad one' },
    });
    expect(pub.statusCode).toBe(422);
    expect(pub.json<{ error: { message: string } }>().error.message).toMatch(
      /HOME_LAYOUT_BROKEN_REFS/,
    );
  });
});

describe('wishlist ids cap', () => {
  it('returns at most 500 ids with meta.truncated', async () => {
    const { a } = await build({ caller: userOf(FARMER, 'CUSTOMER') });
    const ids = Array.from({ length: 501 }, (_, i) => `id-${String(i)}`);
    app!.diContainer.register({
      wishlistRepository: asValue({ productIds: () => Promise.resolve(ids) } as never),
    });
    const res = await a.inject({ method: 'GET', url: '/me/wishlist/ids', headers: BEARER });
    const body = res.json<{ data: { productIds: string[] }; meta: { truncated: boolean } }>();
    expect(body.data.productIds).toHaveLength(500);
    expect(body.meta.truncated).toBe(true);
  });
});

describe('home OpenAPI contract', () => {
  it('sections are a oneOf union discriminated by `widget` (typed models for the app)', async () => {
    const { a } = await build();
    const spec = (await a.inject({ method: 'GET', url: '/api-docs.json' })).json<{
      components: { schemas: Record<string, { properties?: Record<string, unknown> }> };
    }>();
    const schemas = spec.components.schemas;
    expect(schemas.HomeSectionBannerCarousel).toBeDefined();
    expect(schemas.HomeSectionProductGrid2x2).toBeDefined();
    const sections = schemas.HomeLayout?.properties?.sections as {
      items: {
        oneOf: unknown[];
        discriminator: { propertyName: string; mapping: Record<string, string> };
      };
    };
    expect(sections.items.oneOf).toHaveLength(14);
    expect(sections.items.discriminator.propertyName).toBe('widget');
    expect(sections.items.discriminator.mapping.BANNER_CAROUSEL).toBe(
      '#/components/schemas/HomeSectionBannerCarousel',
    );
  });
});
