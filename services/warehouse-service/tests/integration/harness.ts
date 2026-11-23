import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { Grants } from '../../src/adapters/auth.js';
import type { StaffContact } from '../../src/adapters/auth-client.js';
import { buildApp } from '../../src/app.js';

/**
 * Integration tests against a REAL Postgres with the migrations applied (local dev DB, never Neon):
 *   WAREHOUSE_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/warehouse-service test
 * Skipped when the variable is not set. Redis is an in-memory stub; the bearer token IS the user
 * id; each test user carries its own grants (GLOBAL and per warehouse).
 */
export const DB_URL = process.env.WAREHOUSE_IT_DATABASE_URL;

const users = new Map<string, { user: AuthUser; grants: Grants }>();

/** A staff user with GLOBAL keys and optional per-warehouse keys. */
export const staff = (permissions: string[], warehouses: Record<string, string[]> = {}): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType: 'INTERNAL',
      roles: ['it_role'],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    grants: { permissions, warehouses },
  });
  return id;
};

/** Gives an existing test user extra keys at one warehouse (after the warehouse exists). */
export const grantAt = (userId: string, warehouseId: string, keys: string[]): void => {
  const u = users.get(userId);
  if (u === undefined) throw new Error('unknown test user');
  u.grants = { ...u.grants, warehouses: { ...u.grants.warehouses, [warehouseId]: keys } };
};

const memoryRedis = () => {
  const store = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
    del: (...keys: string[]) => Promise.resolve(keys.filter((k) => store.delete(k)).length),
    set: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    },
    multi: () => {
      const ops: (() => void)[] = [];
      const chain = {
        set: (k: string, v: string) => {
          ops.push(() => store.set(k, v));
          return chain;
        },
        exec: () => {
          ops.forEach((op) => {
            op();
          });
          return Promise.resolve([]);
        },
      };
      return chain;
    },
    // Rate limiter (Lua) → "Redis down" → the guard allows.
    eval: () => Promise.reject(new Error('no lua in tests')),
    ping: () => Promise.resolve('PONG'),
  };
};

/** Staff directory stub: every id is an ACTIVE staff user named after its first characters. */
const contactOf = (id: string): StaffContact => ({
  id,
  userType: 'INTERNAL',
  status: 'ACTIVE',
  fullName: `Staff ${id.slice(0, 4)}`,
  email: null,
  phone: '+919876543210',
});

/** auth-service team stub: members per warehouse (invite grants, revoke removes). */
export const members = new Map<string, Map<string, { roleId: string; roleKey: string }>>();
export const TEMPLATE = {
  id: '0193a5f2-7c1e-7b2a-9f00-00000000f001',
  key: 'picker',
  name: 'Picker',
  description: null,
  permissions: ['inventory.pick'],
  usage: { staffCount: 0, warehouseCount: 0 },
};
const teamStub = {
  warehouseRoles: () => Promise.resolve([TEMPLATE]),
  scopeMembers: (warehouseId: string) =>
    Promise.resolve(
      [...(members.get(warehouseId) ?? new Map<string, { roleId: string; roleKey: string }>())].map(
        ([userId, r]) => ({
          userId,
          roles: [{ roleId: r.roleId, roleKey: r.roleKey, roleName: 'Picker', assignedAt: '' }],
        }),
      ),
    ),
  invite: (b: { email: string; roleId: string; warehouseId: string }) => {
    const userId = emailIds.get(b.email) ?? randomUUID();
    emailIds.set(b.email, userId);
    const at = members.get(b.warehouseId) ?? new Map<string, { roleId: string; roleKey: string }>();
    const granted = at.get(userId)?.roleId !== b.roleId;
    at.set(userId, { roleId: b.roleId, roleKey: 'picker' });
    members.set(b.warehouseId, at);
    return Promise.resolve({
      userId,
      created: true,
      granted,
      invitationSent: true,
      status: 'PENDING_VERIFICATION',
    });
  },
  resend: () => Promise.resolve({ invitationSent: true }),
  revoke: (b: { userId: string; warehouseId: string }) => {
    const removed = members.get(b.warehouseId)?.delete(b.userId) === true;
    return Promise.resolve({ revoked: removed ? 1 : 0 });
  },
  forget: () => Promise.resolve(),
};
const emailIds = new Map<string, string>();

