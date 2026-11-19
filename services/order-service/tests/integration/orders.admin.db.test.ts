import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  type OrderView,
  app,
  call,
  captured,
  customer,
  data,
  deliver,
  orderRow,
  outbox,
  placed,
  reason,
  staff,
  startOrdersApp,
  variant,
} from './orders.harness.js';

const reviewer = staff('orders.view', 'orders.confirm', 'orders.cancel', 'orders.update', 'refunds.initiate', 'refunds.approve');
const reviewer2 = staff('orders.view', 'orders.confirm', 'refunds.approve');
const viewer = staff('orders.view');
const configurer = staff('orders.view', 'orders.configure');

type Placed = Awaited<ReturnType<typeof placed>>;

/** Placed, paid and stock committed: ready for review. */
const ready = async (): Promise<Placed> => {
  const o = await placed();
  await captured(o);
  await deliver('inventory.reservation_committed.v1', { reservationId: randomUUID(), orderRef: o.order.id, recovered: false });
  return o;
};

const version = async (id: string) => (await orderRow(id)).version;
const adminPost = (url: string, user: string, payload: object) => call('POST', `/admin/orders${url}`, { user, payload });

describe.skipIf(DB_URL === undefined)('admin review, cancellation and recovery (P4)', () => {
  beforeAll(async () => {
    await startOrdersApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('confirm: queue → stale version 409 → CONFIRMED + order.confirmed; viewer 403; twice → 409', async () => {
    const o = await ready();
    const queue = data<{ id: string; waitingMinutes: number }[]>(await call('GET', '/admin/orders/review-queue', { user: viewer }));
    expect(queue.map((q) => q.id)).toContain(o.order.id);
    expect((await adminPost(`/${o.order.id}/confirm`, viewer, { expectedVersion: 0 })).statusCode).toBe(403);
    const stale = await adminPost(`/${o.order.id}/confirm`, reviewer, { expectedVersion: 0 });
    expect(stale.statusCode).toBe(409);
    expect(reason(stale)?.reason).toBe('VERSION_CONFLICT');
    const ok = await adminPost(`/${o.order.id}/confirm`, reviewer, { expectedVersion: await version(o.order.id), note: 'IT checked' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<OrderView>(ok).status).toBe('CONFIRMED');
    const [ev] = await outbox('order.confirmed.v1', o.order.id);
    expect(ev?.data).toMatchObject({ lines: [{ lineNo: 1, variantId: variant, qty: 2 }] });
    const again = await adminPost(`/${o.order.id}/confirm`, reviewer, { expectedVersion: await version(o.order.id) });
    expect(reason(again)?.reason).toBe('NOT_PENDING');
  });

  it('confirm is blocked when unpaid or the captured amount mismatched', async () => {
    const unpaid = await placed();
    const r1 = await adminPost(`/${unpaid.order.id}/confirm`, reviewer, { expectedVersion: await version(unpaid.order.id) });
    expect(reason(r1)?.reason).toBe('NOT_PAID');
    const odd = await placed();
    await captured(odd, 19_900);
    await deliver('inventory.reservation_committed.v1', { reservationId: randomUUID(), orderRef: odd.order.id, recovered: false });
    const r2 = await adminPost(`/${odd.order.id}/confirm`, reviewer, { expectedVersion: await version(odd.order.id) });
    expect(reason(r2)?.reason).toBe('PAYMENT_EXCEPTION');
    const ex = data<{ id: string }[]>(await call('GET', '/admin/orders/exceptions?type=amount_mismatch', { user: viewer }));
    expect(ex.map((x) => x.id)).toContain(odd.order.id);
  });

  it('two admins confirming at once: one 200, one 409', async () => {
    const o = await ready();
    const v = await version(o.order.id);
    const [a, b] = await Promise.all([
      adminPost(`/${o.order.id}/confirm`, reviewer, { expectedVersion: v }),
      adminPost(`/${o.order.id}/confirm`, reviewer2, { expectedVersion: v }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    expect(await outbox('order.confirmed.v1', o.order.id)).toHaveLength(1);
  });

  it('reject: REJECTED, release requested, full automatic refund, audited reason', async () => {
    const o = await ready();
    const res = await adminPost(`/${o.order.id}/reject`, reviewer, {
      expectedVersion: await version(o.order.id),
      reasonCode: 'OUT_OF_STOCK_PHYSICAL',
      reason: 'IT cold room failure at the depot',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'REJECTED', stockStatus: 'RELEASE_REQUESTED', refundStatus: 'REQUESTED', closeReasonCode: 'OUT_OF_STOCK_PHYSICAL',
    });
    expect(await outbox('order.rejected.v1', o.order.id)).toHaveLength(1);
    const [req] = await outbox('order.refund_requested.v1', o.order.id);
    expect(req?.data).toMatchObject({ amountPaise: 20_000, isSystem: true, sourceRef: `reject:${o.order.id}` });
  });

  it('bulk confirm: each order on its own; mixed results', async () => {
    const good = await ready();
    const unpaid = await placed();
    const res = await adminPost('/bulk-confirm', reviewer, { orderIds: [good.order.id, unpaid.order.id, randomUUID()] });
    expect(res.statusCode, res.body).toBe(200);
    const out = data<{ confirmed: number; results: { orderId: string; ok: boolean; reason: string | null }[] }>(res);
    expect(out.confirmed).toBe(1);
    expect(out.results.map((r) => r.reason)).toEqual([null, 'NOT_PAID', 'NOT_FOUND']);
  });

  it('buyer: unpaid order only as a whole → CANCELLED, no refund, stock released', async () => {
    const o = await placed();
    const partial = await call('POST', `/orders/${o.order.id}/cancel`, {
      user: o.user, idem: `cx-${randomUUID()}`, payload: { lines: [{ variantId: variant, qty: 1 }], reasonCode: 'FLOCK_DELAYED' },
    });
    expect(partial.statusCode).toBe(422);
    const res = await call('POST', `/orders/${o.order.id}/cancel`, {
      user: o.user, idem: `cx-${randomUUID()}`, payload: { reasonCode: 'ORDERED_BY_MISTAKE' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(await orderRow(o.order.id)).toMatchObject({ status: 'CANCELLED', stockStatus: 'RELEASE_REQUESTED', refundStatus: 'NONE' });
    const [ev] = await outbox('order.cancelled.v1', o.order.id);
    expect(ev?.data).toMatchObject({ scope: 'FULL' });
  });

  it('buyer: partial cancel of a paid order refunds exactly the cancelled units; replay is a no-op', async () => {
    const o = await ready();
    const quote = await call('POST', `/orders/${o.order.id}/cancellation-quote`, {
      user: o.user, payload: { lines: [{ variantId: variant, qty: 1 }] },
    });
    expect(data(quote)).toMatchObject({ eligible: true, full: false, fee: '0.00', refundAmount: '100.00' });
    const idem = `cx-${randomUUID()}`;
    const body = { lines: [{ variantId: variant, qty: 1 }], reasonCode: 'FLOCK_DELAYED' };
    const res = await call('POST', `/orders/${o.order.id}/cancel`, { user: o.user, idem, payload: body });
    expect(res.statusCode, res.body).toBe(200);
    const again = await call('POST', `/orders/${o.order.id}/cancel`, { user: o.user, idem, payload: body });
    expect(again.statusCode).toBe(200);
    expect(await orderRow(o.order.id)).toMatchObject({ status: 'PENDING_ADMIN_CONFIRMATION' });
    const [ev] = await outbox('order.cancelled.v1', o.order.id);
    expect(ev?.data).toMatchObject({ scope: 'PARTIAL', lines: [{ variantId: variant, qty: 1 }] });
    const refunds = await outbox('order.refund_requested.v1', o.order.id);
    expect(refunds).toHaveLength(1);
    expect(refunds[0]?.data).toMatchObject({ amountPaise: 10_000, isSystem: true });
    expect((await call('POST', `/orders/${o.order.id}/cancel`, { user: customer(), idem: `cx-${randomUUID()}`, payload: body })).statusCode).toBe(404);
  });

  it('fee after the free window (settings via admin, orders.configure only)', async () => {
    const denied = await call('PATCH', '/admin/orders/settings', { user: viewer, payload: { freeCancelMinutes: 0, reason: 'IT no free window' } });
    expect(denied.statusCode).toBe(403);
    const patch = (payload: object) => call('PATCH', '/admin/orders/settings', { user: configurer, payload });
    expect((await patch({ freeCancelMinutes: 0, cancellationFeePercent: 10, reason: 'IT fee test window' })).statusCode).toBe(200);
    try {
      const o = await ready();
      const res = await call('POST', `/orders/${o.order.id}/cancel`, { user: o.user, idem: `cx-${randomUUID()}`, payload: { reasonCode: 'LOWER_PRICE' } });
      expect(res.statusCode, res.body).toBe(200);
      const [req] = await outbox('order.refund_requested.v1', o.order.id);
      expect(req?.data).toMatchObject({ amountPaise: 18_000 }); // ₹200 − 10 %
    } finally {
      await patch({ freeCancelMinutes: 60, cancellationFeePercent: 0, reason: 'IT reset cancellation policy' });
    }
  });

  it('staff cancel (whole): needs reason + version; refund is a staff decision (may need approval)', async () => {
    const o = await ready();
    const res = await adminPost(`/${o.order.id}/cancel`, reviewer, {
      expectedVersion: await version(o.order.id), reasonCode: 'CUSTOMER_REQUEST', note: 'IT farmer called to cancel',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await orderRow(o.order.id)).status).toBe('CANCELLED');
    const [req] = await outbox('order.refund_requested.v1', o.order.id);
    expect(req?.data).toMatchObject({ amountPaise: 20_000, isSystem: false, requestedBy: reviewer });
  });

  it('refund recovery: failed → retry (same decision re-sent) → failed → offline resolve with SoD', async () => {
    const o = await ready();
    await adminPost(`/${o.order.id}/cancel`, reviewer, {
      expectedVersion: await version(o.order.id), reasonCode: 'CUSTOMER_REQUEST', note: 'IT cancel for refund test',
    });
    const [req] = await outbox('order.refund_requested.v1', o.order.id);
    const sourceRef = (req?.data as { sourceRef: string }).sourceRef;
    const fail = () =>
      deliver('payment.refund_failed.v1', {
        refundId: randomUUID(), sourceRef, paymentId: o.payment.paymentId, orderId: o.order.id, amountPaise: 20_000, reason: 'IT bank refused',
      });
    await fail();
    expect((await orderRow(o.order.id)).refundStatus).toBe('ACTION_REQUIRED');
    const detail = data<{ refunds: { id: string; status: string }[] }>(await call('GET', `/admin/orders/${o.order.id}`, { user: viewer }));
    const rid = detail.refunds[0]?.id ?? '';
    const retry = await adminPost(`/${o.order.id}/refunds/${rid}/retry`, reviewer, { reason: 'IT bank issue resolved' });
    expect(retry.statusCode, retry.body).toBe(200);
    expect(await outbox('order.refund_requested.v1', o.order.id)).toHaveLength(2);
    expect((await orderRow(o.order.id)).refundStatus).toBe('IN_PROGRESS');

    await fail();
    const self = await adminPost(`/${o.order.id}/refunds/${rid}/resolve-offline`, reviewer, { reason: 'IT paid by NEFT', bankReference: 'NEFT-IT-1' });
    expect(self.statusCode).toBe(403);
    const ok = await adminPost(`/${o.order.id}/refunds/${rid}/resolve-offline`, reviewer2, { reason: 'IT paid by NEFT', bankReference: 'NEFT-IT-1' });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await orderRow(o.order.id)).toMatchObject({ paymentStatus: 'REFUNDED', refundStatus: 'COMPLETED' });
  });

  it('review SLA: alert once; auto-reject after the limit with a full refund', async () => {
    const slow = await ready();
    const stale = await ready();
    const db = app.diContainer.resolve('db');
    await db.order.update({ where: { id: slow.order.id }, data: { paidAt: new Date(Date.now() - 5 * 3_600_000) } });
    await db.order.update({ where: { id: stale.order.id }, data: { paidAt: new Date(Date.now() - 49 * 3_600_000) } });
    const svc = app.diContainer.resolve('ordersAdminService');
    await svc.reviewSla();
    await svc.reviewSla();
    expect(await outbox('order.review_overdue.v1', slow.order.id)).toHaveLength(1);
    expect((await orderRow(slow.order.id)).status).toBe('PENDING_ADMIN_CONFIRMATION');
    expect(await orderRow(stale.order.id)).toMatchObject({ status: 'REJECTED', closeReasonCode: 'REVIEW_TIMEOUT' });
    const [req] = await outbox('order.refund_requested.v1', stale.order.id);
    expect(req?.data).toMatchObject({ amountPaise: 20_000, isSystem: true });
  });

  it('recovery-watch re-sends a release and a refund decision that did not land', async () => {
    const o = await ready();
    await adminPost(`/${o.order.id}/reject`, reviewer, {
      expectedVersion: await version(o.order.id), reasonCode: 'OTHER', reason: 'IT reject for recovery-watch',
    });
    const db = app.diContainer.resolve('db');
    const old = new Date(Date.now() - 30 * 60_000);
    await db.$executeRaw`UPDATE "orders" SET "updatedAt" = ${old} WHERE "id" = ${o.order.id}::uuid`;
    await db.$executeRaw`UPDATE "order_refund_requests" SET "updatedAt" = ${old} WHERE "orderId" = ${o.order.id}::uuid`;
    await app.diContainer.resolve('ordersAdminService').recoveryWatch();
    expect(await outbox('order.rejected.v1', o.order.id)).toHaveLength(2);
    expect(await outbox('order.refund_requested.v1', o.order.id)).toHaveLength(2);
    const ex = data<{ id: string }[]>(await call('GET', '/admin/orders/exceptions?type=stock_release_pending', { user: viewer }));
    expect(Array.isArray(ex)).toBe(true);
  });

  it('notes, search, stats and staff detail history', async () => {
    const o = await ready();
    const n = await adminPost(`/${o.order.id}/notes`, reviewer, { body: 'IT called the farmer' });
    expect(n.statusCode, n.body).toBe(201);
    expect((await adminPost(`/${o.order.id}/notes`, viewer, { body: 'IT not allowed' })).statusCode).toBe(403);
    const detail = data<{ notes: unknown[]; history: { actorType: string }[]; version: number }>(
      await call('GET', `/admin/orders/${o.order.id}`, { user: viewer }),
    );
    expect(detail.notes).toHaveLength(1);
    expect(detail.history.length).toBeGreaterThan(2);
    const found = data<{ id: string }[]>(await call('GET', `/admin/orders?userId=${o.user}`, { user: viewer }));
    expect(found.map((f) => f.id)).toEqual([o.order.id]);
    const stats = data<{ awaitingReview: number }>(await call('GET', '/admin/orders/stats', { user: viewer }));
    expect(stats.awaitingReview).toBeGreaterThan(0);
    expect((await call('GET', '/admin/orders/stats', { user: customer() })).statusCode).toBe(403);
  });
});
