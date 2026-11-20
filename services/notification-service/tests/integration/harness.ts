import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope, InboxResult } from '@farmx/infra/events';
import type { Prisma } from '@farmx/database/client';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { createEventHandler } from '../../src/adapters/events.js';
import { buildApp } from '../../src/app.js';

/**
 * Integration tests against REAL Postgres (local dev DB with migrations, never Neon):
 *   NOTIFICATION_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/notification-service test
 * Skipped when the variable is not set. auth-service (directory) and BullMQ producers are stubbed.
 */
export const DB_URL = process.env.NOTIFICATION_IT_DATABASE_URL;
export const RABBITMQ_URL = process.env.RABBITMQ_URL ?? 'amqp://farmx:farmx@localhost:5672';

type UserType = 'CUSTOMER' | 'INTERNAL' | 'LOGISTICS_PARTNER' | 'VENDOR';
const users = new Map<string, { user: AuthUser; permissions: string[] }>();

/** Registers a signed-in user; the bearer token IS the user id (verifier stubbed). */
export const signIn = (userType: UserType = 'CUSTOMER', permissions: string[] = []): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType,
      roles: [],
      scope: 'full',
      expiresAt: Math.floor(Date.now() / 1000) + 900,
    } as unknown as AuthUser,
    permissions,
  });
  return id;
};

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  r: { user?: string; payload?: object } = {},
) =>
  app.inject({
    method,
    url,
    headers: r.user === undefined ? {} : { authorization: `Bearer ${r.user}` },
    ...(r.payload === undefined ? {} : { payload: r.payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T; meta?: { nextCursor: string | null } }>().data;
export const meta = (res: LightMyRequestResponse) =>
  res.json<{ meta: { nextCursor: string | null; limit: number } }>().meta;

export interface Directory {
  holders: string[];
  /** APP audience pages keyed by cursor ('' = first page). */
  pages: Map<string, { ids: string[]; nextCursor: string | null }>;
  /** Number of upcoming directory calls that fail (auth-service down). */
  failNext: number;
}

/** Scriptable providers: every send is recorded; queued failures are returned in order. */
export interface FakeProviders {
  sent: {
    channel: 'PUSH' | 'EMAIL' | 'SMS';
    to: string;
    title: string;
    data?: Record<string, string>;
  }[];
  failNext: { channel: 'PUSH' | 'EMAIL' | 'SMS'; retryable: boolean; code: string }[];
  /** Push tokens FCM reports as unregistered. */
  deadTokens: Set<string>;
}

export interface Contact {
  status: string;
  email: string | null;
  emailVerified: boolean;
  phone: string | null;
  phoneVerified: boolean;
}

export interface TestApp {
  app: FastifyInstance;
  directory: Directory;
  fanoutsQueued: string[];
  deliveriesQueued: { id: string; channel: string; attempts: number; delayMs?: number }[];
  providers: FakeProviders;
  contacts: Map<string, Contact>;
}

const buildFakes = (fakes: FakeProviders) => {
  const failure = (channel: 'PUSH' | 'EMAIL' | 'SMS') => {
    const index = fakes.failNext.findIndex((f) => f.channel === channel);
    return index === -1 ? undefined : fakes.failNext.splice(index, 1)[0];
  };
  return {
    push: {
      name: 'fake-fcm',
      send: (m: {
        tokens: { id: string; token: string }[];
        title: string;
        data: Record<string, string>;
      }) => {
        const f = failure('PUSH');
        if (f !== undefined)
          return Promise.resolve({
            sent: 0,
            providerMessageId: null,
            invalidTokenIds: [],
            retryable: f.retryable,
            error: { code: f.code, message: 'fake' },
          });
        const dead = m.tokens.filter((t) => fakes.deadTokens.has(t.token));
        const live = m.tokens.filter((t) => !fakes.deadTokens.has(t.token));
        for (const t of live)
          fakes.sent.push({ channel: 'PUSH', to: t.token, title: m.title, data: m.data });
        return Promise.resolve({
          sent: live.length,
          providerMessageId: live.length > 0 ? 'fcm-msg-1' : null,
          invalidTokenIds: dead.map((t) => t.id),
          retryable: false,
          error: live.length > 0 ? null : { code: 'UNREGISTERED', message: 'dead' },
        });
      },
    },
    email: {
      name: 'fake-smtp',
      send: (m: { to: string; subject: string }) => {
        const f = failure('EMAIL');
        if (f !== undefined)
          return Promise.resolve({
            ok: false,
            retryable: f.retryable,
            code: f.code,
            message: 'fake',
          });
        fakes.sent.push({ channel: 'EMAIL', to: m.to, title: m.subject });
        return Promise.resolve({ ok: true, providerMessageId: 'smtp-1' });
      },
    },
    sms: {
      name: 'fake-sms',
      send: (m: { to: string; text: string }) => {
        const f = failure('SMS');
        if (f !== undefined)
          return Promise.resolve({
            ok: false,
            retryable: f.retryable,
            code: f.code,
            message: 'fake',
          });
        fakes.sent.push({ channel: 'SMS', to: m.to, title: m.text });
        return Promise.resolve({ ok: true, providerMessageId: 'sms-1' });
      },
    },
  };
};

export const buildTestApp = async (env: Record<string, string> = {}): Promise<TestApp> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '10',
    REDIS_CACHE_URL: 'redis://localhost:6379/8',
    RABBITMQ_URL,
    ...env,
  });
  const directory: Directory = { holders: [], pages: new Map(), failNext: 0 };
  const fail = () => {
    if (directory.failNext > 0) {
      directory.failNext -= 1;
      throw new Error('auth-service down');
    }
  };
  const fanoutsQueued: string[] = [];
  const deliveriesQueued: TestApp['deliveriesQueued'] = [];
  const providers: FakeProviders = { sent: [], failNext: [], deadTokens: new Set() };
  const contacts = new Map<string, Contact>();
  app.diContainer.register({
    authDirectory: asValue({
      listPermissionHolders: () => {
        fail();
        return Promise.resolve(directory.holders);
      },
      listActiveIds: (_type: string, cursor: string | null) => {
        fail();
        return Promise.resolve(directory.pages.get(cursor ?? '') ?? { ids: [], nextCursor: null });
      },
      getContact: (userId: string) => {
        fail();
        const c = contacts.get(userId);
        return Promise.resolve(
          c === undefined
            ? null
            : { id: userId, userType: 'CUSTOMER', fullName: 'Test', preferredLanguage: 'en', ...c },
        );
      },
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
    accessClient: asValue({
      hasPermission: (userId: string, key: string) =>
        Promise.resolve(users.get(userId)?.permissions.includes(key) ?? false),
    } as never),
    queues: asValue({
      enqueueFanout: (id: string) => {
        fanoutsQueued.push(id);
        return Promise.resolve();
      },
      enqueueDeliveries: (jobs: TestApp['deliveriesQueued']) => {
        deliveriesQueued.push(...jobs);
        return Promise.resolve();
      },
      close: () => Promise.resolve(),
    } as never),
    providers: asValue(buildFakes(providers) as never),
  });
  await app.ready();
  return { app, directory, fanoutsQueued, deliveriesQueued, providers, contacts };
};

export const envelope = (type: string, data: object, id: string = randomUUID()): EventEnvelope => ({
  id,
  type,
  version: 1,
  occurredAt: new Date().toISOString(),
  source: 'test',
  correlationId: 'it',
  data,
});

/** The real consumer path (inbox claim + handler + post-commit), without RabbitMQ. */
export const deliver = (app: FastifyInstance, event: EventEnvelope): Promise<InboxResult> =>
  createEventHandler(app.diContainer.cradle)(event);

const withRows = {
  recipients: { orderBy: { userId: 'asc' } },
  deliveries: { orderBy: [{ userId: 'asc' }, { channel: 'asc' }] },
} satisfies Prisma.NotificationInclude;
export type NotificationWithRows = Prisma.NotificationGetPayload<{ include: typeof withRows }>;

export const notificationsOf = (
  app: FastifyInstance,
  entityId: string,
): Promise<NotificationWithRows[]> =>
  app.diContainer.resolve('db').notification.findMany({
    where: { entityId },
    orderBy: { createdAt: 'asc' },
    include: withRows,
  });

export const byDedupeKey = (
  app: FastifyInstance,
  dedupeKey: string,
): Promise<NotificationWithRows | null> =>
  app.diContainer.resolve('db').notification.findUnique({
    where: { dedupeKey },
    include: withRows,
  });

/** A placed order (also records the order → buyer projection). */
export const placeOrder = async (app: FastifyInstance, userId: string = randomUUID()) => {
  const order = { orderId: randomUUID(), orderNo: `ORD-IT-${randomUUID().slice(0, 6)}`, userId };
  await deliver(
    app,
    envelope('order.placed.v1', {
      ...order,
      farmId: randomUUID(),
      grandTotal: '27821.00',
      paymentDueAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    }),
  );
  return order;
};
