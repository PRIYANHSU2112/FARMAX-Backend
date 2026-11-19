import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * Cart against a REAL Postgres with the order migrations applied (local dev DB, never Neon):
 *   ORDER_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/order-service test
 * Skipped when the variable is not set. Redis (rate limits) and token verification are stubbed;
 * the bearer token IS the user id, so parallel requests can come from different users.
 */
const DB_URL = process.env.ORDER_IT_DATABASE_URL;

const users = new Map<string, AuthUser>();
const customer = (): string => {
  const id = randomUUID();
  users.set(id, {
    id,
    sessionId: 's',
    jti: 'j',
    userType: 'CUSTOMER',
    roles: [],
    scope: 'full',
    expiresAt: 0,
  } as unknown as AuthUser);
  return id;
};

const v = {
  vaccine: randomUUID(), // ₹7,896, max 500, cold chain
  capped: randomUUID(), // max 10
  minFive: randomUUID(), // min 5
  stocked: randomUUID(), // stock 3
  inactive: randomUUID(),
  ambient: randomUUID(),
  extra: randomUUID(),
};
const category = randomUUID();
const farmId = randomUUID();
const farmOwner = customer();
const createdUsers: string[] = [farmOwner];
const guestTokens: string[] = [];

let app: FastifyInstance;

const envelope = (type: string, data: object): EventEnvelope => ({
  id: randomUUID(),
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  source: 'test',
  correlationId: 'it',
  data,
});

const deliver = async (type: string, data: object) => {
  const handler = app.diContainer.resolve('projectionEventHandlers')[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  await app.diContainer.resolve('runInTransaction')((tx) => handler(envelope(type, data), tx));
};

const facts = (
  variantId: string,
  o: { min?: number; max?: number | null; active?: boolean; temp?: string; version?: number } = {},
) => ({
  variantId,
  productId: variantId,
  sku: `IT-${variantId.slice(0, 8)}`,
  barcode: null,
  productName: 'IT item',
  variantName: variantId.slice(0, 4),
  manufacturerName: null,
  packSize: '1',
  packUnit: 'PCS',
  isPrescriptionRequired: false,
  temperatureClass: o.temp ?? 'AMB',
  shelfLifeMonths: null,
  isActive: o.active ?? true,
  categoryId: category,
  categoryPath: [category],
  brandId: randomUUID(),
  hsnCode: '3002',
  gstRate: '5.00',
  minOrderQty: o.min ?? 1,
  maxOrderQty: o.max === undefined ? 500 : o.max,
  version: o.version ?? 1,
});
const price = (variantId: string, sellingPrice: string, sequence: number) =>
  deliver('pricing.price_changed.v1', {
    variantId,
    sellingPrice,
    currency: 'INR',
    effectiveFrom: new Date().toISOString(),
    sequence,
  });

interface Req {
  user?: string;
  token?: string;
  payload?: object;
}
const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, r: Req = {}) =>
  app.inject({
    method,
    url,
    headers: {
      ...(r.user === undefined ? {} : { authorization: `Bearer ${r.user}` }),
      ...(r.token === undefined ? {} : { 'x-cart-token': r.token }),
    },
    ...(r.payload === undefined ? {} : { payload: r.payload }),
  });
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;
const reason = (res: LightMyRequestResponse) =>
  res.json<{ error: { details?: { reason?: string } } }>().error.details?.reason;
const add = (r: Req, variantId: string, qty: number) =>
  call('POST', '/cart/items', { ...r, payload: { variantId, qty } });

interface CartView {
  cartId: string | null;
  cartVersion: number;
  itemCount: number;
  lines: { variantId: string; qty: number; unitPrice: string | null }[];
  notices: { code: string; variantId: string }[];
  summary: { itemSubtotal: string; checkoutBlocked: boolean };
  consignments: { separateDeliveries: boolean };
  pricing: { bill: { lines: { variantId: string; cgst: string }[] } } | null;
}
const qtyOf = (cart: CartView, variantId: string) =>
  cart.lines.find((l) => l.variantId === variantId)?.qty;

