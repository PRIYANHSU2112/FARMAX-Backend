import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { GatewayError } from '../../src/adapters/gateway.js';
import type { MockGateway } from '../../src/adapters/mock-gateway.js';
import {
  DB_URL,
  buildTestApp,
  call,
  createPayment,
  customer,
  data,
  deliver,
  outboxEvents,
  payAndVerify,
  paymentRow,
  refundsOf,
  staff,
} from './harness.js';

let app: FastifyInstance;
const refunds = () => app.diContainer.resolve('refundsService');
const db = () => app.diContainer.resolve('db');

/** A captured payment of ₹27,821.00 (2,782,100 paise). */
const capturedPayment = async () => {
  const user = customer();
  const p = await createPayment(app, { userId: user });
  await payAndVerify(app, user, p.paymentId);
  const row = await paymentRow(app, p.paymentId);
  return { paymentId: p.paymentId, orderId: row.orderId ?? '' };
};

const requestRefund = (
  pay: { paymentId: string; orderId: string },
  amountPaise: number,
  o: { sourceRef?: string; isSystem?: boolean; requestedBy?: string | null } = {},
) =>
  deliver(app, 'order.refund_requested.v1', {
    sourceRef: o.sourceRef ?? `reject:${randomUUID()}`,
    orderId: pay.orderId,
    paymentId: pay.paymentId,
    amountPaise,
    reason: 'IT refund',
    isSystem: o.isSystem ?? true,
    requestedBy: o.requestedBy ?? null,
  });

