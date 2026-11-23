import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildApp } from '../../src/app.js';

/**
 * Integration tests run against a REAL Postgres with the migrations applied (local dev DB, never
 * Neon):
 *   INVENTORY_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/inventory-service test
 * Skipped when the variable is not set. Redis is an in-memory stub; the bearer token IS the user
 * id, and each test user carries its own permission keys.
 */
export const DB_URL = process.env.INVENTORY_IT_DATABASE_URL;
export const INTERNAL_TOKEN = 'it-internal-token-0123456789abcdef0123456789';

const users = new Map<string, { user: AuthUser; permissions: string[] }>();

export const staff = (...permissions: string[]): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType: 'INTERNAL',
      roles: [],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    permissions,
  });
  return id;
};

/** Minimal in-memory Redis: the commands inventory-service uses (cache, version key, limits). */
const memoryRedis = () => {
  const store = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
    set: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    },
    incr: (k: string) => {
      const next = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(next));
      return Promise.resolve(next);
    },
    del: (k: string) => Promise.resolve(store.delete(k) ? 1 : 0),
    // Rate limiter (Lua) → "Redis down" → the guard allows.
    eval: () => Promise.reject(new Error('no lua in tests')),
    ping: () => Promise.resolve('PONG'),
  };
};

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '20',
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
  });
  app.diContainer.register({
    redis: asValue(memoryRedis() as never),
    accessClient: asValue({
      hasPermission: (userId: string, key: string) =>
        Promise.resolve(users.get(userId)?.permissions.includes(key) ?? false),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
  });
  await app.ready();
  return app;
};

export interface Req {
  user?: string;
  internal?: boolean;
  idem?: string;
  payload?: object;
}

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  url: string,
  r: Req = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(r.user === undefined ? {} : { authorization: `Bearer ${r.user}` }),
      ...(r.internal === true ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
      ...(r.idem === undefined ? {} : { 'idempotency-key': r.idem }),
    },
    ...(r.payload === undefined ? {} : { payload: r.payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: { reason?: string } } }>().error;

/** Random 6-digit PIN in an unused-looking range (tests never collide with each other). */
export const randomPin = (): string => String(900_000 + Math.floor(Math.random() * 99_999));

export const randomCode = (prefix: string): string =>
  `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;

// ── Domain helpers ──

let eventSeq = 0;
const envelope = (type: string, data: object): EventEnvelope => ({
  id: randomUUID(),
  type,
  version: 1,
  occurredAt: new Date(Date.now() + (eventSeq += 1)).toISOString(),
  source: 'test',
  correlationId: 'it',
  data,
});

/** Runs a consumer handler directly (no RabbitMQ / inbox) inside one transaction. */
export const deliver = async (app: FastifyInstance, type: string, data: object): Promise<void> => {
  const handlers = {
    ...app.diContainer.resolve('projectionEventHandlers'),
    ...app.diContainer.resolve('reservationEventHandlers'),
    ...app.diContainer.resolve('warehouseEventHandlers'),
  };
  const handler = handlers[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  await app.diContainer.resolve('runInTransaction')((tx) => handler(envelope(type, data), tx));
};

/** A known, active variant in the inventory projection. */
export const newVariant = async (
  app: FastifyInstance,
  o: { temperatureClass?: string; active?: boolean } = {},
): Promise<string> => {
  const variantId = randomUUID();
  await deliver(app, 'product.variant_created.v1', {
    variantId,
    productId: randomUUID(),
    sku: `IT-${variantId.slice(0, 8)}`,
    productName: 'IT product',
    variantName: variantId.slice(0, 4),
    temperatureClass: o.temperatureClass ?? 'AMB',
    isActive: o.active ?? true,
    version: 1,
  });
  return variantId;
};

/** A warehouse-service snapshot (warehouse.upserted.v1) with sensible defaults. */
export const warehouseFacts = (o: Record<string, unknown> = {}) => ({
  warehouseId: randomUUID(),
  version: 1,
  code: randomCode('IT'),
  name: 'IT Warehouse',
  type: 'DEPOT',
  status: 'ACTIVE',
  parentWarehouseId: null,
  addressLine: 'Plot 1, Test Estate',
  city: 'Tanuku',
  district: 'West Godavari',
  stateCode: '37',
  pinCode: '534211',
  latitude: null,
  longitude: null,
  temperatureClasses: ['AMB'],
  isAllocatable: true,
  priority: 100,
  deleted: false,
  ...o,
});

/**
 * Projects an ACTIVE warehouse serving `pin` (coverage priority = `priority`) the way
 * warehouse-service does it since D-56: warehouse.upserted.v1 + warehouse.coverage_replaced.v1.
 * `_user` is kept for call-site compatibility (no admin API is involved any more).
 */
export const newWarehouse = async (
  app: FastifyInstance,
  _user: string,
  pin: string,
  o: { priority?: number; hasColdChain?: boolean; isAllocatable?: boolean } = {},
): Promise<string> => {
  const facts = warehouseFacts({
    temperatureClasses: o.hasColdChain === true ? ['AMB', 'CC_REF'] : ['AMB'],
    isAllocatable: o.isAllocatable ?? true,
  });
  await deliver(app, 'warehouse.upserted.v1', facts);
  await deliver(app, 'warehouse.coverage_replaced.v1', {
    warehouseId: facts.warehouseId,
    coverageVersion: 1,
    entries: [{ pinCode: pin, priority: o.priority ?? 100 }],
  });
  return facts.warehouseId;
};

export const receive = async (
  app: FastifyInstance,
  user: string,
  warehouseId: string,
  lines: { variantId: string; qty: number }[],
): Promise<void> => {
  const res = await call(app, 'POST', '/admin/inventory/receipts', {
    user,
    idem: `it-${randomUUID()}`,
    payload: { warehouseId, lines },
  });
  if (res.statusCode !== 201) throw new Error(res.body);
};

export interface LevelQty {
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
}

export const levelOf = async (
  app: FastifyInstance,
  warehouseId: string,
  variantId: string,
): Promise<LevelQty> => {
  const row = await app.diContainer.resolve('db').stockLevel.findUnique({
    where: { warehouseId_variantId: { warehouseId, variantId } },
    select: { onHand: true, reserved: true, damaged: true, safetyStock: true },
  });
  return row ?? { onHand: 0, reserved: 0, damaged: 0, safetyStock: 0 };
};

/** Σ onHandDelta of the ledger for one warehouse × variant (must equal onHand). */
export const ledgerOnHand = async (
  app: FastifyInstance,
  warehouseId: string,
  variantId: string,
): Promise<number> => {
  const agg = await app.diContainer.resolve('db').stockLedgerEntry.aggregate({
    where: { warehouseId, variantId },
    _sum: { onHandDelta: true },
  });
  return agg._sum.onHandDelta ?? 0;
};

/** Outbox events of a type whose data mentions `needle` (ids are unique per test). */
export const outboxEvents = async (app: FastifyInstance, type: string, needle: string) => {
  const rows = await app.diContainer.resolve('db').outboxEvent.findMany({
    where: { type },
    orderBy: { createdAt: 'asc' },
    select: { payload: true },
  });
  return rows
    .map((r) => r.payload as unknown as EventEnvelope)
    .filter((e) => JSON.stringify(e.data).includes(needle));
};
