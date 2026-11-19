import { ServiceUnavailableError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';

// pg connects lazily; Redis, repositories, transactions and product-service are faked in memory.
const TOKEN = 'internal-token-internal-token-1234567890';
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
  MAX_ADDRESSES_PER_USER: '3',
  MAX_WISHLIST_ITEMS: '2',
} as NodeJS.ProcessEnv;

const ME = '01900000-0000-7000-8000-000000000001';
const OTHER = '01900000-0000-7000-8000-000000000002';
const STAFF = '01900000-0000-7000-8000-000000000003';
const P1 = '01900000-0000-7000-8000-000000000201';
const P2 = '01900000-0000-7000-8000-000000000202';
const P3 = '01900000-0000-7000-8000-000000000203';
const HIDDEN = '01900000-0000-7000-8000-000000000204';
const MISSING = '01900000-0000-7000-8000-000000000299';

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
const auth = { authorization: 'Bearer t' };

const redisDown = {
  eval: () => Promise.reject(new Error('down')),
  get: () => Promise.resolve(null),
  mget: () => Promise.resolve([null, null]),
};

/** In-memory stand-in for AddressesRepository (same method contract). */
const addressRepo = () => {
  const rows: Record<string, unknown>[] = [];
  let seq = 0;
  const live = (userId: string) => rows.filter((r) => r.userId === userId && r.deletedAt === null);
  return {
    rows,
    lock: vi.fn(() => Promise.resolve()),
    listLive: (userId: string) => Promise.resolve(live(userId)),
    listAll: (userId: string, all: boolean) =>
      Promise.resolve(rows.filter((r) => r.userId === userId && (all || r.deletedAt === null))),
    findLive: (userId: string, id: string) =>
      Promise.resolve(live(userId).find((r) => r.id === id) ?? null),
    findAny: (userId: string, id: string) =>
      Promise.resolve(rows.find((r) => r.userId === userId && r.id === id) ?? null),
    countLive: (_tx: unknown, userId: string) => Promise.resolve(live(userId).length),
    clearDefault: (_tx: unknown, userId: string) => {
      for (const r of live(userId))
        if (r.isDefault === true) Object.assign(r, { isDefault: false });
      return Promise.resolve();
    },
    create: (_tx: unknown, data: Record<string, unknown>) => {
      seq += 1;
      const row = {
        ...data,
        version: 0,
        createdAt: new Date(seq),
        updatedAt: new Date(seq),
        deletedAt: null,
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    update: (_tx: unknown, id: string, data: Record<string, unknown>) => {
      seq += 1;
      const row = rows.find((r) => r.id === id)!;
      Object.assign(row, data, { version: (row.version as number) + 1, updatedAt: new Date(seq) });
      return Promise.resolve(row);
    },
    softDelete: (_tx: unknown, id: string) => {
      Object.assign(
        rows.find((r) => r.id === id)!,
        { deletedAt: new Date(), isDefault: false },
      );
      return Promise.resolve();
    },
    newestLive: (_tx: unknown, userId: string) =>
      Promise.resolve(
        [...live(userId)].sort(
          (a, b) => (b.updatedAt as Date).getTime() - (a.updatedAt as Date).getTime(),
        )[0] ?? null,
      ),
  };
};

/** In-memory stand-in for WishlistRepository. */
const wishRepo = () => {
  const rows: { id: string; userId: string; productId: string; createdAt: Date }[] = [];
  let seq = 0;
  return {
    rows,
    lock: () => Promise.resolve(),
    find: (_tx: unknown, userId: string, productId: string) =>
      Promise.resolve(rows.find((r) => r.userId === userId && r.productId === productId) ?? null),
    count: (_tx: unknown, userId: string) =>
      Promise.resolve(rows.filter((r) => r.userId === userId).length),
    create: (_tx: unknown, data: { id: string; userId: string; productId: string }) => {
      seq += 1;
      const row = {
        ...data,
        id: `01900000-0000-7000-8000-${String(seq).padStart(12, '0')}`,
        createdAt: new Date(seq),
      };
      rows.push(row);
      return Promise.resolve(row);
    },
    page: (userId: string, q: { limit: number; cursor?: string }) => {
      let mine = rows.filter((r) => r.userId === userId).sort((a, b) => (a.id < b.id ? 1 : -1));
      if (q.cursor !== undefined) mine = mine.filter((r) => r.id < q.cursor!);
      const items = mine.slice(0, q.limit);
      return Promise.resolve({
        items,
        nextCursor: mine.length > q.limit ? (items.at(-1)?.id ?? null) : null,
        limit: q.limit,
      });
    },
    productIds: (userId: string) =>
      Promise.resolve(rows.filter((r) => r.userId === userId).map((r) => r.productId)),
    remove: (userId: string, productId: string) => {
      const i = rows.findIndex((r) => r.userId === userId && r.productId === productId);
      if (i >= 0) rows.splice(i, 1);
      return Promise.resolve();
    },
    clear: (userId: string) => {
      const before = rows.length;
      for (let i = rows.length - 1; i >= 0; i -= 1)
        if (rows[i]?.userId === userId) rows.splice(i, 1);
      return Promise.resolve(before - rows.length);
    },
  };
};

const card = (id: string, available = true) => ({
  id,
  name: id,
  slug: id,
  imageUrl: null,
  available,
});

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

const build = async (
  caller: AuthUser | null,
  opts: { permissions?: string[]; env?: NodeJS.ProcessEnv; productsDown?: boolean } = {},
) => {
  const addresses = addressRepo();
  const wishlist = wishRepo();
  const audit = {
    record: vi.fn(() => Promise.resolve()),
    history: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
  };
  const productClient = {
    cards: vi.fn((ids: string[]) =>
      opts.productsDown === true
        ? Promise.reject(new ServiceUnavailableError('Product service unavailable'))
        : Promise.resolve(
            new Map(
              ids
                .filter((id) => id !== MISSING)
                .map((id) => [id, card(id, id !== HIDDEN)] as const),
            ),
          ),
    ),
  };
  app = await buildApp(opts.env ?? ENV);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    accessClient: asValue({
      hasPermission: (_u: string, key: string) =>
        Promise.resolve((opts.permissions ?? []).includes(key)),
    } as never),
    addressesRepository: asValue(addresses as never),
    wishlistRepository: asValue(wishlist as never),
    auditService: asValue(audit as never),
    productClient: asValue(productClient as never),
    runInTransaction: asValue(((work: (tx: unknown) => Promise<unknown>) => work({})) as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return { a: app, addresses, wishlist, audit, productClient };
};

const newAddress = (extra: object = {}) => ({
  contactName: 'Ravi Kumar',
  contactPhone: '9876543210',
  line1: 'Plot 12',
  district: 'Rangareddy',
  stateCode: 'TG',
  pinCode: '500084',
  ...extra,
});

describe('addresses (/me/addresses)', () => {
  it('401 without token; 403 for a non-customer', async () => {
    const anon = await build(null);
    expect((await anon.a.inject({ method: 'GET', url: '/me/addresses' })).statusCode).toBe(401);
    await anon.a.close();
    const staff = await build(userOf(STAFF, 'INTERNAL'));
    expect(
      (await staff.a.inject({ method: 'GET', url: '/me/addresses', headers: auth })).statusCode,
    ).toBe(403);
  });

  it('first address is default; isDefault moves it; delete default promotes; audited', async () => {
    const { a, audit } = await build(userOf(ME, 'CUSTOMER'));
    const post = (body: object) =>
      a.inject({ method: 'POST', url: '/me/addresses', headers: auth, payload: body });
    const first = await post(newAddress());
    expect(first.statusCode).toBe(201);
    expect(first.headers.etag).toBe('"0"');
    const firstId = first.json<{ data: { id: string; isDefault: boolean; contactPhone: string } }>()
      .data;
    expect(firstId).toMatchObject({ isDefault: true, contactPhone: '+919876543210' });

    const second = (await post(newAddress({ line1: 'Shed 4', isDefault: true }))).json<{
      data: { id: string; isDefault: boolean };
    }>().data;
    expect(second.isDefault).toBe(true);
    const list = (await a.inject({ method: 'GET', url: '/me/addresses', headers: auth })).json<{
      data: { id: string; isDefault: boolean }[];
    }>().data;
    expect(list.filter((x) => x.isDefault).map((x) => x.id)).toEqual([second.id]);

    const setDefault = await a.inject({
      method: 'POST',
      url: `/me/addresses/${firstId.id}/default`,
      headers: auth,
    });
    expect(setDefault.json<{ data: { isDefault: boolean } }>().data.isDefault).toBe(true);

    expect(
      (await a.inject({ method: 'DELETE', url: `/me/addresses/${firstId.id}`, headers: auth }))
        .statusCode,
    ).toBe(204);
    const after = (await a.inject({ method: 'GET', url: '/me/addresses', headers: auth })).json<{
      data: { id: string; isDefault: boolean }[];
    }>().data;
    expect(after).toEqual([expect.objectContaining({ id: second.id, isDefault: true })]);
    expect(audit.record).toHaveBeenCalledTimes(4);
  });

  it('limit → 409 ADDRESS_LIMIT; bad PIN → 422', async () => {
    const { a } = await build(userOf(ME, 'CUSTOMER'));
    for (let i = 0; i < 3; i += 1)
      await a.inject({
        method: 'POST',
        url: '/me/addresses',
        headers: auth,
        payload: newAddress(),
      });
    const full = await a.inject({
      method: 'POST',
      url: '/me/addresses',
      headers: auth,
      payload: newAddress(),
    });
    expect(full.statusCode).toBe(409);
    expect(full.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'ADDRESS_LIMIT',
    );
    const bad = await a.inject({
      method: 'POST',
      url: '/me/addresses',
      headers: auth,
      payload: newAddress({ pinCode: '12' }),
    });
    expect(bad.statusCode).toBe(422);
  });

  it('update with If-Match; stale → 409; another user’s address → 404', async () => {
    const { a, addresses } = await build(userOf(ME, 'CUSTOMER'));
    const id = (
      await a.inject({ method: 'POST', url: '/me/addresses', headers: auth, payload: newAddress() })
    ).json<{ data: { id: string } }>().data.id;
    const ok = await a.inject({
      method: 'PATCH',
      url: `/me/addresses/${id}`,
      headers: { ...auth, 'if-match': '"0"' },
      payload: { landmark: 'Milk centre' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers.etag).toBe('"1"');
    const stale = await a.inject({
      method: 'PATCH',
      url: `/me/addresses/${id}`,
      headers: { ...auth, 'if-match': '"0"' },
      payload: { landmark: 'x' },
    });
    expect(stale.statusCode).toBe(409);
    addresses.rows.push({
      ...addresses.rows[0],
      id: '01900000-0000-7000-8000-000000000777',
      userId: OTHER,
    });
    expect(
      (
        await a.inject({
          method: 'GET',
          url: '/me/addresses/01900000-0000-7000-8000-000000000777',
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('internal snapshot: token required, includes deleted', async () => {
    const env = { ...ENV, INTERNAL_SERVICE_TOKEN: TOKEN };
    const { a } = await build(userOf(ME, 'CUSTOMER'), { env });
    const id = (
      await a.inject({ method: 'POST', url: '/me/addresses', headers: auth, payload: newAddress() })
    ).json<{ data: { id: string } }>().data.id;
    await a.inject({ method: 'DELETE', url: `/me/addresses/${id}`, headers: auth });
    const url = `/internal/users/${ME}/addresses/${id}`;
    expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
    const snap = await a.inject({ method: 'GET', url, headers: { 'x-internal-token': TOKEN } });
    expect(snap.json<{ data: { deleted: boolean; formatted: string } }>().data).toMatchObject({
      deleted: true,
    });
  });
});

describe('wishlist (/me/wishlist)', () => {
  it('add 201 then 200 (idempotent); unknown 404; hidden 422; full 409', async () => {
    const { a } = await build(userOf(ME, 'CUSTOMER'));
    const add = (productId: string) =>
      a.inject({ method: 'POST', url: '/me/wishlist', headers: auth, payload: { productId } });
    expect((await add(P1)).statusCode).toBe(201);
    expect((await add(P1)).statusCode).toBe(200);
    expect((await add(MISSING)).statusCode).toBe(404);
    expect((await add(HIDDEN)).statusCode).toBe(422);
    expect((await add(P2)).statusCode).toBe(201);
    const full = await add(P3);
    expect(full.statusCode).toBe(409);
    expect(full.json<{ error: { details: { reason: string } } }>().error.details.reason).toBe(
      'WISHLIST_FULL',
    );
  });

  it('list is newest first with cursor; ids; remove; clear', async () => {
    const { a } = await build(userOf(ME, 'CUSTOMER'));
    for (const p of [P1, P2])
      await a.inject({
        method: 'POST',
        url: '/me/wishlist',
        headers: auth,
        payload: { productId: p },
      });
    const page1 = (
      await a.inject({ method: 'GET', url: '/me/wishlist?limit=1', headers: auth })
    ).json<{ data: { productId: string; product: unknown }[]; meta: { nextCursor: string } }>();
    expect(page1.data.map((i) => i.productId)).toEqual([P2]);
    const page2 = (
      await a.inject({
        method: 'GET',
        url: `/me/wishlist?limit=1&cursor=${page1.meta.nextCursor}`,
        headers: auth,
      })
    ).json<{ data: { productId: string }[] }>();
    expect(page2.data.map((i) => i.productId)).toEqual([P1]);
    const ids = (await a.inject({ method: 'GET', url: '/me/wishlist/ids', headers: auth })).json<{
      data: { productIds: string[] };
    }>();
    expect(ids.data.productIds.sort()).toEqual([P1, P2].sort());
    expect(
      (await a.inject({ method: 'DELETE', url: `/me/wishlist/${P1}`, headers: auth })).statusCode,
    ).toBe(204);
    expect(
      (await a.inject({ method: 'DELETE', url: `/me/wishlist/${P1}`, headers: auth })).statusCode,
    ).toBe(204);
    expect(
      (await a.inject({ method: 'DELETE', url: '/me/wishlist', headers: auth })).statusCode,
    ).toBe(204);
    expect(
      (await a.inject({ method: 'GET', url: '/me/wishlist/ids', headers: auth })).json<{
        data: { productIds: string[] };
      }>().data.productIds,
    ).toEqual([]);
  });

  it('product-service down: add → 503, list still loads with product null', async () => {
    const { a, wishlist } = await build(userOf(ME, 'CUSTOMER'), { productsDown: true });
    expect(
      (
        await a.inject({
          method: 'POST',
          url: '/me/wishlist',
          headers: auth,
          payload: { productId: P1 },
        })
      ).statusCode,
    ).toBe(503);
    wishlist.rows.push({
      id: '01900000-0000-7000-8000-000000000901',
      userId: ME,
      productId: P1,
      createdAt: new Date(),
    });
    const list = await a.inject({ method: 'GET', url: '/me/wishlist', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json<{ data: { product: unknown; available: boolean }[] }>().data[0]).toMatchObject(
      { product: null, available: false },
    );
  });
});

describe('admin (/admin/customers)', () => {
  it('needs customers.view; lists a customer’s addresses and wishlist', async () => {
    const denied = await build(userOf(STAFF, 'INTERNAL'));
    expect(
      (
        await denied.a.inject({
          method: 'GET',
          url: `/admin/customers/${ME}/addresses`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(403);
    await denied.a.close();
    const { a } = await build(userOf(STAFF, 'INTERNAL'), { permissions: ['customers.view'] });
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/admin/customers/${ME}/addresses?includeDeleted=true`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await a.inject({ method: 'GET', url: `/admin/customers/${ME}/wishlist`, headers: auth }))
        .statusCode,
    ).toBe(200);
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/admin/customers/${ME}/addresses/${P1}/history`,
          headers: auth,
        })
      ).statusCode,
    ).toBe(404);
  });

  it('publishes an OpenAPI spec without internal routes', async () => {
    const { a } = await build(null);
    const spec = (await a.inject({ method: 'GET', url: '/api-docs.json' })).json<{
      paths: Record<string, unknown>;
    }>();
    const paths = Object.keys(spec.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/me/addresses',
        '/me/wishlist',
        '/admin/customers/{userId}/wishlist',
      ]),
    );
    expect(paths.some((p) => p.startsWith('/internal'))).toBe(false);
  });
});
