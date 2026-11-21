import { randomUUID } from 'node:crypto';

import { ServiceUnavailableError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import { WalletRefusal } from '../../src/adapters/wallet-client.js';
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

/**
 * In-memory wallet-service (/internal/wallet): debits per payment, refund credits per refund, never
 * above the debit. `down` = no answer; `loseReply` = the debit lands but the reply is lost.
 */
export class FakeWallet {
  readonly balances = new Map<string, number>();
  readonly debits = new Map<
    string,
    { userId: string; amountPaise: number; journalNo: string; refunded: number }
  >();
  readonly credits = new Map<string, { journalNo: string; amountPaise: number }>();
  down = false;
  loseReply = false;
  debitCalls = 0;
  private seq = 0;

  debit(i: { paymentId: string; userId: string; amountPaise: number }) {
    this.debitCalls += 1;
    if (this.down) return Promise.reject(new ServiceUnavailableError('wallet down'));
    let d = this.debits.get(i.paymentId);
    if (d === undefined) {
      const bal = this.balances.get(i.userId) ?? 0;
      if (bal < i.amountPaise)
        return Promise.reject(
          new WalletRefusal(409, 'Insufficient wallet balance', 'INSUFFICIENT_BALANCE'),
        );
      this.balances.set(i.userId, bal - i.amountPaise);
      d = { userId: i.userId, amountPaise: i.amountPaise, journalNo: this.no(), refunded: 0 };
      this.debits.set(i.paymentId, d);
      if (this.loseReply) return Promise.reject(new ServiceUnavailableError('reply lost'));
    }
    return Promise.resolve(this.view(i.paymentId));
  }

  debitStatus(paymentId: string) {
    if (this.down) return Promise.reject(new ServiceUnavailableError('wallet down'));
    return Promise.resolve(this.view(paymentId));
  }

  credit(i: { refundId: string; paymentId: string; userId: string; amountPaise: number }) {
    if (this.down) return Promise.reject(new ServiceUnavailableError('wallet down'));
    const done = this.credits.get(i.refundId);
    if (done !== undefined) return Promise.resolve({ refundId: i.refundId, ...done });
    const d = this.debits.get(i.paymentId);
    if (d === undefined)
      return Promise.reject(new WalletRefusal(409, 'not a wallet payment', 'NO_WALLET_DEBIT'));
    if (d.refunded + i.amountPaise > d.amountPaise)
      return Promise.reject(new WalletRefusal(409, 'exceeds the debit', 'EXCEEDS_DEBIT'));
    d.refunded += i.amountPaise;
    this.balances.set(d.userId, (this.balances.get(d.userId) ?? 0) + i.amountPaise);
    const c = { journalNo: this.no(), amountPaise: i.amountPaise };
    this.credits.set(i.refundId, c);
    return Promise.resolve({ refundId: i.refundId, journalId: randomUUID(), ...c });
  }

  private view(paymentId: string) {
    const d = this.debits.get(paymentId);
    return {
      status: d === undefined ? 'NONE' : 'DEBITED',
      paymentId,
      journalId: d === undefined ? null : randomUUID(),
      journalNo: d?.journalNo ?? null,
      amountPaise: d?.amountPaise ?? 0,
      refundedPaise: d?.refunded ?? 0,
    };
  }

  private no() {
    this.seq += 1;
    return `WJ-IT-${String(this.seq).padStart(8, '0')}-${randomUUID().slice(0, 4)}`;
  }
}

export const wallet = new FakeWallet();

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
    walletClient: asValue(wallet as never),
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

export const call = (app: FastifyInstance, method: 'GET' | 'POST', url: string, r: Req = {}) =>
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
  o: {
    orderId?: string;
    userId: string;
    amountPaise?: number;
    expiresInMs?: number;
    method?: 'ONLINE' | 'WALLET';
  },
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
      ...(o.method === undefined ? {} : { method: o.method }),
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
