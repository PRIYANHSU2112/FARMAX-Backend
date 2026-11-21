import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  createPayment,
  customer,
  data,
  deliver,
  errorOf,
  outboxEvents,
  paymentRow,
  refundsOf,
  wallet,
} from './harness.js';

let app: FastifyInstance;
const payments = () => app.diContainer.resolve('paymentsService');
const refunds = () => app.diContainer.resolve('refundsService');
const db = () => app.diContainer.resolve('db');

const AMOUNT = 2_782_100;

/** A buyer with `balance` paise in the (fake) wallet and a WALLET payment for a new order. */
const walletOrder = async (balance = AMOUNT, o: { expiresInMs?: number } = {}) => {
  const user = customer();
  wallet.balances.set(user, balance);
  const orderId = randomUUID();
  const p = await createPayment(app, {
    orderId,
    userId: user,
    method: 'WALLET',
    amountPaise: AMOUNT,
    ...o,
  });
  return { user, orderId, paymentId: p.paymentId, status: p.status };
};

const requestRefund = (
  pay: { paymentId: string; orderId: string },
  amountPaise: number,
  sourceRef = `cancel:${randomUUID()}`,
) =>
  deliver(app, 'order.refund_requested.v1', {
    sourceRef,
    orderId: pay.orderId,
    paymentId: pay.paymentId,
    amountPaise,
    reason: 'Cold box damage refund',
    isSystem: true,
    requestedBy: null,
  });

