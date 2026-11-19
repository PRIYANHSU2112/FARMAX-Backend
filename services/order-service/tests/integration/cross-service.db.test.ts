import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApp } from '../../src/app.js';

/**
 * CONTRACT test: order-service checkout against REAL inventory-service + payment-service processes
 * (same local Postgres). Only the buyer token and the user-service address are stubbed.
 *   1. start inventory (INVENTORY_SERVICE_PORT=3108) and payment (PAYMENT_SERVICE_PORT=3109) with
 *      DATABASE_URL=<local>, INTERNAL_SERVICE_TOKEN=<below>, PAYMENT_PROVIDER=mock
 *   2. ORDER_IT_DATABASE_URL=<local> ORDER_IT_LIVE_SERVICES=1 pnpm --filter @farmx/order-service test
 */
const DB_URL = process.env.ORDER_IT_DATABASE_URL;
const LIVE = process.env.ORDER_IT_LIVE_SERVICES === '1';
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN ?? 'it-internal-token-0123456789abcdef0123456789';

let app: FastifyInstance;
const users = new Map<string, AuthUser>();
const pin = String(800_000 + Math.floor(Math.random() * 99_999));
const variant = randomUUID();
const category = randomUUID();
let warehouseId = '';

const call = (method: 'GET' | 'POST', url: string, o: { user?: string; idem?: string; payload?: object } = {}) =>
  app.inject({
    method,
    url,
    headers: {
      ...(o.user === undefined ? {} : { authorization: `Bearer ${o.user}` }),
      ...(o.idem === undefined ? {} : { 'idempotency-key': o.idem }),
    },
    ...(o.payload === undefined ? {} : { payload: o.payload }),
  });
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) => res.json<{ data: T }>().data;

const deliver = async (type: string, payload: object) => {
  const handler = app.diContainer.resolve('projectionEventHandlers')[type];
  if (handler === undefined) throw new Error(type);
  const e: EventEnvelope = {
    id: randomUUID(), type, version: 1, occurredAt: new Date().toISOString(), source: 'test', correlationId: 'it', data: payload,
  };
  await app.diContainer.resolve('runInTransaction')((tx) => handler(e, tx));
};

const buyer = async (qty: number) => {
  const id = randomUUID();
  users.set(id, { id, sessionId: 's', jti: 'j', userType: 'CUSTOMER', roles: [], scope: 'full', expiresAt: 0 } as unknown as AuthUser);
  const farmId = randomUUID();
  await deliver('farm.facts_changed.v1', {
    farmId, farmCode: null, ownerUserId: id, name: 'Contract Farm', category: 'POULTRY_FARM', productionTypes: ['LAYER'],
    gstin: null, stateCode: '37', territoryCode: 'WG', pinCode: pin, status: 'ACTIVE', version: 1,
  });
  const add = await call('POST', '/cart/items', { user: id, payload: { variantId: variant, qty } });
  if (add.statusCode >= 300) throw new Error(add.body);
  const cart = data<{ cartVersion: number }>(await call('GET', `/cart?farmId=${farmId}`, { user: id }));
  return { user: id, farmId, cartVersion: cart.cartVersion };
};

