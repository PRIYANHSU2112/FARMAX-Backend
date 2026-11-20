import { randomUUID } from 'node:crypto';

import { ServiceUnavailableError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { UpstreamRefusal } from '../../src/adapters/internal-clients.js';
import { buildApp } from '../../src/app.js';
import type { OrderRow } from '../../src/features/orders/orders.types.js';

/**
 * Shared setup for the orders integration tests (REAL Postgres, never Neon):
 *   ORDER_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/order-service test
 * inventory-service, payment-service and user-service are in-memory fakes so every race / failure
 * path (docs/oms R1–R9) can be driven deterministically. Bearer token = user id.
 */
export const DB_URL = process.env.ORDER_IT_DATABASE_URL;
const INTERNAL_TOKEN = 'it-internal-token-0123456789abcdef0123456789';

export let app: FastifyInstance;
const users = new Map<string, AuthUser>();
const grants = new Map<string, string[]>();
export const customer = () => {
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

// ── Fakes ──
export type InvMode = 'ok' | 'refuse' | 'down';
export const inventory = {
  mode: 'ok' as InvMode,
  calls: 0,
  async reserve(input: { orderId: string; lines: { variantId: string; qty: number }[] }) {
    this.calls += 1;
    if (this.mode === 'down') throw new ServiceUnavailableError('inventory down');
    if (this.mode === 'refuse')
      throw new UpstreamRefusal(409, 'CONFLICT', 'Not enough stock', {
        reason: 'INSUFFICIENT_STOCK',
        shortfall: [{ variantId: input.lines[0]?.variantId, requested: 5, available: 1 }],
      });
    return Promise.resolve({
      id: randomUUID(),
      orderRef: input.orderId,
      status: 'ACTIVE',
      lines: input.lines.map((l) => ({ ...l, warehouseId: randomUUID() })),
    });
  },
  byOrder: () => Promise.resolve([]),
};
export const payments = new Map<string, string>();
export const payment = {
  live: 'PENDING',
  createForOrder(input: { orderId: string; amountPaise: number; expiresAt: Date }) {
    const paymentId = payments.get(input.orderId) ?? randomUUID();
    payments.set(input.orderId, paymentId);
    return Promise.resolve({
      paymentId,
      paymentNo: 'TXN-IT',
      status: 'PENDING',
      provider: 'MOCK',
      keyId: 'rzp_test_mock',
      providerOrderId: `order_${paymentId.slice(0, 8)}`,
      amountPaise: input.amountPaise,
      amount: (input.amountPaise / 100).toFixed(2),
      currency: 'INR',
      expiresAt: input.expiresAt.toISOString(),
    });
  },
  liveStatus(id: string) {
    return Promise.resolve({ id, status: this.live, capturedPaise: 0 });
  },
};
export const address = {
  snapshot: (userId: string, addressId: string) =>
    Promise.resolve({
      addressId,
      userId,
      version: 1,
      deleted: false,
      formatted: 'Plot 1, Tanuku, 534211',
      contactName: 'IT Farmer',
      contactPhone: '9000000000',
      line1: 'Plot 1',
      line2: null,
      landmark: null,
      village: null,
      mandal: null,
      district: 'West Godavari',
      stateCode: '37',
      pinCode: '534211',
      latitude: null,
      longitude: null,
    }),
};

// ── Helpers ──
export const call = (
  method: 'GET' | 'POST' | 'PATCH',
  url: string,
  o: { user?: string; idem?: string; payload?: object; internal?: boolean } = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(o.user === undefined ? {} : { authorization: `Bearer ${o.user}` }),
      ...(o.idem === undefined ? {} : { 'idempotency-key': o.idem }),
      ...(o.internal === true ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
    },
    ...(o.payload === undefined ? {} : { payload: o.payload }),
  });
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;
export const reason = (res: LightMyRequestResponse) =>
  res.json<{ error: { details?: { reason?: string; orderId?: string } } }>().error.details;

let seq = 0;
export const deliver = async (type: string, payload: object) => {
  const handlers = {
    ...app.diContainer.resolve('projectionEventHandlers'),
    ...app.diContainer.resolve('orderEventHandlers'),
  };
  const handler = handlers[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  const envelope: EventEnvelope = {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date(Date.now() + (seq += 1)).toISOString(),
    source: 'test',
    correlationId: 'it',
    data: payload,
  };
  await app.diContainer.resolve('runInTransaction')((tx) => handler(envelope, tx));
};

export const outbox = async (type: string, needle: string) =>
  (
    await app.diContainer
      .resolve('db')
      .outboxEvent.findMany({ where: { type }, select: { payload: true } })
  )
    .map((r) => r.payload as unknown as EventEnvelope)
    .filter((e) => JSON.stringify(e.data).includes(needle));

export const orderRow = async (id: string): Promise<OrderRow> =>
  await app.diContainer.resolve('db').order.findUniqueOrThrow({ where: { id } });

export interface OrderView {
  id: string;
  orderNo: string;
  status: string;
  failureCode: string | null;
  paymentStatus: string;
  stockStatus: string;
  refundStatus: string;
  paymentException: string | null;
  grandTotal: string;
  timeline: { field: string; to: string }[];
  refunds: { source: string; status: string }[];
  actions: { pay: { allowed: boolean } };
}

export const variant = randomUUID();
export const category = randomUUID();
const farmOwners = new Map<string, string>();

/** A buyer with an ACTIVE farm and `qty` units (₹100 each) in the cart. */
export const buyerWithCart = async (qty = 2) => {
  const user = customer();
  const farmId = randomUUID();
  farmOwners.set(farmId, user);
  await deliver('farm.facts_changed.v1', {
    farmId,
    farmCode: 'FX-WG-L-0' + String(seq),
    ownerUserId: user,
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
  const add = await call('POST', '/cart/items', { user, payload: { variantId: variant, qty } });
  if (add.statusCode >= 300) throw new Error(add.body);
  const cart = data<{ cartVersion: number }>(await call('GET', `/cart?farmId=${farmId}`, { user }));
  return { user, farmId, addressId: randomUUID(), cartVersion: cart.cartVersion };
};

export const checkout = (
  b: { user: string; farmId: string; addressId: string; cartVersion: number },
  idem = `chk-${randomUUID()}`,
) =>
  call('POST', '/orders/checkout', {
    user: b.user,
    idem,
    payload: {
      farmId: b.farmId,
      addressId: b.addressId,
      cartVersion: b.cartVersion,
      billToGst: false,
    },
  });

export const placed = async () => {
  const b = await buyerWithCart();
  const res = await checkout(b);
  if (res.statusCode !== 201) throw new Error(res.body);
  const d = data<{ order: OrderView; payment: { paymentId: string; amountPaise: number } }>(res);
  return { ...b, order: d.order, payment: d.payment };
};

export const captured = (
  o: { order: OrderView; payment: { paymentId: string } },
  amountPaise = 20_000,
) =>
  deliver('payment.captured.v1', {
    paymentId: o.payment.paymentId,
    orderId: o.order.id,
    orderNo: o.order.orderNo,
    amountPaise,
    currency: 'INR',
    expectedPaise: amountPaise,
    method: 'upi',
    providerPaymentId: `pay_${randomUUID().slice(0, 8)}`,
  });

/** A staff user (INTERNAL, full scope) holding these permission keys. */
export const staff = (...permissions: string[]) => {
  const id = randomUUID();
  users.set(id, {
    id,
    sessionId: 's',
    jti: 'j',
    userType: 'INTERNAL',
    roles: [],
    scope: 'full',
    expiresAt: 0,
  } as unknown as AuthUser);
  grants.set(id, permissions);
  return id;
};

export async function startOrdersApp(env: Record<string, string> = {}): Promise<FastifyInstance> {
  app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    ...env,
  });
  app.diContainer.register({
    redis: asValue({
      eval: () => Promise.reject(new Error('down')),
      mget: () => Promise.resolve([null, null]),
      get: () => Promise.resolve(null),
      set: () => Promise.resolve('OK'),
    } as never),
    accessClient: asValue({
      hasPermission: (userId: string, key: string) =>
        Promise.resolve(grants.get(userId)?.includes(key) ?? false),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u);
    }),
    inventoryClient: asValue(inventory as never),
    paymentClient: asValue(payment as never),
    addressClient: asValue(address as never),
  });
  await app.ready();
  await deliver('product.variant_created.v1', {
    variantId: variant,
    productId: randomUUID(),
    sku: 'IT-ORD-1',
    barcode: null,
    productName: 'IT feed',
    variantName: '25 kg',
    manufacturerName: null,
    packSize: '25',
    packUnit: 'KG',
    isPrescriptionRequired: false,
    temperatureClass: 'AMB',
    shelfLifeMonths: null,
    isActive: true,
    categoryId: category,
    categoryPath: [category],
    brandId: randomUUID(),
    hsnCode: '2309',
    gstRate: '0.00',
    minOrderQty: 1,
    maxOrderQty: 500,
    version: 1,
  });
  await deliver('pricing.price_changed.v1', {
    variantId: variant,
    sellingPrice: '100.00',
    currency: 'INR',
    effectiveFrom: new Date().toISOString(),
    sequence: 1,
  });
  return app;
}