describe.skipIf(DB_URL === undefined)('WALLET provider (D-54, fake wallet-service)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  beforeEach(() => {
    wallet.down = false;
    wallet.loseReply = false;
  });

  afterAll(async () => {
    await app.close();
  });

  it('enough balance: CAPTURED at once, payment.captured.v1 (method wallet), one debit', async () => {
    const o = await walletOrder();
    expect(o.status).toBe('CAPTURED');
    const row = await paymentRow(app, o.paymentId);
    expect(row).toMatchObject({
      provider: 'WALLET',
      status: 'CAPTURED',
      method: 'wallet',
      wallet: 'farmx',
      capturedPaise: BigInt(AMOUNT),
      providerOrderId: null,
    });
    expect(row.providerPaymentId).toMatch(/^WJ-IT-/);
    const events = await outboxEvents(app, 'payment.captured.v1', o.paymentId);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({ orderId: o.orderId, method: 'wallet' });
    expect(wallet.balances.get(o.user)).toBe(0);

    const again = await call(app, 'POST', '/internal/payments', {
      internal: true,
      payload: {
        orderId: o.orderId,
        orderNo: 'ORD-26-IT0001',
        userId: o.user,
        amountPaise: AMOUNT,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        method: 'WALLET',
      },
    });
    expect(errorOf(again).details?.reason).toBe('ALREADY_PAID');
  });

  it('short balance: FAILED (INSUFFICIENT_WALLET_BALANCE); top up + pay again → CAPTURED', async () => {
    const o = await walletOrder(AMOUNT - 1);
    expect(o.status).toBe('FAILED');
    expect(await paymentRow(app, o.paymentId)).toMatchObject({
      status: 'FAILED',
      failureCode: 'INSUFFICIENT_WALLET_BALANCE',
      attemptCount: 1,
    });
    expect(await outboxEvents(app, 'payment.failed.v1', o.paymentId)).toHaveLength(1);

    wallet.balances.set(o.user, AMOUNT); // the buyer topped up
    const again = await createPayment(app, {
      orderId: o.orderId,
      userId: o.user,
      method: 'WALLET',
      amountPaise: AMOUNT,
    });
    expect(again.paymentId).toBe(o.paymentId);
    expect(again.status).toBe('CAPTURED');
    expect((await paymentRow(app, o.paymentId)).attemptCount).toBe(2);
  });

  it('debit landed but the reply was lost: PENDING, then the live check captures it', async () => {
    wallet.loseReply = true;
    const o = await walletOrder();
    expect(o.status).toBe('PENDING');
    wallet.loseReply = false;
    const live = await call(app, 'GET', `/internal/payments/${o.paymentId}/live-status`, {
      internal: true,
    });
    expect(data<{ status: string }>(live).status).toBe('CAPTURED');
    expect(wallet.debits.get(o.paymentId)?.amountPaise).toBe(AMOUNT); // debited once
    expect(await outboxEvents(app, 'payment.captured.v1', o.paymentId)).toHaveLength(1);
  });

  it('wallet down at checkout: PENDING; the reconcile job debits (idempotently) later', async () => {
    wallet.down = true;
    const o = await walletOrder();
    expect(o.status).toBe('PENDING');
    wallet.down = false;
    await db().payment.update({
      where: { id: o.paymentId },
      data: { createdAt: new Date(Date.now() - 10 * 60_000) },
    });
    await payments().reconcilePending();
    expect((await paymentRow(app, o.paymentId)).status).toBe('CAPTURED');
  });

  it('unknown outcome past the window: never debits late, the payment EXPIRES', async () => {
    wallet.down = true;
    const o = await walletOrder(AMOUNT, { expiresInMs: 1_500 });
    wallet.down = false;
    await new Promise((resolve) => setTimeout(resolve, 1_700));
    const calls = wallet.debitCalls;
    await payments().expireDue();
    expect((await paymentRow(app, o.paymentId)).status).toBe('EXPIRED');
    expect(wallet.debitCalls).toBe(calls);
    expect(wallet.debits.has(o.paymentId)).toBe(false);
    expect(await outboxEvents(app, 'payment.expired.v1', o.paymentId)).toHaveLength(1);
  });

  it('refunds go back to the wallet: partial, rest, then nothing more', async () => {
    const o = await walletOrder();
    await requestRefund(o, 1_000_000);
    await refunds().executeDue();
    const [r1] = await refundsOf(app, o.paymentId);
    expect(r1).toMatchObject({ status: 'PROCESSED' });
    expect(r1?.arn).toMatch(/^WJ-IT-/);
    expect((await paymentRow(app, o.paymentId)).status).toBe('PARTIALLY_REFUNDED');
    expect(wallet.balances.get(o.user)).toBe(1_000_000);

    await requestRefund(o, AMOUNT - 1_000_000);
    await refunds().executeDue();
    expect((await paymentRow(app, o.paymentId)).status).toBe('REFUNDED');
    expect(wallet.balances.get(o.user)).toBe(AMOUNT);

    await requestRefund(o, 1);
    const all = await refundsOf(app, o.paymentId);
    expect(all.at(-1)).toMatchObject({ status: 'FAILED_FINAL', lastError: 'EXCEEDS_CAPTURED' });
    expect(await outboxEvents(app, 'payment.refund_processed.v1', o.paymentId)).toHaveLength(2);
  });

  it('wallet down during a refund: RETRYING, then PROCESSED once', async () => {
    const o = await walletOrder();
    wallet.down = true;
    await requestRefund(o, 500_000);
    await refunds().executeDue();
    const [r] = await refundsOf(app, o.paymentId);
    expect(r?.status).toBe('RETRYING');
    wallet.down = false;
    await db().refund.update({ where: { id: r?.id }, data: { nextRetryAt: new Date() } });
    await refunds().executeDue();
    expect((await refundsOf(app, o.paymentId))[0]?.status).toBe('PROCESSED');
    expect(wallet.balances.get(o.user)).toBe(500_000);
  });

  it('the wallet can never pay a top-up (DB CHECK)', async () => {
    await expect(
      db().payment.create({
        data: {
          paymentNo: `TXN-IT-${randomUUID().slice(0, 8)}`,
          purpose: 'WALLET_TOPUP',
          referenceId: randomUUID(),
          userId: randomUUID(),
          amountPaise: 100n,
          provider: 'WALLET',
          expiresAt: new Date(Date.now() + 60_000),
        },
      }),
    ).rejects.toThrow();
  });
});
