import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProductClient } from '../../src/adapters/product-client.js';
import type { UserConfig } from '../../src/config/index.js';
import type { AddressRow } from '../../src/features/addresses/addresses.repository.js';
import {
  diff,
  formatAddress,
  toSnapshot,
  toView,
} from '../../src/features/addresses/addresses.service.js';
import { createSchema, updateSchema } from '../../src/features/addresses/addresses.validation.js';
import { hydrate } from '../../src/features/wishlist/wishlist.service.js';

const U = '01900000-0000-7000-8000-000000000001';
const A = '01900000-0000-7000-8000-000000000101';
const P1 = '01900000-0000-7000-8000-000000000201';
const P2 = '01900000-0000-7000-8000-000000000202';

const row = (extra: Partial<AddressRow> = {}): AddressRow =>
  ({
    id: A,
    userId: U,
    type: 'FARM',
    label: 'Main farm',
    contactName: 'Ravi Kumar',
    contactPhone: '+919876543210',
    line1: 'Plot 12',
    line2: null,
    landmark: 'Near temple',
    village: 'Kondapur',
    mandal: null,
    district: 'Rangareddy',
    stateCode: 'TG',
    pinCode: '500084',
    latitude: { toString: () => '17.461800' },
    longitude: { toString: () => '78.356800' },
    isDefault: true,
    version: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
    ...extra,
  }) as AddressRow;

describe('address helpers', () => {
  it('toView converts decimals to numbers and hides userId/deletedAt', () => {
    const view = toView(row());
    expect(view.latitude).toBe(17.4618);
    expect(view).not.toHaveProperty('userId');
    expect(view).not.toHaveProperty('deletedAt');
  });

  it('formatAddress skips empty parts', () => {
    expect(formatAddress(toView(row()))).toBe(
      'Plot 12, Near temple, Kondapur, Rangareddy, TG 500084',
    );
  });

  it('snapshot carries version, owner, deleted flag and the formatted line', () => {
    const snap = toSnapshot(row({ deletedAt: new Date(1) }));
    expect(snap).toMatchObject({ addressId: A, userId: U, version: 3, deleted: true });
    expect(snap.formatted).toContain('500084');
    expect(snap).not.toHaveProperty('isDefault');
  });

  it('diff keeps only real changes; "" clears an optional field', () => {
    const current = toView(row());
    expect(diff({ district: 'Rangareddy', landmark: '' }, current)).toEqual({ landmark: null });
    expect(diff({ pinCode: '500032' }, current)).toEqual({ pinCode: '500032' });
    expect(diff({}, current)).toEqual({});
  });
});

describe('address Joi rules', () => {
  const base = {
    contactName: 'Ravi',
    contactPhone: '98765 43210',
    line1: 'Plot 12',
    district: 'Rangareddy',
    stateCode: 'tg',
    pinCode: '500084',
  };
  const create = (body: object) => createSchema.body.validate(body);

  it('normalises a 10-digit mobile to +91 and upper-cases the state', () => {
    const { value, error } = create(base) as { value: Record<string, unknown>; error?: unknown };
    expect(error).toBeUndefined();
    expect(value).toMatchObject({
      contactPhone: '+919876543210',
      stateCode: 'TG',
      type: 'HOME',
      isDefault: false,
    });
  });

  it('rejects a bad PIN, a bad phone, and a lone latitude', () => {
    expect(create({ ...base, pinCode: '012345' }).error).toBeDefined();
    expect(create({ ...base, contactPhone: '12345' }).error).toBeDefined();
    expect(create({ ...base, latitude: 17.4 }).error).toBeDefined();
    expect(create({ ...base, latitude: 17.4, longitude: 78.3 }).error).toBeUndefined();
  });

  it('update needs at least one field and cannot set isDefault', () => {
    expect(updateSchema.body.validate({}).error).toBeDefined();
    expect(updateSchema.body.validate({ isDefault: true }).error).toBeDefined();
    expect(updateSchema.body.validate({ landmark: null }).error).toBeUndefined();
  });
});

describe('wishlist hydrate', () => {
  it('missing card → product null, available false', () => {
    const rows = [
      { id: 'w1', productId: P1, createdAt: new Date(0) },
      { id: 'w2', productId: P2, createdAt: new Date(0) },
    ];
    const cards = new Map([
      [P1, { id: P1, name: 'A', slug: 'a', imageUrl: null, available: true }],
    ]);
    const [a, b] = hydrate(rows, cards);
    expect(a).toMatchObject({ productId: P1, available: true });
    expect(b).toMatchObject({ productId: P2, available: false, product: null });
  });
});

describe('ProductClient cache split', () => {
  afterEach(() => vi.unstubAllGlobals());

  const config = {
    PRODUCT_SERVICE_URL: 'http://product',
    INTERNAL_SERVICE_TOKEN: 'x'.repeat(32),
  } as UserConfig;
  const logger = { warn: vi.fn(), error: vi.fn() } as never;

  it('asks product-service only for cache misses, caches found + missing', async () => {
    const cached = JSON.stringify({
      id: P1,
      name: 'A',
      slug: 'a',
      imageUrl: null,
      available: true,
    });
    const set = vi.fn();
    const redis = {
      mget: vi.fn(() => Promise.resolve([cached, null])),
      pipeline: () => ({ set, exec: () => Promise.resolve([]) }),
    };
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new ProductClient({ config, logger, redis: () => redis as never });
    const cards = await client.cards([P1, P2, P1]);
    expect(cards.get(P1)?.name).toBe('A');
    expect(cards.has(P2)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      `http://product/internal/products/cards?ids=${P2}`,
    );
    expect(set).toHaveBeenCalledWith(expect.stringContaining(P2), '0', 'EX', 120);
  });

  it('product-service down → 503', async () => {
    const redis = {
      mget: () => Promise.resolve([null]),
      pipeline: () => ({ set: vi.fn(), exec: () => Promise.resolve([]) }),
    };
    vi.stubGlobal('fetch', () => Promise.reject(new Error('ECONNREFUSED')));
    const client = new ProductClient({ config, logger, redis: () => redis as never });
    await expect(client.cards([P1])).rejects.toMatchObject({ statusCode: 503 });
  });
});
