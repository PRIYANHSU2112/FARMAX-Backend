import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  type Checkout,
  DB_URL,
  buildTestApp,
  call,
  customer,
  data,
  deliver,
  errorOf,
  outboxEvents,
  payAndVerify,
  paymentRow,
  refundsOf,
} from './harness.js';

let app: FastifyInstance;
const processWebhooks = () => app.diContainer.resolve('webhooksService').processPending();

/** wallet-service: create (or reuse) the payment of one top-up. */
const topupPayment = (o: {
  topupId?: string;
  userId: string;
  amountPaise?: number;
  expiresInMs?: number;
}) =>
  call(app, 'POST', '/internal/payments/topups', {
    internal: true,
    payload: {
      topupId: o.topupId ?? randomUUID(),
      topupNo: 'TU-261121-0000ABCD',
      userId: o.userId,
      amountPaise: o.amountPaise ?? 1_000_000,
      currency: 'INR',
      expiresAt: new Date(Date.now() + (o.expiresInMs ?? 30 * 60_000)).toISOString(),
    },
  });

describe.skipIf(DB_URL === undefined)('wallet top-up payments (D-54)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('one payment per top-up (idempotent), purpose WALLET_TOPUP, no order', async () => {
    const user = customer();
    const topupId = randomUUID();
    const a = data<Checkout>(await topupPayment({ topupId, userId: user }));
    const b = data<Checkout>(await topupPayment({ topupId, userId: user }));
    expect(b.paymentId).toBe(a.paymentId);
    expect(a.status).toBe('PENDING');
    const row = await paymentRow(app, a.paymentId);
    expect(row).toMatchObject({
      purpose: 'WALLET_TOPUP',
      referenceId: topupId,
      orderId: null,
      orderNo: null,
    });

    const other = await topupPayment({ topupId, userId: user, amountPaise: 999 });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).details?.reason).toBe('TOPUP_MISMATCH');
    expect((await topupPayment({ topupId, userId: customer() })).statusCode).toBe(409);
  });

  it('capture publishes payment.topup_captured.v1 (never payment.captured.v1)', async () => {
    const user = customer();
    const topupId = randomUUID();
    const p = data<Checkout>(await topupPayment({ topupId, userId: user, amountPaise: 500_000 }));
    expect((await payAndVerify(app, user, p.paymentId)).status).toBe('CAPTURED');
    await processWebhooks(); // the mock webhook replays the capture: still one event
    const captured = await outboxEvents(app, 'payment.topup_captured.v1', p.paymentId);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.data).toMatchObject({
      paymentId: p.paymentId,
      topupId,
      userId: user,
      amountPaise: 500_000,
      expectedPaise: 500_000,
      method: 'upi',
    });
    expect(await outboxEvents(app, 'payment.captured.v1', p.paymentId)).toHaveLength(0);
  });

  it('a failed attempt publishes payment.topup_failed.v1; a retry can still capture', async () => {
    const user = customer();
    const p = data<Checkout>(await topupPayment({ userId: user }));
    const fail = await call(app, 'POST', `/payments/${p.paymentId}/mock/fail`, {
      user,
      payload: {},
    });
    expect(fail.statusCode).toBe(200);
    await processWebhooks();
    expect(await outboxEvents(app, 'payment.topup_failed.v1', p.paymentId)).toHaveLength(1);
    expect(await outboxEvents(app, 'payment.failed.v1', p.paymentId)).toHaveLength(0);
    expect((await payAndVerify(app, user, p.paymentId)).status).toBe('CAPTURED');
  });

  it('an unpaid top-up expires with payment.topup_expired.v1', async () => {
    const user = customer();
    const p = data<Checkout>(await topupPayment({ userId: user, expiresInMs: 1_500 }));
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    await app.diContainer.resolve('paymentsService').expireDue();
    expect((await paymentRow(app, p.paymentId)).status).toBe('EXPIRED');
    expect(await outboxEvents(app, 'payment.topup_expired.v1', p.paymentId)).toHaveLength(1);
    expect(await outboxEvents(app, 'payment.expired.v1', p.paymentId)).toHaveLength(0);
  });

  it('an order refund request can never refund a top-up payment', async () => {
    const user = customer();
    const p = data<Checkout>(await topupPayment({ userId: user }));
    await payAndVerify(app, user, p.paymentId);
    await deliver(app, 'order.refund_requested.v1', {
      sourceRef: `cancel:${randomUUID()}`,
      orderId: randomUUID(),
      paymentId: p.paymentId,
      amountPaise: 100,
      reason: 'Attempt to refund a wallet top-up through an order',
      isSystem: true,
      requestedBy: null,
    });
    const [r] = await refundsOf(app, p.paymentId);
    expect(r).toMatchObject({ status: 'FAILED_FINAL', lastError: 'PAYMENT_NOT_FOUND_FOR_ORDER' });
    expect((await paymentRow(app, p.paymentId)).refundedPaise).toBe(0n);
  });
});
