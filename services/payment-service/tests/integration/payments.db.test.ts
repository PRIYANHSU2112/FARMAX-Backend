import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { MockGateway } from '../../src/adapters/mock-gateway.js';
import {
  DB_URL,
  type Payment,
  buildTestApp,
  call,
  createPayment,
  customer,
  data,
  deliver,
  errorOf,
  outboxEvents,
  payAndVerify,
  paymentRow,
  staff,
} from './harness.js';

let app: FastifyInstance;
const mock = () => app.diContainer.resolve('gateway') as MockGateway;
const processWebhooks = () => app.diContainer.resolve('webhooksService').processPending();

describe.skipIf(DB_URL === undefined)('payments against Postgres (mock gateway)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates one payment per order (idempotent) and refuses another amount', async () => {
    const user = customer();
    const orderId = randomUUID();
    const a = await createPayment(app, { orderId, userId: user });
    const b = await createPayment(app, { orderId, userId: user });
    expect(b.paymentId).toBe(a.paymentId);
    expect(a.status).toBe('PENDING');
    expect(a.providerOrderId).toMatch(/^order_mock/);
    const other = await call(app, 'POST', '/internal/payments', {
      internal: true,
      payload: {
        orderId,
        orderNo: 'ORD-26-IT0001',
        userId: user,
        amountPaise: 999,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    });
    expect(other.statusCode).toBe(409);
    expect(errorOf(other).details?.reason).toBe('AMOUNT_CHANGED');
    const noToken = await call(app, 'POST', '/internal/payments', { payload: {} });
    expect(noToken.statusCode).toBe(401);
  });

  it('verify: valid signature + gateway fetch → CAPTURED once (verify and webhook agree)', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    const paid = await payAndVerify(app, user, p.paymentId);
    expect(paid).toMatchObject({
      status: 'CAPTURED',
      capturedPaise: 2_782_100,
      amountMismatch: false,
    });

    // The webhook for the same payment arrives later: no second capture, no second event.
    await processWebhooks();
    const again = await call(app, 'POST', `/payments/${p.paymentId}/verify`, {
      user,
      payload: {
        providerOrderId: p.providerOrderId,
        providerPaymentId: paid.providerPaymentId,
        signature: mock().signCheckout(p.providerOrderId, paid.providerPaymentId ?? ''),
      },
    });
    expect(again.statusCode).toBe(200);
    expect(await outboxEvents(app, 'payment.captured.v1', p.paymentId)).toHaveLength(1);
    expect((await paymentRow(app, p.paymentId)).attemptCount).toBe(1);
  });

  it('rejects a forged signature and hides other buyers’ payments', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    const cb = data<{ providerPaymentId: string }>(
      await call(app, 'POST', `/payments/${p.paymentId}/mock/succeed`, { user, payload: {} }),
    );
    const forged = await call(app, 'POST', `/payments/${p.paymentId}/verify`, {
      user,
      payload: {
        providerOrderId: p.providerOrderId,
        providerPaymentId: cb.providerPaymentId,
        signature: 'a'.repeat(64),
      },
    });
    expect(forged.statusCode).toBe(400);
    expect(errorOf(forged).details?.reason).toBe('SIGNATURE_INVALID');

    const stranger = customer();
    expect(
      (await call(app, 'GET', `/payments/${p.paymentId}`, { user: stranger })).statusCode,
    ).toBe(404);
    const staffToken = staff('payments.view');
    expect(
      (await call(app, 'GET', `/payments/${p.paymentId}`, { user: staffToken })).statusCode,
    ).toBe(403);
  });

  it('a failed attempt marks FAILED; paying again on the same gateway order succeeds', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    const fail = await call(app, 'POST', `/payments/${p.paymentId}/mock/fail`, {
      user,
      payload: {},
    });
    expect(fail.statusCode).toBe(200);
    await processWebhooks();
    expect((await paymentRow(app, p.paymentId)).status).toBe('FAILED');
    expect(await outboxEvents(app, 'payment.failed.v1', p.paymentId)).toHaveLength(1);

    const reuse = await createPayment(app, {
      orderId: (await paymentRow(app, p.paymentId)).orderId ?? undefined,
      userId: user,
    });
    expect(reuse.paymentId).toBe(p.paymentId); // "pay again" = same payment, same gateway order
    expect((await payAndVerify(app, user, p.paymentId)).status).toBe('CAPTURED');
    expect((await paymentRow(app, p.paymentId)).attemptCount).toBe(2);
  });

  it('webhook endpoint: valid signature stored once; bad signature 401', async () => {
    const body = JSON.stringify({ entity: 'event', event: 'payment.authorized', payload: {} });
    const sig = mock().signWebhook(body);
    const eventId = `evt_it_${randomUUID()}`;
    const send = (signature: string) =>
      app.inject({
        method: 'POST',
        url: '/webhooks/razorpay',
        headers: {
          'content-type': 'application/json',
          'x-razorpay-signature': signature,
          'x-razorpay-event-id': eventId,
        },
        payload: body,
      });
    const first = await send(sig);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json()).toEqual({ status: 'ok', duplicate: false });
    expect((await send(sig)).json()).toEqual({ status: 'ok', duplicate: true });
    expect((await send('b'.repeat(64))).statusCode).toBe(401);
  });

  it('live status (lost webhook): a capture only the gateway knows about is applied', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    await mock().simulatePayment({
      orderId: p.providerOrderId,
      amountPaise: p.amountPaise,
      currency: 'INR',
      outcome: 'captured',
      method: 'card',
    });
    const res = await call(app, 'GET', `/internal/payments/${p.paymentId}/live-status`, {
      internal: true,
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(data<Payment & { cardLast4: string }>(res)).toMatchObject({
      status: 'CAPTURED',
      cardLast4: '4242',
    });
  });

  it('expiry: an unpaid payment EXPIRES; one captured at the gateway is captured instead', async () => {
    const user = customer();
    const unpaid = await createPayment(app, { userId: user });
    const paidLate = await createPayment(app, { userId: user });
    await mock().simulatePayment({
      orderId: paidLate.providerOrderId,
      amountPaise: paidLate.amountPaise,
      currency: 'INR',
      outcome: 'captured',
      method: 'upi',
    });
    const db = app.diContainer.resolve('db');
    await db.payment.updateMany({
      where: { id: { in: [unpaid.paymentId, paidLate.paymentId] } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await app.diContainer.resolve('paymentsService').expireDue();
    expect((await paymentRow(app, unpaid.paymentId)).status).toBe('EXPIRED');
    expect(await outboxEvents(app, 'payment.expired.v1', unpaid.paymentId)).toHaveLength(1);
    expect((await paymentRow(app, paidLate.paymentId)).status).toBe('CAPTURED');
  });

  it('order closed → open payment CANCELLED; a capture afterwards is still recorded (R5)', async () => {
    const user = customer();
    const orderId = randomUUID();
    const p = await createPayment(app, { orderId, userId: user });
    await deliver(app, 'order.cancelled.v1', {
      orderId,
      orderNo: 'ORD-26-IT',
      reservationId: null,
      scope: 'FULL',
      lines: [],
      reasonCode: 'IT',
    });
    expect((await paymentRow(app, p.paymentId)).status).toBe('CANCELLED');
    const { payment } = await mock().simulatePayment({
      orderId: p.providerOrderId,
      amountPaise: p.amountPaise,
      currency: 'INR',
      outcome: 'captured',
      method: 'upi',
    });
    await app.diContainer
      .resolve('paymentsService')
      .applyGatewayPayment(p.paymentId, payment, 'webhook');
    expect((await paymentRow(app, p.paymentId)).status).toBe('CAPTURED');
    expect(await outboxEvents(app, 'payment.captured.v1', p.paymentId)).toHaveLength(1);
  });

  it('flags a captured amount that differs from the order amount (R8)', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    const { payment } = await mock().simulatePayment({
      orderId: p.providerOrderId,
      amountPaise: p.amountPaise - 100,
      currency: 'INR',
      outcome: 'captured',
      method: 'upi',
    });
    await app.diContainer
      .resolve('paymentsService')
      .applyGatewayPayment(p.paymentId, payment, 'reconcile');
    expect((await paymentRow(app, p.paymentId)).amountMismatch).toBe(true);
    const [event] = await outboxEvents(app, 'payment.captured.v1', p.paymentId);
    expect(event?.data).toMatchObject({
      amountPaise: p.amountPaise - 100,
      expectedPaise: p.amountPaise,
    });
  });

  it('verify ∥ webhook ∥ live-status on one payment → exactly one capture event', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    const cb = data<{ providerOrderId: string; providerPaymentId: string; signature: string }>(
      await call(app, 'POST', `/payments/${p.paymentId}/mock/succeed`, { user, payload: {} }),
    );
    await Promise.all([
      call(app, 'POST', `/payments/${p.paymentId}/verify`, { user, payload: cb }),
      call(app, 'POST', `/payments/${p.paymentId}/verify`, { user, payload: cb }),
      processWebhooks(),
      call(app, 'GET', `/internal/payments/${p.paymentId}/live-status`, { internal: true }),
    ]);
    expect((await paymentRow(app, p.paymentId)).status).toBe('CAPTURED');
    expect(await outboxEvents(app, 'payment.captured.v1', p.paymentId)).toHaveLength(1);
  });

  it('admin: list, detail with attempts, reconcile (permission-gated)', async () => {
    const user = customer();
    const p = await createPayment(app, { userId: user });
    await payAndVerify(app, user, p.paymentId);
    const viewer = staff('payments.view');
    const detail = await call(app, 'GET', `/admin/payments/${p.paymentId}`, { user: viewer });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(data<{ attempts: unknown[] }>(detail).attempts).toHaveLength(1);
    expect(
      (await call(app, 'POST', `/admin/payments/${p.paymentId}/reconcile`, { user: viewer }))
        .statusCode,
    ).toBe(403);
    const recon = staff('payments.reconcile');
    expect(
      (await call(app, 'POST', `/admin/payments/${p.paymentId}/reconcile`, { user: recon }))
        .statusCode,
    ).toBe(200);
  });
});