export const INTERNAL_TOKEN = 'it-internal-token-0123456789abcdef0123456789';

/** What the inventory stub answers to the stats job (null = inventory down). Tests set `rows`. */
export const inventoryStats: { rows: unknown[] | null } = { rows: [] };

/** Deliver one event to the warehouse-service inbox handlers (inside a transaction). */
export const deliver = async (app: FastifyInstance, type: string, data: object): Promise<void> => {
  const handler = app.diContainer.resolve('orderEventHandlers')[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  await app.diContainer.resolve('runInTransaction')((tx) =>
    handler(
      {
        id: randomUUID(),
        type,
        version: 1,
        occurredAt: new Date().toISOString(),
        source: 'it',
        correlationId: randomUUID(),
        data,
      },
      tx,
    ),
  );
};

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '10',
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
  });
  app.diContainer.register({
    redis: asValue(memoryRedis() as never),
    accessClient: asValue({
      grants: (userId: string) =>
        Promise.resolve(users.get(userId)?.grants ?? { permissions: [], warehouses: {} }),
    } as never),
    authClient: asValue({
      contacts: (ids: string[]) => Promise.resolve(new Map(ids.map((id) => [id, contactOf(id)]))),
      requireStaffUser: (id: string) => Promise.resolve(contactOf(id)),
      ...teamStub,
    } as never),
    // Category checks are skipped when the catalog cannot be read (null).
    catalogClient: asValue({ categories: () => Promise.resolve(null) } as never),
    inventoryClient: asValue({
      warehouseStats: () => Promise.resolve(inventoryStats.rows),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
  });
  await app.ready();
  return app;
};

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  user?: string,
  payload?: object,
) =>
  app.inject({
    method,
    url,
    headers: user === undefined ? {} : { authorization: `Bearer ${user}` },
    ...(payload === undefined ? {} : { payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{
    error: { code: string; message: string; details?: { reason?: string; issues?: unknown[] } };
  }>().error;

/** Outbox events of one type about one warehouse, oldest first. */
export const outbox = async (app: FastifyInstance, type: string, warehouseId: string) => {
  const rows = await app.diContainer.resolve('db').outboxEvent.findMany({
    where: { type },
    orderBy: { createdAt: 'asc' },
    select: { payload: true },
  });
  return rows
    .map((r) => (r.payload as { data: Record<string, unknown> }).data)
    .filter((d) => d.warehouseId === warehouseId);
};

export const randomCode = (prefix: string): string =>
  `${prefix}-${randomUUID().slice(0, 8).toUpperCase()}`;

/** A PIN area nobody else uses in these tests (9xx xxx). */
export const randomPinBase = (): number => 900_000 + Math.floor(Math.random() * 98) * 1_000;

/** Weekly hours Mon–Sat 06:00–22:00, Sunday closed. */
export const WEEK = [1, 2, 3, 4, 5, 6, 7].map((isoDay) => ({
  isoDay,
  isOpen: isoDay < 7,
  opensAt: isoDay < 7 ? '06:00' : null,
  closesAt: isoDay < 7 ? '22:00' : null,
}));

/** Storage + calendar steps of the activation checklist (one zone, weekly hours). */
export const prepareSetup = async (app: FastifyInstance, user: string, id: string) => {
  const zone = await call(app, 'POST', `/admin/warehouses/${id}/zones`, user, {
    code: 'A',
    name: 'Feed',
    temperatureClass: 'AMB',
  });
  if (zone.statusCode !== 201) throw new Error(zone.body);
  const hours = await call(app, 'PUT', `/admin/warehouses/${id}/operating-hours`, user, {
    days: WEEK,
  });
  if (hours.statusCode !== 200) throw new Error(hours.body);
};
