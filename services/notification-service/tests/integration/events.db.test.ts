import { randomUUID } from 'node:crypto';

import { RabbitPublisher } from '@farmx/infra/rabbitmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  RABBITMQ_URL,
  type TestApp,
  buildTestApp,
  byDedupeKey,
  deliver,
  envelope,
  notificationsOf,
  placeOrder,
} from './harness.js';

describe.skipIf(DB_URL === undefined)('event consumption against Postgres', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('order.placed → in-app row + PUSH delivery for the buyer; redelivery and resends are no-ops', async () => {
    const order = await placeOrder(t.app);
    const [n, ...rest] = await notificationsOf(t.app, order.orderId);
    expect(rest).toHaveLength(0);
    expect(n).toMatchObject({
      status: 'SENT',
      app: 'CUSTOMER',
      category: 'ORDER',
      templateKey: 'order.placed',
      title: `Order ${order.orderNo} placed`,
      recipientCount: 1,
      channels: ['PUSH'],
    });
    expect(n?.body).toContain('₹27,821.00');
    expect(n?.recipients.map((r) => r.userId)).toEqual([order.userId]);
    expect(n?.deliveries.map((d) => [d.channel, d.status])).toEqual([['PUSH', 'PENDING']]);

    // Same event id → inbox duplicate; a resend with a NEW id → dedupe key, still one notification.
    const event = envelope('order.review_overdue.v1', {
      orderId: order.orderId,
      orderNo: order.orderNo,
      waitingMinutes: 40,
    });
    expect(await deliver(t.app, event)).toBe('processed');
    expect(await deliver(t.app, event)).toBe('duplicate');
    expect(await deliver(t.app, { ...event, id: randomUUID() })).toBe('processed');
    const overdue = (await notificationsOf(t.app, order.orderId)).filter(
      (x) => x.templateKey === 'order.review_overdue',
    );
    expect(overdue).toHaveLength(1);
    // Finish the staff fan-out (no holders) so no PROCESSING row is left for the sweep.
    t.directory.holders = [];
    await t.app.diContainer.resolve('notificationsService').fanout(overdue[0]?.id ?? '');
    expect((await byDedupeKey(t.app, overdue[0]?.dedupeKey ?? ''))?.status).toBe('SENT');
  });

  it('a payment event before order.placed fails (retried, then DLQ); after it, buyer gets PUSH + EMAIL', async () => {
    const userId = randomUUID();
    const orderId = randomUUID();
    const captured = envelope('payment.captured.v1', {
      paymentId: randomUUID(),
      orderId,
      orderNo: 'ORD-LATE',
      amountPaise: 150_050,
      currency: 'INR',
      expectedPaise: 150_050,
      method: 'upi',
      providerPaymentId: 'pay_x',
    });
    await expect(deliver(t.app, captured)).rejects.toThrow(/order projection missing/);
    // The failed attempt rolled back its inbox claim, so the redelivery is processed.
    await deliver(
      t.app,
      envelope('order.placed.v1', {
        orderId,
        orderNo: 'ORD-LATE',
        userId,
        farmId: randomUUID(),
        grandTotal: '1500.50',
        paymentDueAt: new Date().toISOString(),
      }),
    );
    expect(await deliver(t.app, captured)).toBe('processed');
    const paid = (await notificationsOf(t.app, orderId)).find((x) => x.category === 'PAYMENT');
    expect(paid?.body).toBe(
      'We received ₹1,500.50 for order ORD-LATE. Our team will confirm your order shortly.',
    );
    expect(paid?.deliveries.map((d) => d.channel)).toEqual(['PUSH', 'EMAIL']);
    expect(paid?.deliveries.every((d) => d.userId === userId)).toBe(true);
    expect(paid?.content).toMatchObject({
      EMAIL: { subject: 'Payment received for order ORD-LATE' },
    });
  });

  it('respects preferences (EMAIL off for ORDER) and sends SMS only for HIGH', async () => {
    const order = await placeOrder(t.app);
    await t.app.diContainer.resolve('db').notificationPreference.create({
      data: { userId: order.userId, category: 'ORDER', channel: 'EMAIL', enabled: false },
    });
    const release = {
      orderId: order.orderId,
      orderNo: order.orderNo,
      reservationId: null,
      scope: 'FULL',
      lines: [],
    };
    await deliver(
      t.app,
      envelope('order.rejected.v1', { ...release, reasonCode: 'STOCK_REJECTED' }),
    );
    await deliver(
      t.app,
      envelope('order.confirmed.v1', { ...release, confirmedAt: new Date().toISOString() }),
    );
    const all = await notificationsOf(t.app, order.orderId);
    const channels = (key: string) =>
      all.find((x) => x.templateKey === key)?.deliveries.map((d) => d.channel);
    expect(channels('order.rejected')).toEqual(['PUSH', 'SMS']);
    expect(channels('order.confirmed')).toEqual(['PUSH']);
  });

  it('staff audiences fan out off the consumer path: resumable, idempotent, safe in parallel', async () => {
    const staff = [randomUUID(), randomUUID(), randomUUID()].sort();
    t.directory.holders = staff;
    const event = envelope('inventory.low_stock.v1', {
      variantId: randomUUID(),
      warehouseId: randomUUID(),
      availableQty: 3,
      threshold: 10,
    });
    await deliver(t.app, event);
    const key = `inventory.low_stock:${event.id}`;
    const pending = await byDedupeKey(t.app, key);
    expect(pending).toMatchObject({
      status: 'PROCESSING',
      audienceType: 'PERMISSION',
      recipientCount: 0,
    });
    expect(t.fanoutsQueued).toContain(pending?.id);

    // auth-service down → the job fails (BullMQ retries), nothing is lost or half-written.
    const notifications = t.app.diContainer.resolve('notificationsService');
    t.directory.failNext = 1;
    await expect(notifications.fanout(pending?.id ?? '')).rejects.toThrow(/auth-service down/);
    expect((await byDedupeKey(t.app, key))?.status).toBe('PROCESSING');

    await Promise.all([
      notifications.fanout(pending?.id ?? ''),
      notifications.fanout(pending?.id ?? ''),
    ]);
    await notifications.fanout(pending?.id ?? '');
    const done = await byDedupeKey(t.app, key);
    expect(done).toMatchObject({ status: 'SENT', recipientCount: 3, app: 'WAREHOUSE' });
    expect(done?.recipients.map((r) => r.userId)).toEqual(staff);
    expect(done?.deliveries.map((d) => d.channel)).toEqual(['PUSH', 'PUSH', 'PUSH']);
  });

  it('APP audiences page through the directory and resume after a failure', async () => {
    const ids = [randomUUID(), randomUUID(), randomUUID()].sort();
    t.directory.pages = new Map([
      ['', { ids: ids.slice(0, 2), nextCursor: ids[1] ?? null }],
      [ids[1] ?? '', { ids: ids.slice(2), nextCursor: null }],
    ]);
    const key = `it-app:${randomUUID()}`;
    const { notificationsService, runInTransaction } = t.app.diContainer.cradle;
    const accepted = await runInTransaction((tx) =>
      notificationsService.accept(tx, {
        dedupeKey: key,
        category: 'SYSTEM',
        priority: 'NORMAL',
        app: 'CUSTOMER',
        audience: { kind: 'app' },
        channels: ['PUSH'],
        templateKey: 'admin.message',
        vars: { title: 'Maintenance', body: 'The app is down 2–3 am tonight.' },
        source: 'admin',
      }),
    );
    expect(accepted?.status).toBe('PROCESSING');
    let calls = 0;
    const directory = t.app.diContainer.resolve('authDirectory') as unknown as {
      listActiveIds: (type: string, cursor: string | null) => Promise<unknown>;
    };
    const original = directory.listActiveIds;
    directory.listActiveIds = (type, cursor) => {
      calls += 1;
      if (calls === 2) return Promise.reject(new Error('auth-service down'));
      return original(type, cursor);
    };
    await expect(notificationsService.fanout(accepted?.notificationId ?? '')).rejects.toThrow();
    const half = await byDedupeKey(t.app, key);
    expect(half).toMatchObject({ status: 'PROCESSING', recipientCount: 2, fanoutCursor: ids[1] });
    await notificationsService.fanout(accepted?.notificationId ?? '');
    const done = await byDedupeKey(t.app, key);
    expect(done).toMatchObject({ status: 'SENT', recipientCount: 3 });
    expect(done?.recipients.map((r) => r.userId)).toEqual(ids);
    directory.listActiveIds = original;
  });

  it('a template variable error is rejected (no partial rows)', async () => {
    const { notificationsService, runInTransaction } = t.app.diContainer.cradle;
    const key = `it-bad:${randomUUID()}`;
    await expect(
      runInTransaction((tx) =>
        notificationsService.accept(tx, {
          dedupeKey: key,
          category: 'SYSTEM',
          priority: 'NORMAL',
          app: 'CUSTOMER',
          audience: { kind: 'users', userIds: [randomUUID()] },
          channels: [],
          templateKey: 'admin.message',
          vars: { title: 'x' },
          source: 'admin',
        }),
      ),
    ).rejects.toMatchObject({ statusCode: 422 });
    expect(await byDedupeKey(t.app, key)).toBeNull();
  });
});

describe.skipIf(DB_URL === undefined)('real RabbitMQ round trip', () => {
  it('a published order.placed reaches the inbox through the durable queue', async () => {
    const t = await buildTestApp();
    const runtime = t.app.diContainer.resolve('eventsRuntime');
    const publisher = new RabbitPublisher(RABBITMQ_URL, t.app.diContainer.resolve('logger'));
    try {
      runtime.start();
      const order = { orderId: randomUUID(), orderNo: 'ORD-AMQP', userId: randomUUID() };
      const event = envelope('order.placed.v1', {
        ...order,
        farmId: randomUUID(),
        grandTotal: '10.00',
        paymentDueAt: new Date().toISOString(),
      });
      // start() binds the queue asynchronously: until it exists the exchange drops the message,
      // so re-publish the SAME envelope (the inbox makes repeats no-ops) until it lands.
      let found = 0;
      for (let i = 0; i < 40 && found === 0; i += 1) {
        if (i % 5 === 0) await publisher.publish(event);
        await new Promise((r) => setTimeout(r, 200));
        found = (await notificationsOf(t.app, order.orderId)).length;
      }
      expect(found).toBe(1);
    } finally {
      await publisher.close();
      await t.app.close();
    }
  }, 20_000);
});