describe.skipIf(DB_URL === undefined)('refunds against Postgres (mock gateway)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  it('system refund: APPROVED → gateway → PROCESSED; payment REFUNDED; events initiated + processed', async () => {
    const pay = await capturedPayment();
    const sourceRef = `reject:${randomUUID()}`;
    await requestRefund(pay, 2_782_100, { sourceRef });
    expect((await refundsOf(app, pay.paymentId))[0]?.status).toBe('APPROVED');
    await refunds().executeDue();
    const [r] = await refundsOf(app, pay.paymentId);
    expect(r).toMatchObject({ status: 'PROCESSED', attempts: 1 });
    expect(r?.arn).toMatch(/^MOCKARN/);
    expect(await paymentRow(app, pay.paymentId)).toMatchObject({
      status: 'REFUNDED',
      refundedPaise: 2_782_100n,
    });
    expect(await outboxEvents(app, 'payment.refund_initiated.v1', sourceRef)).toHaveLength(1);
    expect(await outboxEvents(app, 'payment.refund_processed.v1', sourceRef)).toHaveLength(1);

    // Same decision again (order-service retry): no second refund, the state is re-sent.
    await requestRefund(pay, 2_782_100, { sourceRef });
    expect(await refundsOf(app, pay.paymentId)).toHaveLength(1);
    expect(await outboxEvents(app, 'payment.refund_processed.v1', sourceRef)).toHaveLength(2);
  });

  it('partial refunds add up; one that would exceed the captured amount fails for good', async () => {
    const pay = await capturedPayment();
    await requestRefund(pay, 1_000_000);
    await requestRefund(pay, 1_500_000);
    const tooMuch = `cancel:${randomUUID()}`;
    await requestRefund(pay, 300_000, { sourceRef: tooMuch }); // 2,500,000 + 300,000 > 2,782,100
    await refunds().executeDue();
    const rows = await refundsOf(app, pay.paymentId);
    expect(rows.map((r) => r.status)).toEqual(['PROCESSED', 'PROCESSED', 'FAILED_FINAL']);
    expect(rows[2]?.lastError).toBe('EXCEEDS_CAPTURED');
    expect(await paymentRow(app, pay.paymentId)).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refundedPaise: 2_500_000n,
    });
    expect(await outboxEvents(app, 'payment.refund_failed.v1', tooMuch)).toHaveLength(1);
  });

  it('refuses a refund for an uncaptured payment', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    const row = await paymentRow(app, p.paymentId);
    const sourceRef = `cancel:${randomUUID()}`;
    await requestRefund({ paymentId: p.paymentId, orderId: row.orderId ?? '' }, 100, { sourceRef });
    const [r] = await refundsOf(app, p.paymentId);
    expect(r).toMatchObject({ status: 'FAILED_FINAL', lastError: 'PAYMENT_NOT_CAPTURED' });
  });

  it('large manual refund waits for a DIFFERENT approver (SoD)', async () => {
    const pay = await capturedPayment();
    const requester = staff('refunds.approve', 'payments.view');
    await db().paymentSetting.update({
      where: { key: 'refundManualApprovalAbovePaise' },
      data: { value: 1000 },
    });
    try {
      // settings are cached 15 s per process: drop the cache for this test
      (app.diContainer.resolve('settingsService') as unknown as { cached: undefined }).cached =
        undefined;
      await requestRefund(pay, 500_000, { isSystem: false, requestedBy: requester });
      const [r] = await refundsOf(app, pay.paymentId);
      expect(r?.status).toBe('PENDING_APPROVAL');
      await refunds().executeDue();
      expect((await refundsOf(app, pay.paymentId))[0]?.status).toBe('PENDING_APPROVAL');

      const self = await call(app, 'POST', `/admin/refunds/${r?.id ?? ''}/approve`, {
        user: requester,
        payload: { reason: 'IT approving my own refund' },
      });
      expect(self.statusCode).toBe(403);
      const approver = staff('refunds.approve');
      const ok = await call(app, 'POST', `/admin/refunds/${r?.id ?? ''}/approve`, {
        user: approver,
        payload: { reason: 'IT verified the QC report' },
      });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(data<{ status: string }>(ok).status).toBe('APPROVED');
      await refunds().executeDue();
      expect((await refundsOf(app, pay.paymentId))[0]?.status).toBe('PROCESSED');
    } finally {
      await db().paymentSetting.update({
        where: { key: 'refundManualApprovalAbovePaise' },
        data: { value: 5_000_000 },
      });
      (app.diContainer.resolve('settingsService') as unknown as { cached: undefined }).cached =
        undefined;
    }
  });

  it('gateway outage → RETRYING with backoff → PROCESSED later', async () => {
    const pay = await capturedPayment();
    const gw = app.diContainer.resolve('gateway') as MockGateway;
    const spy = vi.spyOn(gw, 'refund').mockRejectedValueOnce(new GatewayError('timeout', true));
    await requestRefund(pay, 100_000);
    await refunds().executeDue();
    const [r] = await refundsOf(app, pay.paymentId);
    expect(r?.status).toBe('RETRYING');
    expect(r?.nextRetryAt?.getTime()).toBeGreaterThan(Date.now() + 30_000); // ~1 minute backoff
    await db().refund.update({ where: { id: r?.id ?? '' }, data: { nextRetryAt: new Date() } });
    await refunds().executeDue();
    expect((await refundsOf(app, pay.paymentId))[0]).toMatchObject({
      status: 'PROCESSED',
      attempts: 2,
    });
    spy.mockRestore();
  });

  it('gateway refusal → FAILED_FINAL (refund_failed) → admin retry → PROCESSED', async () => {
    const pay = await capturedPayment();
    const gw = app.diContainer.resolve('gateway') as MockGateway;
    const spy = vi
      .spyOn(gw, 'refund')
      .mockRejectedValueOnce(new GatewayError('Bank account closed', false, 'BAD_REQUEST_ERROR'));
    const sourceRef = `reject:${randomUUID()}`;
    await requestRefund(pay, 200_000, { sourceRef });
    await refunds().executeDue();
    const [r] = await refundsOf(app, pay.paymentId);
    expect(r?.status).toBe('FAILED_FINAL');
    expect(await outboxEvents(app, 'payment.refund_failed.v1', sourceRef)).toHaveLength(1);

    const viewerOnly = staff('payments.view');
    const denied = await call(app, 'POST', `/admin/refunds/${r?.id ?? ''}/retry`, {
      user: viewerOnly,
      payload: { reason: 'IT not allowed to retry' },
    });
    expect(denied.statusCode).toBe(403);
    const ops = staff('refunds.initiate');
    const retry = await call(app, 'POST', `/admin/refunds/${r?.id ?? ''}/retry`, {
      user: ops,
      payload: { reason: 'IT bank details corrected' },
    });
    expect(retry.statusCode, retry.body).toBe(200);
    await refunds().executeDue();
    expect((await refundsOf(app, pay.paymentId))[0]?.status).toBe('PROCESSED');
    spy.mockRestore();
  });

  it('crash after the gateway accepted: the refund is ADOPTED, never sent twice', async () => {
    const pay = await capturedPayment();
    await requestRefund(pay, 50_000);
    const [r] = await refundsOf(app, pay.paymentId);
    const p = await paymentRow(app, pay.paymentId);
    const gw = app.diContainer.resolve('gateway') as MockGateway;
    // The worker sent it, then died before recording the outcome:
    await gw.refund({
      paymentId: p.providerPaymentId ?? '',
      amountPaise: 50_000,
      refundId: r?.id ?? '',
      receipt: 'x',
    });
    await db().refund.update({
      where: { id: r?.id ?? '' },
      data: { status: 'PROCESSING', attempts: 1, updatedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await refunds().syncStale(); // abandoned claim → RETRYING
    await refunds().executeDue(); // adopts the gateway refund
    expect((await refundsOf(app, pay.paymentId))[0]?.status).toBe('PROCESSED');
    expect(await gw.listRefunds(p.providerPaymentId ?? '')).toHaveLength(1);
  });

  it('parallel refund decisions never exceed the captured amount', async () => {
    const pay = await capturedPayment();
    await Promise.allSettled(Array.from({ length: 10 }, () => requestRefund(pay, 500_000)));
    const live = (await refundsOf(app, pay.paymentId)).filter((r) => r.status !== 'FAILED_FINAL');
    const total = live.reduce((n, r) => n + r.amountPaise, 0n);
    expect(total).toBeLessThanOrEqual(2_782_100n);
    expect(live).toHaveLength(5);
    await refunds().executeDue();
    expect((await paymentRow(app, pay.paymentId)).refundedPaise).toBe(2_500_000n);
  });
});
