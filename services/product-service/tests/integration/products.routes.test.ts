import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';

// pg connects lazily; Redis and the feature services are replaced, so no infrastructure is needed.
const TOKEN = 'internal-token-internal-token-1234567890';
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
const ID = '01900000-0000-7000-8000-0000000000aa';
const CAT = '01900000-0000-7000-8000-0000000000c1';

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

const build = async (
  caller: AuthUser | null,
  permissions: string[] = [],
  env: NodeJS.ProcessEnv = ENV,
) => {
  const storefront = {
    list: vi.fn(() =>
      Promise.resolve({ items: [{ id: ID, name: 'Enrocin' }], nextCursor: null, limit: 20 }),
    ),
    detail: vi.fn(() => Promise.resolve({ id: ID, name: 'Enrocin' })),
    alternatives: vi.fn(() => Promise.resolve([])),
    filters: vi.fn(() => Promise.resolve({ attributes: [], brands: [] })),
    internalCards: vi.fn(() => Promise.resolve([{ id: ID, name: 'Enrocin', available: true }])),
  };
  const products = {
    create: vi.fn(() => Promise.resolve({ id: ID, version: 0 })),
    transition: vi.fn(() => Promise.resolve({ id: ID, version: 4, status: 'PUBLISHED' })),
    blockReference: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
  };
  const lookups = {
    publicList: vi.fn(() => Promise.resolve([{ code: 'BROILER', label: 'Broiler' }])),
  };
  app = await buildApp(env);
  app.diContainer.register({
    redis: asValue(redisDown as never),
    accessClient: asValue({
      hasPermission: (_user: string, key: string) => Promise.resolve(permissions.includes(key)),
    } as never),
    storefrontService: asValue(storefront as never),
    productsService: asValue(products as never),
    lookupsService: asValue(lookups as never),
    ...(caller === null ? {} : { tokenVerifier: asValue(() => Promise.resolve(caller)) }),
  });
  return { a: app, storefront, products };
};

const validProduct = {
  name: 'Enrocin 10% Oral Solution',
  categoryId: CAT,
  brandId: ID,
  hsnCode: '30042019',
  gstRate: 12,
  variants: [{ sku: 'enro10-100ml', name: '100 ml', packSize: 100, packUnitId: ID, mrp: 185 }],
  reason: 'New antibiotic listing',
};