describe.skipIf(DB_URL === undefined || !LIVE)('checkout against real inventory + payment services', () => {
  beforeAll(async () => {
    app = await buildApp({
      NODE_ENV: 'test', LOG_LEVEL: 'silent', DATABASE_URL: DB_URL, INTERNAL_SERVICE_TOKEN: TOKEN,
      INVENTORY_SERVICE_URL: 'http://127.0.0.1:3108', PAYMENT_SERVICE_URL: 'http://127.0.0.1:3109',
    });
    app.diContainer.register({
      redis: asValue({
        eval: () => Promise.reject(new Error('down')), mget: () => Promise.resolve([null, null]),
        get: () => Promise.resolve(null), set: () => Promise.resolve('OK'),
      } as never),
      accessClient: asValue({ hasPermission: () => Promise.resolve(false) } as never),
      tokenVerifier: asValue((t: string) => {
        const u = users.get(t);
        return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u);
      }),
      addressClient: asValue({
        snapshot: (userId: string, addressId: string) => Promise.resolve({
          addressId, userId, version: 1, deleted: false, formatted: 'Plot 9, Tanuku', contactName: 'C', contactPhone: '9000000000',
          line1: 'Plot 9', line2: null, landmark: null, village: null, mandal: null, district: 'WG', stateCode: '37', pinCode: pin,
          latitude: null, longitude: null,
        }),
      } as never),
    });
    await app.ready();

    // order-service read models
    await deliver('product.variant_created.v1', {
      variantId: variant, productId: randomUUID(), sku: 'CT-1', barcode: null, productName: 'Contract feed', variantName: '25 kg',
      manufacturerName: null, packSize: '25', packUnit: 'KG', isPrescriptionRequired: false, temperatureClass: 'AMB',
      shelfLifeMonths: null, isActive: true, categoryId: category, categoryPath: [category], brandId: randomUUID(),
      hsnCode: '2309', gstRate: '0.00', minOrderQty: 1, maxOrderQty: 500, version: 1,
    });
    await deliver('pricing.price_changed.v1', {
      variantId: variant, sellingPrice: '150.00', currency: 'INR', effectiveFrom: new Date().toISOString(), sequence: 1,
    });

    // inventory-service data (shared DB): a warehouse serving the PIN with 10 units
    const db = app.diContainer.resolve('db');
    const staff = randomUUID();
    const w = await db.warehouse.create({
      data: {
        code: `CT-${randomUUID().slice(0, 8).toUpperCase()}`, name: 'Contract WH', type: 'DEPOT', addressLine: 'Plot 1, Estate',
        city: 'Tanuku', stateCode: '37', pinCode: pin, createdByUserId: staff, updatedByUserId: staff,
      },
    });
    warehouseId = w.id;
    await db.warehouseCoverage.create({ data: { warehouseId, pinCode: pin, priority: 1 } });
    await db.inventoryVariantProjection.create({
      data: { variantId: variant, productId: randomUUID(), sku: 'CT-1', name: 'Contract feed', isActive: true, factsVersion: 1 },
    });
    await db.stockLevel.create({ data: { warehouseId, variantId: variant, onHand: 10 } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('places an order: real reservation (ACTIVE, held) + real mock-gateway payment; replay is the same', async () => {
    const b = await buyer(4);
    const idem = `ct-${randomUUID()}`;
    const body = { farmId: b.farmId, addressId: randomUUID(), cartVersion: b.cartVersion, billToGst: false };
    const res = await call('POST', '/orders/checkout', { user: b.user, idem, payload: body });
    expect(res.statusCode, res.body).toBe(201);
    const { order, payment } = data<{
      order: { id: string; stockStatus: string; grandTotal: string };
      payment: { paymentId: string; provider: string; providerOrderId: string; amountPaise: number };
    }>(res);
    expect(order).toMatchObject({ stockStatus: 'RESERVED', grandTotal: '600.00' });
    expect(payment).toMatchObject({ provider: 'MOCK', amountPaise: 60_000 });
    expect(payment.providerOrderId).toMatch(/^order_mock/);

    const db = app.diContainer.resolve('db');
    const reservation = await db.stockReservation.findFirstOrThrow({ where: { orderRef: order.id }, include: { lines: true } });
    expect(reservation.status).toBe('ACTIVE');
    expect(reservation.lines).toEqual([expect.objectContaining({ warehouseId, variantId: variant, qty: 4 })]);
    const level = await db.stockLevel.findUniqueOrThrow({ where: { warehouseId_variantId: { warehouseId, variantId: variant } } });
    expect(level.reserved).toBe(4);
    const pay = await db.payment.findUniqueOrThrow({ where: { id: payment.paymentId } });
    expect(pay).toMatchObject({ orderId: order.id, status: 'PENDING', amountPaise: 60_000n });

    // Replay: same order, same payment, nothing reserved twice.
    const again = await call('POST', '/orders/checkout', { user: b.user, idem, payload: body });
    expect(again.statusCode).toBe(200);
    expect(data<{ payment: { paymentId: string } }>(again).payment.paymentId).toBe(payment.paymentId);
    expect((await db.stockLevel.findUniqueOrThrow({ where: { warehouseId_variantId: { warehouseId, variantId: variant } } })).reserved).toBe(4);

    // Live status through the real internal API.
    const live = await app.diContainer.resolve('paymentClient').liveStatus(payment.paymentId);
    expect(live.status).toBe('PENDING');
  });

  it('more than the warehouse has: real 409 shortfall → order FAILED, nothing held', async () => {
    const b = await buyer(9); // 10 on hand, 4 already held → 6 sellable
    const res = await call('POST', '/orders/checkout', {
      user: b.user, idem: `ct-${randomUUID()}`,
      payload: { farmId: b.farmId, addressId: randomUUID(), cartVersion: b.cartVersion, billToGst: false },
    });
    expect(res.statusCode, res.body).toBe(409);
    const det = res.json<{ error: { details: { reason: string; orderId: string; shortfall: { available: number }[] } } }>().error.details;
    expect(det.reason).toBe('INSUFFICIENT_STOCK');
    expect(det.shortfall[0]?.available).toBe(6);
    const db = app.diContainer.resolve('db');
    expect((await db.order.findUniqueOrThrow({ where: { id: det.orderId } })).status).toBe('FAILED');
    expect((await db.stockLevel.findUniqueOrThrow({ where: { warehouseId_variantId: { warehouseId, variantId: variant } } })).reserved).toBe(4);
  });
});
