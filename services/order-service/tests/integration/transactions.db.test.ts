import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  app,
  call,
  captured,
  customer,
  data,
  deliver,
  payment,
  placed,
  staff,
  startOrdersApp,
} from './orders.harness.js';

interface Ledger {
  orderId: string;
  summary: { capturedPaise: number; refundedPaise: number; netPaise: number; net: string };
  transactions: {
    kind: string;
    amountPaise: number;
    method: string | null;
    refundId: string | null;
  }[];
}

/** payment-service totals the reconcile job sees (per payment id). */
const paymentTotals = new Map<string, { capturedPaise: number; refundedPaise: number }>();

const refundProcessed = (
  o: { order: { id: string }; payment: { paymentId: string } },
  refundId: string,
  amountPaise: number,
) =>
  deliver('payment.refund_processed.v1', {
    refundId,
    sourceRef: `it-refund:${refundId}`,
    paymentId: o.payment.paymentId,
    orderId: o.order.id,
    amountPaise,
    arn: `ARN${refundId.slice(0, 8)}`,
    refundedPaise: amountPaise,
    capturedPaise: 20_000,
  });

describe.skipIf(DB_URL === undefined)('order money ledger (OrderTransaction)', () => {
  beforeAll(async () => {
    await startOrdersApp();
    Object.assign(payment, {
      totals: (paymentId: string) => {
        const t = paymentTotals.get(paymentId);
        return t === undefined ? Promise.reject(new Error('unknown payment')) : Promise.resolve(t);
      },
    });
  });
  afterAll(async () => {
    await app.close();
  });

  const ledgerOf = async (orderId: string, user: string) =>
    data<Ledger>(await call('GET', `/orders/${orderId}/transactions`, { user }));

  it('a capture is recorded once, even when the event arrives 20× concurrently with new ids', async () => {
    const o = await placed();
    await Promise.all(Array.from({ length: 20 }, () => captured(o)));
    const l = await ledgerOf(o.order.id, o.user);
    expect(l.transactions).toEqual([
      expect.objectContaining({
        kind: 'CAPTURE',
        amountPaise: 20_000,
        method: 'upi',
        refundId: null,
      }),
    ]);
    expect(l.summary).toMatchObject({
      capturedPaise: 20_000,
      refundedPaise: 0,
      netPaise: 20_000,
      net: '200.00',
    });
  });

  it('partial refunds: parallel + duplicate events → one row each, exact sums, method of the capture', async () => {
    const o = await placed();
    await captured(o);
    const [r1, r2, r3] = [randomUUID(), randomUUID(), randomUUID()];
    await Promise.all([
      refundProcessed(o, r1, 5_000),
      refundProcessed(o, r2, 2_500),
      refundProcessed(o, r3, 1_000),
      refundProcessed(o, r1, 5_000),
      refundProcessed(o, r2, 2_500),
    ]);
    const l = await ledgerOf(o.order.id, o.user);
    const refunds = l.transactions.filter((t) => t.kind === 'REFUND');
    expect(refunds.map((t) => t.amountPaise).sort((a, b) => a - b)).toEqual([1_000, 2_500, 5_000]);
    expect(refunds.every((t) => t.method === 'upi')).toBe(true);
    expect(l.summary).toMatchObject({
      capturedPaise: 20_000,
      refundedPaise: 8_500,
      netPaise: 11_500,
    });
  });

  it('events in any order: a refund before its capture never corrupts the totals', async () => {
    const o = await placed();
    await refundProcessed(o, randomUUID(), 3_000);
    await captured(o);
    const l = await ledgerOf(o.order.id, o.user);
    expect(l.summary).toMatchObject({
      capturedPaise: 20_000,
      refundedPaise: 3_000,
      netPaise: 17_000,
    });
  });

  it('is append-only: UPDATE and DELETE are rejected by the database', async () => {
    const o = await placed();
    await captured(o);
    const db = app.diContainer.resolve('db');
    await expect(
      db.orderTransaction.updateMany({ where: { orderId: o.order.id }, data: { amountPaise: 1n } }),
    ).rejects.toThrow();
    await expect(
      db.orderTransaction.deleteMany({ where: { orderId: o.order.id } }),
    ).rejects.toThrow();
  });

  it('authorization: other buyers get 404, staff need orders.view, mismatches need payments.view', async () => {
    const o = await placed();
    await captured(o);
    expect(
      (await call('GET', `/orders/${o.order.id}/transactions`, { user: customer() })).statusCode,
    ).toBe(404);
    expect(
      (await call('GET', `/orders/${randomUUID()}/transactions`, { user: o.user })).statusCode,
    ).toBe(404);
    expect((await call('GET', `/orders/${o.order.id}/transactions`)).statusCode).toBe(401);

    const viewer = staff('orders.view');
    const res = await call('GET', `/admin/orders/${o.order.id}/transactions`, { user: viewer });
    expect(res.statusCode).toBe(200);
    expect(data<Ledger>(res).summary.capturedPaise).toBe(20_000);
    expect(
      (await call('GET', `/admin/orders/${o.order.id}/transactions`, { user: staff() })).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', '/admin/orders/ledger-mismatches', { user: viewer })).statusCode,
    ).toBe(403);
  });

  it('reconcile: flags a payment whose totals disagree, clears it once consistent', async () => {
    const o = await placed();
    await captured(o);
    await refundProcessed(o, randomUUID(), 4_000);
    const svc = app.diContainer.resolve('transactionsService');
    const finance = staff('payments.view');
    const mismatched = async () =>
      data<{ paymentId: string }[]>(
        await call('GET', '/admin/orders/ledger-mismatches?limit=100', { user: finance }),
      ).some((m) => m.paymentId === o.payment.paymentId);

    // payment-service says 2 refunds (₹40 + ₹45) but the ledger only saw one.
    paymentTotals.set(o.payment.paymentId, { capturedPaise: 20_000, refundedPaise: 8_500 });
    expect((await svc.reconcile(0)).mismatches).toBeGreaterThanOrEqual(1);
    expect(await mismatched()).toBe(true);

    // The missing refund event arrives → consistent on the next run.
    await refundProcessed(o, randomUUID(), 4_500);
    await svc.reconcile(0);
    expect(await mismatched()).toBe(false);
    const check = await app.diContainer
      .resolve('db')
      .orderLedgerCheck.findUnique({ where: { paymentId: o.payment.paymentId } });
    expect(check).toMatchObject({
      status: 'OK',
      ledgerRefundedPaise: 8_500n,
      paymentRefundedPaise: 8_500n,
    });
  });
});
