import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { buildApp } from '../../src/app.js';
import type { PaymentRow } from '../../src/features/payments/payments.types.js';
import type { RefundRow } from '../../src/features/refunds/refunds.types.js';

/**
 * Integration tests against REAL Postgres (local dev DB, never Neon) and a real redis-cache DB 7
 * (mock gateway state + rate limits), with the MOCK gateway:
 *   PAYMENT_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/payment-service test
 * Skipped when the variable is not set. Token verification + permissions are stubbed: the bearer
 * token IS the user id.
 */
export const DB_URL = process.env.PAYMENT_IT_DATABASE_URL;
export const INTERNAL_TOKEN = 'it-internal-token-0123456789abcdef0123456789';

const users = new Map<string, { user: AuthUser; permissions: string[] }>();

const register = (userType: 'CUSTOMER' | 'INTERNAL', permissions: string[]): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType,
      roles: [],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    permissions,
  });
  return id;
};
export const customer = (): string => register('CUSTOMER', []);
export const staff = (...permissions: string[]): string => register('INTERNAL', permissions);

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '20',
    REDIS_CACHE_URL: 'redis://localhost:6379/7',
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
    PAYMENT_PROVIDER: 'mock',
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
  });
  await app.ready();
  return app;
};

export interface Req {
  user?: string;
  internal?: boolean;
  payload?: object;
  headers?: Record<string, string>;
}

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST',
  url: string,
  r: Req = {},
) =>
  app.inject({
    method,
    url,
    headers: {
      ...(r.user === undefined ? {} : { authorization: `Bearer ${r.user}` }),
      ...(r.internal === true ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
      ...r.headers,
    },
    ...(r.payload === undefined ? {} : { payload: r.payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: { reason?: string } } }>().error;

export interface Checkout {
  paymentId: string;
  providerOrderId: string;
  amountPaise: number;
  status: string;
}
export interface Payment {
  id: string;
  status: string;
  capturedPaise: number;
  refundedPaise: number;
  attemptCount: number;
  amountMismatch: boolean;
  providerPaymentId: string | null;
}

/** order-service checkout: create (or reuse) the order's payment. */
export const createPayment = async (
  app: FastifyInstance,
  o: { orderId?: string; userId: string; amountPaise?: number; expiresInMs?: number },
) => {
  const res = await call(app, 'POST', '/internal/payments', {
    internal: true,
    payload: {
      orderId: o.orderId ?? randomUUID(),
      orderNo: 'ORD-26-IT0001',
      userId: o.userId,
      amountPaise: o.amountPaise ?? 2_782_100,
      currency: 'INR',
      expiresAt: new Date(Date.now() + (o.expiresInMs ?? 30 * 60_000)).toISOString(),
    },
  });
  if (res.statusCode !== 200) throw new Error(res.body);
  return data<Checkout>(res);
};

/** Buyer pays in the mock checkout, then the app calls verify (the real path). */
export const payAndVerify = async (app: FastifyInstance, user: string, paymentId: string) => {
  const cb = await call(app, 'POST', `/payments/${paymentId}/mock/succeed`, { user, payload: {} });
  if (cb.statusCode !== 200) throw new Error(cb.body);
  const res = await call(app, 'POST', `/payments/${paymentId}/verify`, {
    user,
    payload: data(cb),
  });
  if (res.statusCode !== 200) throw new Error(res.body);
  return data<Payment>(res);
};

let seq = 0;
/** Runs a consumer handler directly (no RabbitMQ / inbox) inside one transaction. */
export const deliver = async (app: FastifyInstance, type: string, payload: object) => {
  const handlers = {
    ...app.diContainer.resolve('paymentEventHandlers'),
    ...app.diContainer.resolve('refundEventHandlers'),
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

/** Outbox events of a type whose data mentions `needle`. */
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

export const paymentRow = async (app: FastifyInstance, id: string): Promise<PaymentRow> =>
  app.diContainer.resolve('db').payment.findUniqueOrThrow({ where: { id } });

export const refundsOf = async (app: FastifyInstance, paymentId: string): Promise<RefundRow[]> =>
  app.diContainer
    .resolve('db')
    .refund.findMany({ where: { paymentId }, orderBy: { createdAt: 'asc' } });