describe('storefront product routes (public)', () => {
  it('lists with envelope, ETag and 304', async () => {
    const { a } = await build(null);
    const res = await a.inject({ method: 'GET', url: '/catalog/products?q=enro&sort=price_asc' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      success: true,
      data: [{ id: ID }],
      meta: { nextCursor: null },
    });
    const etag = String(res.headers.etag);
    const again = await a.inject({
      method: 'GET',
      url: '/catalog/products?q=enro&sort=price_asc',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
  });

  it('passes repeatable filters as arrays and dynamic attr.* filters through', async () => {
    const { a, storefront } = await build(null);
    await a.inject({
      method: 'GET',
      url: `/catalog/products?categoryId=${CAT}&species=broiler&attr.vaccineStrain=Lasota`,
    });
    expect(storefront.list).toHaveBeenCalledWith(
      expect.objectContaining({
        categoryId: CAT,
        species: ['BROILER'],
        'attr.vaccineStrain': 'Lasota',
        limit: 20,
      }),
    );
  });

  it('Shop by Problem: diseaseSlug + flockStage (repeatable) combine; id+slug together → 422', async () => {
    const { a, storefront } = await build(null);
    await a.inject({
      method: 'GET',
      url: '/catalog/products?diseaseSlug=Coccidiosis&flockStage=grower&flockStage=layer&species=broiler',
    });
    expect(storefront.list).toHaveBeenCalledWith(
      expect.objectContaining({
        diseaseSlug: ['coccidiosis'],
        flockStage: ['GROWER', 'LAYER'],
        species: ['BROILER'],
      }),
    );
    await a.inject({
      method: 'GET',
      url: '/catalog/products?diseaseSlug=newcastle&diseaseSlug=ibd&sort=shelf_life',
    });
    expect(storefront.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ diseaseSlug: ['newcastle', 'ibd'], sort: 'shelf_life' }),
    );
    await a.inject({ method: 'GET', url: '/catalog/products?flockStage=brooder' });
    expect(storefront.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ flockStage: ['BROODER'] }),
    );
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/catalog/products?diseaseId=${ID}&diseaseSlug=crd`,
        })
      ).statusCode,
    ).toBe(422);
  });

  it('422 on conflicting category params or bad sort', async () => {
    const { a } = await build(null);
    expect(
      (
        await a.inject({
          method: 'GET',
          url: `/catalog/products?categoryId=${CAT}&categorySlug=vaccines`,
        })
      ).statusCode,
    ).toBe(422);
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/products?sort=cheapest' })).statusCode,
    ).toBe(422);
  });

  it('/filters takes the list selection (repeatable params as arrays, node stock)', async () => {
    const { a, storefront } = await build(null);
    const NODE = '0193a1b2-7c4d-7e5f-8a9b-0c1d2e3f4a5c';
    const res = await a.inject({
      method: 'GET',
      url: `/catalog/products/filters?species=layer&brandId=${ID}&diseaseSlug=newcastle&nodeId=${NODE}&inStock=true`,
    });
    expect(res.statusCode).toBe(200);
    expect(storefront.filters).toHaveBeenCalledWith(
      expect.objectContaining({
        species: ['LAYER'],
        brandId: [ID],
        diseaseSlug: ['newcastle'],
        nodeId: NODE,
        inStock: true,
      }),
    );
  });

  it('serves detail, filters and lookups', async () => {
    const { a } = await build(null);
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/products/enrocin-10' })).statusCode,
    ).toBe(200);
    expect((await a.inject({ method: 'GET', url: '/catalog/products/filters' })).statusCode).toBe(
      200,
    );
    expect(
      (await a.inject({ method: 'GET', url: '/catalog/lookups?group=SPECIES' })).statusCode,
    ).toBe(200);
  });
});

describe('admin product routes', () => {
  it('401 without a token, 403 without catalogue.manage', async () => {
    const anon = await build(null);
    expect(
      (
        await anon.a.inject({
          method: 'POST',
          url: '/admin/catalog/products',
          payload: validProduct,
        })
      ).statusCode,
    ).toBe(401);
    await anon.a.close();
    const denied = await build(staff, []);
    expect(
      (
        await denied.a.inject({
          method: 'POST',
          url: '/admin/catalog/products',
          headers: auth,
          payload: validProduct,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('422 with issues for an invalid body (no variants, bad HSN, bad GTIN)', async () => {
    const { a } = await build(staff, ['catalogue.manage']);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/products',
      headers: auth,
      payload: { ...validProduct, hsnCode: '30A', variants: [] },
    });
    expect(res.statusCode).toBe(422);
    const paths = res
      .json<{ error: { details: { issues: { path: string }[] } } }>()
      .error.details.issues.map((i) => i.path);
    expect(paths.join(',')).toMatch(/hsnCode/);
    const gtin = await a.inject({
      method: 'POST',
      url: '/admin/catalog/products',
      headers: auth,
      payload: { ...validProduct, variants: [{ ...validProduct.variants[0], barcode: '12345' }] },
    });
    expect(gtin.statusCode).toBe(422);
  });

  it('create → 201 with ETag; SKU is upper-cased before the service', async () => {
    const { a, products } = await build(staff, ['catalogue.manage']);
    const res = await a.inject({
      method: 'POST',
      url: '/admin/catalog/products',
      headers: auth,
      payload: validProduct,
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBe('"0"');
    expect(products.create).toHaveBeenCalledWith(
      expect.objectContaining({ variants: [expect.objectContaining({ sku: 'ENRO10-100ML' })] }),
      expect.objectContaining({ userId: staff.id }),
    );
  });

  it('approve needs catalogue.publish (manage alone is not enough)', async () => {
    const manager = await build(staff, ['catalogue.manage']);
    const url = `/admin/catalog/products/${ID}/approve`;
    expect(
      (
        await manager.a.inject({
          method: 'POST',
          url,
          headers: auth,
          payload: { reason: 'dossier verified' },
        })
      ).statusCode,
    ).toBe(403);
    await manager.a.close();
    const publisher = await build(staff, ['catalogue.publish']);
    const ok = await publisher.a.inject({
      method: 'POST',
      url,
      headers: auth,
      payload: { reason: 'dossier verified' },
    });
    expect(ok.statusCode).toBe(200);
    expect(publisher.products.transition).toHaveBeenCalledWith(
      ID,
      'approve',
      'dossier verified',
      undefined,
      expect.anything(),
    );
  });
});

describe('internal + docs', () => {
  it('internal routes need the service token (absent config → not mounted)', async () => {
    const off = await build(null);
    expect(
      (
        await off.a.inject({
          method: 'POST',
          url: '/internal/products/reference-blocks',
          payload: { refType: 'CATEGORY', refId: CAT },
        })
      ).statusCode,
    ).toBe(404);
    await off.a.close();
    const on = await build(null, [], { ...ENV, INTERNAL_SERVICE_TOKEN: TOKEN });
    const url = '/internal/products/reference-blocks';
    expect(
      (await on.a.inject({ method: 'POST', url, payload: { refType: 'CATEGORY', refId: CAT } }))
        .statusCode,
    ).toBe(401);
    const res = await on.a.inject({
      method: 'POST',
      url,
      headers: { 'x-internal-token': TOKEN },
      payload: { refType: 'CATEGORY', refId: CAT },
    });
    expect(res.statusCode).toBe(201);
    expect(on.products.blockReference).toHaveBeenCalledWith('CATEGORY', CAT);
  });

  it('internal product cards: token required, ids array or single, max 100', async () => {
    const { a, storefront } = await build(null, [], { ...ENV, INTERNAL_SERVICE_TOKEN: TOKEN });
    const headers = { 'x-internal-token': TOKEN };
    expect(
      (await a.inject({ method: 'GET', url: `/internal/products/cards?ids=${ID}` })).statusCode,
    ).toBe(401);
    const one = await a.inject({
      method: 'GET',
      url: `/internal/products/cards?ids=${ID}`,
      headers,
    });
    expect(one.statusCode).toBe(200);
    expect(one.json<{ data: { available: boolean }[] }>().data[0]?.available).toBe(true);
    expect(storefront.internalCards).toHaveBeenCalledWith([ID]);
    await a.inject({
      method: 'GET',
      url: `/internal/products/cards?ids=${ID}&ids=${CAT}`,
      headers,
    });
    expect(storefront.internalCards).toHaveBeenLastCalledWith([ID, CAT]);
    const tooMany = Array.from({ length: 101 }, () => `ids=${ID}`).join('&');
    expect(
      (await a.inject({ method: 'GET', url: `/internal/products/cards?${tooMany}`, headers }))
        .statusCode,
    ).toBe(422);
  });

  it('publishes an OpenAPI spec with storefront + admin product routes and no internal ones', async () => {
    const { a } = await build(null);
    const spec = (await a.inject({ method: 'GET', url: '/api-docs.json' })).json<{
      paths: Record<string, unknown>;
    }>();
    const paths = Object.keys(spec.paths);
    expect(paths).toEqual(
      expect.arrayContaining([
        '/catalog/products',
        '/catalog/products/{slugOrId}',
        '/admin/catalog/products/{id}/approve',
        '/admin/catalog/lookups',
        '/admin/catalog/product-attributes',
      ]),
    );
    expect(paths.some((p) => p.startsWith('/internal'))).toBe(false);
  });
});
