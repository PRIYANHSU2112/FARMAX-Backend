import { randomUUID } from 'node:crypto';

import { ServiceUnavailableError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import {
  type PaymentCheckout,
  PaymentRefusal,
  type PaymentState,
} from '../../src/adapters/payment-client.js';
import { buildApp } from '../../src/app.js';
import type { PostInput } from '../../src/features/ledger/index.js';

/**
 * In-memory payment-service (/internal/payments/topups + live-status). Tests drive the gateway
 * outcome with `capture` / `fail` / `expire`; `down` simulates an outage (503).
 */
export class FakePayments {
  readonly byTopup = new Map<string, PaymentState>();
  down = false;
  creates = 0;

  createTopupPayment(input: {
    topupId: string;
    userId: string;
    amountPaise: number;
    expiresAt: Date;
  }): Promise<PaymentCheckout> {
    if (this.down) return Promise.reject(new ServiceUnavailableError('payments down'));
    let p = this.byTopup.get(input.topupId);
    if (p === undefined) {
      if (input.expiresAt.getTime() <= Date.now())
        return Promise.reject(new PaymentRefusal(422, 'VALIDATION_ERROR', 'expired', {}));
      this.creates += 1;
      p = {
        id: randomUUID(),
        paymentNo: `TXN-IT-${String(this.creates).padStart(6, '0')}`,
        purpose: 'WALLET_TOPUP',
        referenceId: input.topupId,
        status: 'PENDING',
        amountPaise: input.amountPaise,
        capturedPaise: 0,
        method: null,
        bank: null,
        cardLast4: null,
        cardNetwork: null,
        vpaMasked: null,
        failureCode: null,
        failureReason: null,
      };
      this.byTopup.set(input.topupId, p);
    }
    return Promise.resolve({
      paymentId: p.id,
      paymentNo: p.paymentNo,
      status: p.status,
      provider: 'MOCK',
      keyId: 'rzp_test_mock',
      providerOrderId: `order_${p.id.slice(0, 8)}`,
      amountPaise: p.amountPaise,
      amount: '',
      currency: 'INR',
      expiresAt: input.expiresAt.toISOString(),
    });
  }

  liveStatus(paymentId: string): Promise<PaymentState> {
    if (this.down) return Promise.reject(new ServiceUnavailableError('payments down'));
    const p = [...this.byTopup.values()].find((x) => x.id === paymentId);
    return p === undefined
      ? Promise.reject(new PaymentRefusal(404, 'NOT_FOUND', 'Payment not found', {}))
      : Promise.resolve({ ...p });
  }

  /** The gateway captured (UPI by default). */
  capture(topupId: string, o: { amountPaise?: number; method?: string } = {}): PaymentState {
    const method = o.method ?? 'upi';
    const p = Object.assign(this.must(topupId), {
      status: 'CAPTURED',
      capturedPaise: o.amountPaise ?? this.must(topupId).amountPaise,
      method,
      vpaMasked: method === 'upi' ? 've***@okhdfc' : null,
      bank: method === 'netbanking' ? 'HDFC' : null,
      cardLast4: method === 'card' ? '4821' : null,
      cardNetwork: method === 'card' ? 'Visa' : null,
    });
    return { ...p };
  }

  fail(topupId: string): PaymentState {
    const p = Object.assign(this.must(topupId), {
      status: 'FAILED',
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'Payment declined',
    });
    return { ...p };
  }

  expire(topupId: string): PaymentState {
    return { ...Object.assign(this.must(topupId), { status: 'EXPIRED' }) };
  }

  private must(topupId: string): PaymentState {
    const p = this.byTopup.get(topupId);
    if (p === undefined) throw new Error(`no payment for top-up ${topupId}`);
    return p;
  }
}

export const payments = new FakePayments();

let eventSeq = 0;
/** Runs a consumer handler directly (no RabbitMQ / inbox) inside one transaction. */
export const deliver = async (app: FastifyInstance, type: string, payload: object) => {
  const handler = {
    ...app.diContainer.resolve('topupEventHandlers'),
    ...app.diContainer.resolve('rewardEventHandlers'),
  }[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  const envelope: EventEnvelope = {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date(Date.now() + (eventSeq += 1)).toISOString(),
    source: 'test',
    correlationId: 'it',
    data: payload,
  };
  await app.diContainer.resolve('runInTransaction')((tx) => handler(envelope, tx));
};

/**
 * Integration tests against REAL Postgres (local dev DB, never Neon) and redis-cache DB 8:
 *   WALLET_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/wallet-service test
 * Skipped when the variable is not set. Token verification + permissions are stubbed: the bearer
 * token IS the user id.
 */
export const DB_URL = process.env.WALLET_IT_DATABASE_URL;
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
    REDIS_CACHE_URL: 'redis://localhost:6379/8',
    INTERNAL_SERVICE_TOKEN: INTERNAL_TOKEN,
  });
  app.diContainer.register({
    paymentClient: asValue(payments as never),
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
  method: 'GET' | 'POST' | 'PUT',
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

/** The error body of a response ({} for a success, so filters over mixed results stay simple). */
export const errorOf = (
  res: LightMyRequestResponse,
): { code?: string; message?: string; details?: { reason?: string } & Record<string, unknown> } =>
  res.json<{ error?: { code: string; message: string; details?: { reason?: string } } }>().error ??
  {};

/** One ledger movement in its own transaction (what a feature does inside its action). */
export const post = (app: FastifyInstance, input: Partial<PostInput> & { userId: string }) =>
  app.diContainer.resolve('runInTransaction')((tx) =>
    app.diContainer.resolve('ledgerService').post(tx, {
      idempotencyKey: `it:${randomUUID()}`,
      kind: 'ADJUSTMENT_CREDIT',
      category: 'ADJUSTMENTS',
      direction: 'CREDIT',
      amountPaise: 10_000n,
      counterparty: 'ADJUSTMENT',
      title: 'Integration test',
      ...input,
    }),
  );

/** The DB view of one customer's ledger: stored balance vs. what the postings say. */
export const ledgerOf = async (app: FastifyInstance, userId: string) => {
  const db = app.diContainer.resolve('db');
  const account = await db.walletAccount.findUnique({ where: { userId } });
  if (account === null) return { balance: 0n, postingsSum: 0n, journals: 0, unbalanced: 0 };
  const [sum] = await db.$queryRaw<{ s: bigint | null }[]>`
    SELECT SUM("amountPaise")::bigint AS s FROM "wallet_postings" WHERE "accountId" = ${account.id}::uuid`;
  const [bad] = await db.$queryRaw<{ n: bigint }[]>`
    SELECT COUNT(*)::bigint AS n FROM (
      SELECT j."id" FROM "wallet_journals" j JOIN "wallet_postings" p ON p."journalId" = j."id"
       WHERE j."userId" = ${userId}::uuid GROUP BY j."id" HAVING SUM(p."amountPaise") <> 0) x`;
  const journals = await db.walletJournal.count({ where: { userId } });
  return {
    balance: account.balancePaise,
    postingsSum: sum?.s ?? 0n,
    journals,
    unbalanced: Number(bad?.n ?? 0n),
  };
};

/** The error a rejected promise carries (AppError code + details.reason). */
export const reasonOf = (err: unknown): string | undefined =>
  (err as { details?: { reason?: string } }).details?.reason;

/** F1 says the order was delivered and the buyer finally paid `netPaidPaise`. */
export const delivered = (
  app: FastifyInstance,
  userId: string,
  netPaidPaise: number,
  orderId: string = randomUUID(),
) =>
  deliver(app, 'order.delivered.v1', {
    orderId,
    orderNo: `ORD-26-${orderId.slice(0, 7)}`,
    userId,
    deliveredAt: new Date().toISOString(),
    lines: [],
    netPaidPaise,
  }).then(() => orderId);
