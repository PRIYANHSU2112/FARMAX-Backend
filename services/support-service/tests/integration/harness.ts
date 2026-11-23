import { createHmac, randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { OrderSnapshot } from '../../src/adapters/upstreams.js';
import { buildApp } from '../../src/app.js';

/**
 * Integration tests against REAL Postgres (a local DB with every migration applied, never Neon)
 * and a real redis-cache DB 9:
 *   SUPPORT_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx_supporttest pnpm --filter @farmx/support-service test
 * Skipped when the variable is not set. Token verification + permissions are stubbed (the bearer
 * token IS the user id); auth directory, orders and signed media URLs are in-memory fakes.
 */
export const DB_URL = process.env.SUPPORT_IT_DATABASE_URL;
export const SECRET = 'support-integration-secret-0123456789abcdef';
export const ORIGIN = 'http://allowed.test';

type UserType = 'CUSTOMER' | 'INTERNAL' | 'VENDOR' | 'LOGISTICS_PARTNER';
const users = new Map<string, { user: AuthUser; permissions: string[]; name: string }>();

const register = (userType: UserType, permissions: string[], name: string): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: `s-${id}`,
      jti: 'j',
      userType,
      roles: [],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    permissions,
    name,
  });
  return id;
};
export const customer = (): string => register('CUSTOMER', [], 'Venkata Ramana');
export const vendor = (): string => register('VENDOR', [], 'Godavari Biologicals');
export const staff = (...permissions: string[]): string =>
  register('INTERNAL', permissions, 'Swathi');
export const AGENT_PERMS = [
  'support.view',
  'support.manage',
  'support.assign',
  'support.escalate',
  'support.configure',
];

export const orders = new Map<string, OrderSnapshot & { userId: string }>();
export const addOrder = (userId: string, o: Partial<OrderSnapshot> = {}): string => {
  const orderId = randomUUID();
  orders.set(orderId, {
    userId,
    orderId,
    orderNo: `ORD-26-${orderId.slice(0, 6)}`,
    status: 'CONFIRMED',
    placedAt: new Date().toISOString(),
    grandTotal: '27821.00',
    paymentMethod: 'UPI',
    itemCount: 2,
    firstItemName: 'IBD vaccine',
    temperatureClasses: ['CC_REF'],
    ...o,
  });
  return orderId;
};

/** A receipt exactly as media-service signs it. */
export const receipt = (uploaderId: string, o: Record<string, unknown> = {}): string => {
  const body = Buffer.from(
    JSON.stringify({
      purpose: 'support',
      key: `test/support/${randomUUID()}.jpg`,
      uploaderId,
      kind: 'image',
      mime: 'image/jpeg',
      size: 1_887_436,
      fileName: 'delivery-box.jpg',
      scanStatus: 'REENCODED',
      exp: Math.floor(Date.now() / 1000) + 3600,
      ...o,
    }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`;
};

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '20',
    REDIS_CACHE_URL: 'redis://localhost:6379/9',
    INTERNAL_SERVICE_TOKEN: SECRET,
    SUPPORT_WS_ORIGINS: ORIGIN,
  });
  app.diContainer.register({
    accessClient: asValue({
      hasPermission: (userId: string, key: string) =>
        Promise.resolve(users.get(userId)?.permissions.includes(key) ?? false),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
    authDirectory: asValue({
      contact: (id: string) => {
        const u = users.get(id);
        return Promise.resolve(
          u === undefined
            ? null
            : {
                id,
                userType: u.user.userType,
                status: 'ACTIVE',
                fullName: u.name,
                phone: '+919876544417',
              },
        );
      },
    } as never),
    orderClient: asValue({
      snapshotFor: (orderId: string, userId: string) => {
        const o = orders.get(orderId);
        return Promise.resolve(o?.userId === userId ? o : null);
      },
    } as never),
  });
  const media = app.diContainer.resolve('mediaClient');
  media.signRead = (keys) =>
    Promise.resolve(Object.fromEntries(keys.map((k) => [k, `https://signed.test/${k}`])));
  media.remove = () => Promise.resolve();
  await app.ready();
  await app.diContainer.resolve('redis').flushdb();
  await seedConfig(app);
  return app;
};

/** Topics, the cold-chain rule and wall-clock SLA policies (idempotent). */
async function seedConfig(app: FastifyInstance): Promise<void> {
  const db = app.diContainer.resolve('db');
  for (const t of [
    { code: 'DELIVERY_RETURNS', label: 'Delivery & returns', requiresOrder: true },
    { code: 'PAYMENT', label: 'Payment', requiresOrder: false },
  ])
    await db.supportTopic.upsert({
      where: { app_code: { app: 'CUSTOMER', code: t.code } },
      create: { app: 'CUSTOMER', ...t },
      update: { isActive: true },
    });
  await db.supportTopic.upsert({
    where: { app_code: { app: 'VENDOR', code: 'SETTLEMENT' } },
    create: { app: 'VENDOR', code: 'SETTLEMENT', label: 'Payouts', team: 'FINANCE' },
    update: {},
  });
  if ((await db.supportPriorityRule.count({ where: { name: 'IT cold chain' } })) === 0)
    await db.supportPriorityRule.create({
      data: {
        name: 'IT cold chain',
        app: 'CUSTOMER',
        conditions: { temperatureClasses: ['CC_REF', 'CC_FRZ'] },
        priority: 'HIGH',
        reasonLabel: 'cold chain',
        sortOrder: 1,
      },
    });
  await db.supportSetting.upsert({
    where: { key: 'limits' },
    create: {
      key: 'limits',
      value: { maxOpenTicketsPerUser: 3, autoCloseHours: 72, maxAttachmentsPerMessage: 5 },
    },
    update: {
      value: { maxOpenTicketsPerUser: 3, autoCloseHours: 72, maxAttachmentsPerMessage: 5 },
    },
  });
}

/** Makes a staff user an agent (accepting chats). */
export const makeAgent = async (
  app: FastifyInstance,
  userId: string,
  name = 'Swathi',
  teams = ['SUPPORT', 'LOGISTICS', 'FINANCE', 'VET'],
) => {
  await app.diContainer.resolve('db').supportAgent.upsert({
    where: { userId },
    create: {
      userId,
      displayName: name,
      teams: teams as never,
      apps: ['CUSTOMER', 'VENDOR'],
      acceptingChats: true,
      maxConcurrent: 50,
    },
    update: { displayName: name, isActive: true },
  });
};

export interface Req {
  user?: string;
  payload?: object;
  headers?: Record<string, string>;
}

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  r: Req = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(r.user === undefined ? {} : { authorization: `Bearer ${r.user}` }),
      ...r.headers,
    },
    ...(r.payload === undefined ? {} : { payload: r.payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: { reason?: string } } }>().error;

/** Raises a cold-chain delivery ticket for a fresh customer. */
export const raiseTicket = async (
  app: FastifyInstance,
  user = customer(),
  extra: Record<string, unknown> = {},
  headers?: Record<string, string>,
) => {
  const orderId = addOrder(user);
  const res = await call(app, 'POST', '/support/tickets', {
    user,
    payload: {
      topicCode: 'DELIVERY_RETURNS',
      description: 'IBD vials felt warm when we opened the box.',
      orderId,
      ...extra,
    },
    ...(headers === undefined ? {} : { headers }),
  });
  return {
    res,
    user,
    orderId,
    ticket: data<{ id: string; ticketNo: string; version: number; status: string }>(res),
  };
};