describe.skipIf(DB_URL === undefined)('cart against Postgres', () => {
  beforeAll(async () => {
    app = await buildApp({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      DATABASE_URL: DB_URL,
      CART_MAX_LINES: '3',
    });
    app.diContainer.register({
      redis: asValue({
        eval: () => Promise.reject(new Error('down')),
        mget: () => Promise.resolve([null, null]),
        get: () => Promise.resolve(null),
      } as never),
      accessClient: asValue({ hasPermission: () => Promise.resolve(false) } as never),
      tokenVerifier: asValue((token: string) => {
        const u = users.get(token);
        return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u);
      }),
    });
    await app.ready();

    await deliver('product.variant_created.v1', facts(v.vaccine, { temp: 'CC_REF' }));
    await deliver('product.variant_created.v1', facts(v.capped, { max: 10 }));
    await deliver('product.variant_created.v1', facts(v.minFive, { min: 5 }));
    await deliver('product.variant_created.v1', facts(v.stocked));
    await deliver('product.variant_created.v1', facts(v.inactive, { active: false }));
    await deliver('product.variant_created.v1', facts(v.ambient));
    await deliver('product.variant_created.v1', facts(v.extra));
    for (const id of Object.values(v)) await price(id, '100.00', 1);
    await price(v.vaccine, '7896.00', 2);
    await deliver('inventory.availability_changed.v1', {
      variantId: v.stocked,
      availableQty: 3,
      inStock: true,
      lowStock: true,
      sequence: 1,
    });
    await deliver('farm.facts_changed.v1', {
      farmId,
      farmCode: 'FX-WG-L-09999',
      ownerUserId: farmOwner,
      name: 'IT Farm',
      category: 'POULTRY_FARM',
      productionTypes: ['LAYER'],
      gstin: null,
      stateCode: '37',
      territoryCode: 'WG',
      pinCode: '534211',
      status: 'ACTIVE',
      version: 1,
    });
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.cart.deleteMany({
      where: { OR: [{ userId: { in: createdUsers } }, { guestToken: { in: guestTokens } }] },
    });
    await db.orderVariantProjection.deleteMany({ where: { variantId: { in: Object.values(v) } } });
    await db.orderFarmProjection.deleteMany({ where: { farmId } });
    await app.close();
  });

  const newUser = () => {
    const id = customer();
    createdUsers.push(id);
    return id;
  };

  it('guest: first add issues a token (body + header); the token reads the cart; no token = empty cart', async () => {
    const res = await add({}, v.vaccine, 2);
    expect(res.statusCode).toBe(200);
    const w = data<{ guestToken: string; itemCount: number; line: { qty: number } }>(res);
    guestTokens.push(w.guestToken);
    expect(res.headers['x-cart-token']).toBe(w.guestToken);
    expect(w).toMatchObject({ itemCount: 1, line: { qty: 2 } });

    const cart = data<CartView>(await call('GET', '/cart', { token: w.guestToken }));
    expect(qtyOf(cart, v.vaccine)).toBe(2);
    expect(cart.summary.itemSubtotal).toBe('15792.00');
    expect(cart.pricing).toBeNull();
    expect(data<CartView>(await call('GET', '/cart')).cartId).toBeNull();
    expect((await call('GET', '/cart', { token: 'not-a-uuid' })).statusCode).toBe(422);
  });

  it('50 parallel "+1" taps on a brand-new customer cart → qty 50, one cart, version 50 (no lost update)', async () => {
    const u = newUser();
    const results = await Promise.all(
      Array.from({ length: 50 }, () => add({ user: u }, v.vaccine, 1)),
    );
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    const cart = data<CartView>(await call('GET', '/cart', { user: u }));
    expect(qtyOf(cart, v.vaccine)).toBe(50);
    expect(cart.cartVersion).toBe(50);
    expect(await app.diContainer.resolve('db').cart.count({ where: { userId: u } })).toBe(1);
  });

  it('parallel adds can never pass the max order qty (exactly 10 of 20 succeed)', async () => {
    const u = newUser();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => add({ user: u }, v.capped, 1)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(10);
    expect(results.filter((r) => r.statusCode === 422).map(reason)).toEqual(
      Array(10).fill('QTY_LIMIT'),
    );
    expect(qtyOf(data<CartView>(await call('GET', '/cart', { user: u })), v.capped)).toBe(10);
  });

  it('min qty, inactive item, stock and cart size are enforced', async () => {
    const u = newUser();
    expect(reason(await add({ user: u }, v.minFive, 2))).toBe('QTY_BELOW_MIN');
    expect((await add({ user: u }, v.minFive, 5)).statusCode).toBe(200);
    expect(reason(await add({ user: u }, v.inactive, 1))).toBe('VARIANT_NOT_SELLABLE');
    expect(reason(await add({ user: u }, v.stocked, 4))).toBe('OUT_OF_STOCK');
    expect((await add({ user: u }, v.stocked, 3)).statusCode).toBe(200);
    expect((await add({ user: u }, v.ambient, 1)).statusCode).toBe(200);
    expect(reason(await add({ user: u }, v.extra, 1))).toBe('CART_FULL'); // CART_MAX_LINES=3
    // Stock drops after the add → blocking notice on read (soft check, revalidated at load).
    await deliver('inventory.availability_changed.v1', {
      variantId: v.stocked,
      availableQty: 1,
      inStock: true,
      lowStock: true,
      sequence: 2,
    });
    const cart = data<CartView>(await call('GET', '/cart', { user: u }));
    expect(cart.notices.map((n) => n.code)).toContain('INSUFFICIENT_STOCK');
    expect(cart.summary.checkoutBlocked).toBe(true);
    await deliver('inventory.availability_changed.v1', {
      variantId: v.stocked,
      availableQty: 3,
      inStock: true,
      lowStock: true,
      sequence: 3,
    });
  });

  it('PUT is absolute + idempotent, 0 removes, a stale expectedVersion is 409', async () => {
    const u = newUser();
    await add({ user: u }, v.vaccine, 1);
    const set = await call('PUT', `/cart/items/${v.vaccine}`, { user: u, payload: { qty: 24 } });
    const again = await call('PUT', `/cart/items/${v.vaccine}`, { user: u, payload: { qty: 24 } });
    expect(data<{ line: { qty: number } }>(set).line.qty).toBe(24);
    expect(data<{ line: { qty: number } }>(again).line.qty).toBe(24);
    const version = data<{ cartVersion: number }>(again).cartVersion;

    const stale = await call('PUT', `/cart/items/${v.vaccine}`, {
      user: u,
      payload: { qty: 5, expectedVersion: version - 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(reason(stale)).toBe('CART_VERSION_CONFLICT');

    const removed = await call('PUT', `/cart/items/${v.vaccine}`, {
      user: u,
      payload: { qty: 0, expectedVersion: version },
    });
    expect(data<{ line: null; itemCount: number }>(removed)).toMatchObject({
      line: null,
      itemCount: 0,
    });
    const noop = await call('DELETE', `/cart/items/${v.vaccine}`, { user: u });
    expect(data<{ cartVersion: number }>(noop).cartVersion).toBe(version + 1);
  });

  it('login merge: summed + capped, exactly once under 5 parallel calls, guest cart MERGED', async () => {
    const guest = data<{ guestToken: string }>(await add({}, v.capped, 8)).guestToken;
    guestTokens.push(guest);
    await add({ token: guest }, v.ambient, 2);
    const u = newUser();
    await add({ user: u }, v.capped, 5);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => call('GET', '/cart', { user: u, token: guest })),
    );
    expect(results.filter((r) => r.headers['x-cart-merged'] === 'true')).toHaveLength(1);
    const cart = data<CartView>(await call('GET', '/cart', { user: u }));
    expect(qtyOf(cart, v.capped)).toBe(10); // 5 + 8 capped at max 10
    expect(qtyOf(cart, v.ambient)).toBe(2);
    const row = await app.diContainer
      .resolve('db')
      .cart.findUnique({ where: { guestToken: guest } });
    expect(row?.status).toBe('MERGED');
    // Explicit merge afterwards: nothing left to merge.
    expect(data(await call('POST', '/cart/merge', { user: u, token: guest }))).toMatchObject({
      merged: false,
    });
    // The merged token is dead for guests: reads are empty, a write starts a NEW cart.
    expect(data<CartView>(await call('GET', '/cart', { token: guest })).cartId).toBeNull();
    const fresh = data<{ guestToken: string }>(
      await add({ token: guest }, v.ambient, 1),
    ).guestToken;
    guestTokens.push(fresh);
    expect(fresh).not.toBe(guest);
  });

  it('price snapshot: PRICE_CHANGED after a price move, cleared by refresh-prices', async () => {
    const u = newUser();
    await add({ user: u }, v.extra, 2);
    await price(v.extra, '120.00', 5);
    let cart = data<CartView>(await call('GET', '/cart', { user: u }));
    expect(cart.notices).toContainEqual(
      expect.objectContaining({ code: 'PRICE_CHANGED', variantId: v.extra }),
    );
    expect(cart.lines[0]?.unitPrice).toBe('120.00');
    expect((await call('POST', '/cart/refresh-prices', { user: u })).statusCode).toBe(200);
    cart = data<CartView>(await call('GET', '/cart', { user: u }));
    expect(cart.notices.filter((n) => n.code === 'PRICE_CHANGED')).toHaveLength(0);
  });

  it('farm pricing: offers + GST bill for the owner; another user’s farm is 404; unknown coupon is 422', async () => {
    await add({ user: farmOwner }, v.vaccine, 2);
    await add({ user: farmOwner }, v.ambient, 1);
    const cart = data<CartView>(await call('GET', `/cart?farmId=${farmId}`, { user: farmOwner }));
    expect(cart.pricing?.bill.lines).toHaveLength(2);
    expect(cart.consignments.separateDeliveries).toBe(true);
    const stranger = newUser();
    await add({ user: stranger }, v.ambient, 1);
    expect((await call('GET', `/cart?farmId=${farmId}`, { user: stranger })).statusCode).toBe(404);
    const bad = await call('PUT', '/cart/coupon', {
      user: farmOwner,
      payload: { code: 'NOPE-IT' },
    });
    expect(reason(bad)).toBe('COUPON_NOT_FOUND');
    expect((await call('PUT', '/cart/coupon', { payload: { code: 'X' } })).statusCode).toBe(401);
  });

  it('checkout hook: a quote bound to an old cart version → 409 CART_CHANGED; a parallel edit waits for the checkout', async () => {
    const u = newUser();
    await add({ user: u }, v.ambient, 4);
    const quoted = data<CartView>(await call('GET', '/cart', { user: u })).cartVersion;
    const cartService = app.diContainer.resolve('cartService');
    const run = app.diContainer.resolve('runInTransaction');

    await call('PUT', `/cart/items/${v.ambient}`, { user: u, payload: { qty: 5 } }); // edited after the quote
    const stale = run((tx) => cartService.lockForCheckoutInTx(tx, u, quoted));
    await expect(stale).rejects.toMatchObject({
      statusCode: 409,
      details: { reason: 'CART_CHANGED' },
    });

    const current = quoted + 1;
    let editDone = 0;
    let checkoutDone = 0;
    const checkout = run(async (tx) => {
      const { cartId } = await cartService.lockForCheckoutInTx(tx, u, current);
      await new Promise((r) => setTimeout(r, 300));
      await cartService.removeOrderedInTx(tx, cartId, [{ variantId: v.ambient, qty: 5 }]);
      checkoutDone = Date.now();
    });
    await new Promise((r) => setTimeout(r, 50));
    const edit = call('POST', '/cart/items', {
      user: u,
      payload: { variantId: v.extra, qty: 1 },
    }).then((r) => {
      editDone = Date.now();
      return r;
    });
    await Promise.all([checkout, edit]);
    expect(editDone).toBeGreaterThanOrEqual(checkoutDone); // serialised on the cart row lock
    const cart = data<CartView>(await call('GET', '/cart', { user: u }));
    expect(cart.lines.map((l) => l.variantId)).toEqual([v.extra]);
    expect(cart.cartVersion).toBe(current + 2);
  });
});
