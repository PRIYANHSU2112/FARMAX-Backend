import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  app,
  customer,
  inventory,
  payment,
  call,
  data,
  reason,
  deliver,
  outbox,
  orderRow,
  variant,
  buyerWithCart,
  checkout,
  placed,
  captured,
  startOrdersApp,
  type OrderView,
} from './orders.harness.js';

describe.skipIf(DB_URL === undefined)('orders against Postgres (fake inventory / payment / user)', () => {
  beforeAll(async () => {
    await startOrdersApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('checkout: PENDING_ADMIN_CONFIRMATION, stock RESERVED, payment intent, cart emptied, replay = same order', async () => {
    inventory.mode = 'ok';
    const b = await buyerWithCart();
    const idem = `chk-${randomUUID()}`;
    const res = await checkout(b, idem);
    expect(res.statusCode, res.body).toBe(201);
    const { order, payment: pay } = data<{ order: OrderView; payment: { amountPaise: number } }>(res);
    expect(order).toMatchObject({
      status: 'PENDING_ADMIN_CONFIRMATION', paymentStatus: 'PENDING', stockStatus: 'RESERVED', grandTotal: '200.00',
    });
    expect(order.orderNo).toMatch(/^ORD-\d{2}-\d{7}$/);
    expect(pay.amountPaise).toBe(20_000);
    expect(order.timeline.map((t) => `${t.field}:${t.to}`)).toEqual(['STATUS:PENDING_ADMIN_CONFIRMATION', 'STOCK:RESERVED']);
    expect(order.actions.pay.allowed).toBe(true);
    expect(await outbox('order.placed.v1', order.id)).toHaveLength(1);
    const cart = data<{ lines: unknown[] }>(await call('GET', '/cart', { user: b.user }));
    expect(cart.lines).toHaveLength(0);

    const calls = inventory.calls;
    const again = await checkout(b, idem);
    expect(again.statusCode).toBe(200);
    expect(data<{ order: OrderView }>(again).order.id).toBe(order.id);
    expect(inventory.calls).toBe(calls); // already reserved: no second reserve
    const reused = await call('POST', '/orders/checkout', {
      user: b.user, idem, payload: { farmId: b.farmId, addressId: b.addressId, cartVersion: 999, billToGst: false },
    });
    expect(reused.statusCode).toBe(422);
  });

  it('two checkouts of the same cart (different keys): exactly one order', async () => {
    inventory.mode = 'ok';
    const b = await buyerWithCart();
    const [x, y] = await Promise.all([checkout(b), checkout(b)]);
    expect([x.statusCode, y.statusCode].sort()).toEqual([201, 409]);
    expect(reason(x.statusCode === 409 ? x : y)?.reason).toBe('CART_CHANGED');
  });

  it('R1: no stock → 409 + order FAILED (STOCK_UNAVAILABLE), no payment details, cart kept', async () => {
    inventory.mode = 'refuse';
    const b = await buyerWithCart();
    const res = await checkout(b);
    expect(res.statusCode).toBe(409);
    const det = reason(res);
    expect(det?.reason).toBe('INSUFFICIENT_STOCK');
    const row = await orderRow(det?.orderId ?? '');
    expect(row).toMatchObject({ status: 'FAILED', failureCode: 'STOCK_UNAVAILABLE', stockStatus: 'FAILED' });
    expect(await outbox('order.failed.v1', row.id)).toHaveLength(1);
    const cart = data<{ lines: unknown[] }>(await call('GET', '/cart', { user: b.user }));
    expect(cart.lines).toHaveLength(1);
    inventory.mode = 'ok';
  });

  it('R2: inventory down → 503, stock PENDING; the same key later completes the order', async () => {
    inventory.mode = 'down';
    const b = await buyerWithCart();
    const idem = `chk-${randomUUID()}`;
    const first = await checkout(b, idem);
    expect(first.statusCode).toBe(503);
    inventory.mode = 'ok';
    const retry = await checkout(b, idem);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(data<{ order: OrderView }>(retry).order.stockStatus).toBe('RESERVED');
  });

  it('stuck-orders job resumes a placement whose reservation outcome was unknown', async () => {
    inventory.mode = 'down';
    const b = await buyerWithCart();
    const res = await checkout(b);
    expect(res.statusCode).toBe(503);
    inventory.mode = 'ok';
    const db = app.diContainer.resolve('db');
    const row = await db.order.findFirstOrThrow({ where: { userId: b.user } });
    await db.order.update({ where: { id: row.id }, data: { placedAt: new Date(Date.now() - 5 * 60_000) } });
    await app.diContainer.resolve('ordersService').resumeStuck();
    expect((await orderRow(row.id)).stockStatus).toBe('RESERVED');
  });

  it('payment captured → PAID + order.paid once; stock committed → COMMITTED', async () => {
    const o = await placed();
    await captured(o);
    await captured(o); // duplicate delivery
    expect(await orderRow(o.order.id)).toMatchObject({ paymentStatus: 'PAID', paymentException: null });
    expect(await outbox('order.paid.v1', o.order.id)).toHaveLength(1);
    await deliver('inventory.reservation_committed.v1', { reservationId: randomUUID(), orderRef: o.order.id, recovered: false });
    expect((await orderRow(o.order.id)).stockStatus).toBe('COMMITTED');
  });

  it('R8: captured amount ≠ total → PAID with AMOUNT_MISMATCH', async () => {
    const o = await placed();
    await captured(o, 19_900);
    expect((await orderRow(o.order.id)).paymentException).toBe('AMOUNT_MISMATCH');
  });

  it('failed attempt → payment FAILED; "pay now" returns the same payment', async () => {
    const o = await placed();
    await deliver('payment.failed.v1', { paymentId: o.payment.paymentId, orderId: o.order.id, errorCode: 'X', errorReason: 'declined' });
    expect((await orderRow(o.order.id)).paymentStatus).toBe('FAILED');
    const pay = await call('POST', `/orders/${o.order.id}/pay`, { user: o.user });
    expect(pay.statusCode, pay.body).toBe(200);
    expect(data<{ payment: { paymentId: string } }>(pay).payment.paymentId).toBe(o.payment.paymentId);
    expect((await call('POST', `/orders/${o.order.id}/pay`, { user: customer() })).statusCode).toBe(404);
  });

  it('D-43: unpaid past window + grace → FAILED (PAYMENT_NOT_COMPLETED) after a live check; release requested', async () => {
    const o = await placed();
    const db = app.diContainer.resolve('db');
    await db.order.update({ where: { id: o.order.id }, data: { paymentDueAt: new Date(Date.now() - 10 * 60_000) } });
    payment.live = 'CAPTURED';
    await app.diContainer.resolve('ordersService').failUnpaidDue();
    expect((await orderRow(o.order.id)).status).toBe('PENDING_ADMIN_CONFIRMATION'); // paid at the gateway: wait
    payment.live = 'PENDING';
    await app.diContainer.resolve('ordersService').failUnpaidDue();
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'FAILED', failureCode: 'PAYMENT_NOT_COMPLETED', paymentStatus: 'EXPIRED', stockStatus: 'RELEASE_REQUESTED',
    });
    expect(await outbox('order.failed.v1', o.order.id)).toHaveLength(1);
    await deliver('inventory.reservation_released.v1', { reservationId: randomUUID(), orderRef: o.order.id, scope: 'FULL', lines: [] });
    expect((await orderRow(o.order.id)).stockStatus).toBe('RELEASED');

    // R5: the money arrives after all → recorded, order NOT revived, automatic refund.
    await captured(o);
    expect(await orderRow(o.order.id)).toMatchObject({ status: 'FAILED', paymentStatus: 'PAID', refundStatus: 'REQUESTED' });
    const [req] = await outbox('order.refund_requested.v1', o.order.id);
    expect(req?.data).toMatchObject({ amountPaise: 20_000, isSystem: true });
    expect(await outbox('order.paid.v1', o.order.id)).toHaveLength(0);

    // Refund lifecycle A follows B: initiated → processed.
    const sourceRef = (req?.data as { sourceRef: string }).sourceRef;
    await deliver('payment.refund_initiated.v1', {
      refundId: randomUUID(), sourceRef, paymentId: o.payment.paymentId, orderId: o.order.id, amountPaise: 20_000,
      providerRefundId: 'rfnd_it', expectedBy: new Date().toISOString(),
    });
    expect((await orderRow(o.order.id)).refundStatus).toBe('IN_PROGRESS');
    await deliver('payment.refund_processed.v1', {
      refundId: randomUUID(), sourceRef, paymentId: o.payment.paymentId, orderId: o.order.id, amountPaise: 20_000,
      arn: 'ARN1', refundedPaise: 20_000, capturedPaise: 20_000,
    });
    expect(await orderRow(o.order.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'COMPLETED' });
  });

  it('R4: paid, then stock rejected (late recovery failed) → FAILED + full refund; refund failure → ACTION_REQUIRED', async () => {
    const o = await placed();
    await captured(o);
    await deliver('inventory.reservation_rejected.v1', {
      reservationId: randomUUID(), orderRef: o.order.id, shortfall: [{ variantId: variant, requested: 2, available: 0 }],
    });
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'FAILED', failureCode: 'STOCK_UNAVAILABLE_AFTER_PAYMENT', stockStatus: 'REJECTED', refundStatus: 'REQUESTED',
    });
    const [req] = await outbox('order.refund_requested.v1', o.order.id);
    await deliver('payment.refund_failed.v1', {
      refundId: randomUUID(), sourceRef: (req?.data as { sourceRef: string }).sourceRef, paymentId: o.payment.paymentId,
      orderId: o.order.id, amountPaise: 20_000, reason: 'Bank refused',
    });
    expect((await orderRow(o.order.id)).refundStatus).toBe('ACTION_REQUIRED');
  });

  it('a commit arriving after the order closed asks inventory to release again', async () => {
    const o = await placed();
    const db = app.diContainer.resolve('db');
    await db.order.update({ where: { id: o.order.id }, data: { paymentDueAt: new Date(Date.now() - 10 * 60_000) } });
    payment.live = 'PENDING';
    await app.diContainer.resolve('ordersService').failUnpaidDue();
    await deliver('inventory.reservation_committed.v1', { reservationId: randomUUID(), orderRef: o.order.id, recovered: true });
    expect(await outbox('order.failed.v1', o.order.id)).toHaveLength(2);
  });

  it('timeout job ∥ capture on one order → one consistent outcome', async () => {
    const o = await placed();
    const db = app.diContainer.resolve('db');
    await db.order.update({ where: { id: o.order.id }, data: { paymentDueAt: new Date(Date.now() - 10 * 60_000) } });
    payment.live = 'PENDING';
    await Promise.all([app.diContainer.resolve('ordersService').failUnpaidDue(), captured(o)]);
    const row = await orderRow(o.order.id);
    if (row.status === 'FAILED') {
      // job first → late capture → refund
      expect(row.paymentStatus).toBe('PAID');
      expect(await outbox('order.refund_requested.v1', o.order.id)).toHaveLength(1);
    } else {
      expect(row).toMatchObject({ status: 'PENDING_ADMIN_CONFIRMATION', paymentStatus: 'PAID' });
      expect(await outbox('order.refund_requested.v1', o.order.id)).toHaveLength(0);
    }
  });

  it('lists my orders by tab; another buyer gets 404; internal status needs the token', async () => {
    const o = await placed();
    const active = data<OrderView[]>(await call('GET', '/orders?tab=active', { user: o.user }));
    expect(active.map((x) => x.id)).toContain(o.order.id);
    expect((await call('GET', `/orders/${o.order.id}`, { user: customer() })).statusCode).toBe(404);
    expect((await call('GET', `/internal/orders/status?ids=${o.order.id}`)).statusCode).toBe(401);
    const st = await call('GET', `/internal/orders/status?ids=${o.order.id}`, { internal: true });
    expect(data<{ id: string; status: string }[]>(st)).toEqual([{ id: o.order.id, status: 'PENDING_ADMIN_CONFIRMATION' }]);
  });
});
