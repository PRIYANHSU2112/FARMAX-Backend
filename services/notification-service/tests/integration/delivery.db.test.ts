import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  type TestApp,
  buildTestApp,
  byDedupeKey,
  deliver,
  envelope,
  notificationsOf,
  placeOrder,
} from './harness.js';

const ACTIVE = {
  status: 'ACTIVE',
  email: 'buyer@farm.example',
  emailVerified: true,
  phone: '+919000000001',
  phoneVerified: true,
};

describe.skipIf(DB_URL === undefined)('delivery workers against Postgres', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp({ DELIVERY_MAX_ATTEMPTS: '3' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  const cradle = () => t.app.diContainer.cradle;
  const deliveryOf = (id: string) =>
    cradle().db.notificationDelivery.findUniqueOrThrow({ where: { id } });

  /** A buyer with a device + contact and a paid order: returns the PUSH and EMAIL delivery ids. */
  const paidOrder = async (contact = ACTIVE, tokens = [`fcm-${randomUUID()}`]) => {
    const order = await placeOrder(t.app);
    t.contacts.set(order.userId, contact);
    for (const token of tokens)
      await cradle().devicesService.register(order.userId, 'CUSTOMER', {
        token,
        platform: 'ANDROID',
      });
    await deliver(
      t.app,
      envelope('payment.captured.v1', {
        paymentId: randomUUID(),
        orderId: order.orderId,
        orderNo: order.orderNo,
        amountPaise: 100_000,
        currency: 'INR',
        expectedPaise: 100_000,
        method: 'upi',
        providerPaymentId: 'pay_1',
      }),
    );
    const n = (await notificationsOf(t.app, order.orderId)).find((x) => x.category === 'PAYMENT');
    const id = (channel: string) => n?.deliveries.find((d) => d.channel === channel)?.id ?? '';
    return { order, notificationId: n?.id ?? '', push: id('PUSH'), email: id('EMAIL'), tokens };
  };

  it('enqueues one job per delivery and sends push + email (deep link in the push data)', async () => {
    const { push, email, notificationId, order, tokens } = await paidOrder();
    expect(t.deliveriesQueued.filter((j) => [push, email].includes(j.id))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: push, channel: 'PUSH', attempts: 0 }),
        expect.objectContaining({ id: email, channel: 'EMAIL', attempts: 0 }),
      ]),
    );
    const svc = cradle().deliveryService;
    expect(await svc.deliver(push)).toEqual({ status: 'sent', providerMessageId: 'fcm-msg-1' });
    expect(await svc.deliver(email)).toMatchObject({ status: 'sent' });
    const sentPush = t.providers.sent.find((s) => s.to === tokens[0]);
    expect(sentPush?.data).toMatchObject({
      notificationId,
      app: 'CUSTOMER',
      entityType: 'order',
      entityId: order.orderId,
    });
    expect(
      t.providers.sent.some((s) => s.channel === 'EMAIL' && s.title.includes(order.orderNo)),
    ).toBe(true);
    expect(await deliveryOf(push)).toMatchObject({
      status: 'SENT',
      attempts: 1,
      provider: 'fake-fcm',
      providerMessageId: 'fcm-msg-1',
      lockedAt: null,
    });
    // Already sent: a duplicate job is a no-op.
    expect(await svc.deliver(push)).toEqual({ status: 'noop' });
  });

  it('skips without a device, without a VERIFIED address, or for an inactive user', async () => {
    const svc = cradle().deliveryService;
    const a = await paidOrder({ ...ACTIVE, emailVerified: false }, []);
    expect(await svc.deliver(a.push)).toEqual({ status: 'skipped', reason: 'NO_DEVICE' });
    expect(await svc.deliver(a.email)).toEqual({ status: 'skipped', reason: 'NO_ADDRESS' });
    const b = await paidOrder({ ...ACTIVE, status: 'SUSPENDED' });
    expect(await svc.deliver(b.email)).toEqual({ status: 'skipped', reason: 'USER_INACTIVE' });
    expect((await deliveryOf(b.email)).skipReason).toBe('USER_INACTIVE');
  });

  it('transient failures retry with backoff (new delayed job per attempt), then succeed', async () => {
    const { email } = await paidOrder();
    t.providers.failNext.push({ channel: 'EMAIL', retryable: true, code: 'SMTP_421' });
    const svc = cradle().deliveryService;
    const first = await svc.deliver(email);
    expect(first).toMatchObject({ status: 'retrying', error: 'SMTP_421: fake' });
    const row = await deliveryOf(email);
    expect(row).toMatchObject({ status: 'RETRYING', attempts: 1, lastError: 'SMTP_421: fake' });
    expect(row.nextAttemptAt?.getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(t.deliveriesQueued.at(-1)).toMatchObject({ id: email, attempts: 1 });
    expect(await svc.deliver(email)).toMatchObject({ status: 'sent' });
    expect(await deliveryOf(email)).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('attempts exhausted → FAILED (the delivery DLQ); permanent errors fail at once', async () => {
    const svc = cradle().deliveryService;
    const a = await paidOrder();
    for (let i = 0; i < 3; i += 1)
      t.providers.failNext.push({ channel: 'EMAIL', retryable: true, code: 'ETIMEDOUT' });
    expect((await svc.deliver(a.email)).status).toBe('retrying');
    expect((await svc.deliver(a.email)).status).toBe('retrying');
    expect(await svc.deliver(a.email)).toEqual({
      status: 'failed',
      error: 'attempts exhausted: ETIMEDOUT: fake',
    });
    expect(await deliveryOf(a.email)).toMatchObject({ status: 'FAILED', attempts: 3 });

    const b = await paidOrder();
    t.providers.failNext.push({ channel: 'EMAIL', retryable: false, code: 'SMTP_550' });
    expect(await svc.deliver(b.email)).toEqual({ status: 'failed', error: 'SMTP_550: fake' });
    expect((await deliveryOf(b.email)).attempts).toBe(1);
  });

  it('revokes tokens FCM reports dead; all dead → NO_DEVICE', async () => {
    const svc = cradle().deliveryService;
    const live = `fcm-live-${randomUUID()}`;
    const dead = `fcm-dead-${randomUUID()}`;
    t.providers.deadTokens.add(dead);
    const a = await paidOrder(ACTIVE, [live, dead]);
    expect((await svc.deliver(a.push)).status).toBe('sent');
    const tokens = await cradle().db.deviceToken.findMany({
      where: { userId: a.order.userId },
      select: { token: true, revokedAt: true },
    });
    expect(tokens.find((x) => x.token === dead)?.revokedAt).not.toBeNull();
    expect(tokens.find((x) => x.token === live)?.revokedAt).toBeNull();

    const onlyDead = `fcm-dead-${randomUUID()}`;
    t.providers.deadTokens.add(onlyDead);
    const b = await paidOrder(ACTIVE, [onlyDead]);
    expect(await svc.deliver(b.push)).toEqual({ status: 'skipped', reason: 'NO_DEVICE' });
  });

  it('two workers on one delivery send once', async () => {
    const { push } = await paidOrder();
    const before = t.providers.sent.length;
    const svc = cradle().deliveryService;
    const outcomes = await Promise.all([svc.deliver(push), svc.deliver(push), svc.deliver(push)]);
    expect(outcomes.filter((o) => o.status === 'sent')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'noop')).toHaveLength(2);
    expect(t.providers.sent.length - before).toBe(1);
  });

  it('expired / cancelled notifications and disabled providers are skipped', async () => {
    const svc = cradle().deliveryService;
    const a = await paidOrder();
    await cradle().db.notification.update({
      where: { id: a.notificationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    expect(await svc.deliver(a.push)).toEqual({ status: 'skipped', reason: 'EXPIRED' });
    const b = await paidOrder();
    await cradle().db.notification.update({
      where: { id: b.notificationId },
      data: { status: 'CANCELLED' },
    });
    expect(await svc.deliver(b.push)).toEqual({ status: 'skipped', reason: 'CANCELLED' });

    const c = await paidOrder();
    const providers = cradle().providers;
    const { asValue } = await import('awilix');
    t.app.diContainer.register({ providers: asValue({ ...providers, email: null }) });
    try {
      expect(await svc.deliver(c.email)).toEqual({
        status: 'skipped',
        reason: 'PROVIDER_DISABLED',
      });
    } finally {
      t.app.diContainer.register({ providers: asValue(providers) });
    }
  });

  it('auth-service down while resolving the address → retry, not lost', async () => {
    const { email } = await paidOrder();
    t.directory.failNext = 1;
    expect(await cradle().deliveryService.deliver(email)).toMatchObject({ status: 'retrying' });
  });

  it('sweep: recovers crashed SENDING claims and re-enqueues overdue deliveries', async () => {
    const a = await paidOrder();
    const b = await paidOrder();
    const db = cradle().db;
    await db.notificationDelivery.update({
      where: { id: a.push },
      data: { status: 'SENDING', lockedAt: new Date(Date.now() - 10 * 60_000), attempts: 1 },
    });
    await db.notificationDelivery.update({
      where: { id: b.push },
      data: { nextAttemptAt: new Date(Date.now() - 5 * 60_000) },
    });
    t.deliveriesQueued.length = 0;
    expect(await cradle().deliveryService.sweep()).toBeGreaterThanOrEqual(2);
    expect(await deliveryOf(a.push)).toMatchObject({ status: 'RETRYING', lockedAt: null });
    const ids = t.deliveriesQueued.map((j) => j.id);
    expect(ids).toEqual(expect.arrayContaining([a.push, b.push]));
    expect(t.deliveriesQueued.find((j) => j.id === a.push)?.attempts).toBe(1);
  });
});

describe.skipIf(DB_URL === undefined)('scheduling, expiry and retention', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  const schedule = async (scheduledFor: Date, extra: { expiresAt?: Date } = {}) => {
    const { notificationsService, runInTransaction } = t.app.diContainer.cradle;
    const key = `it-sched:${randomUUID()}`;
    const users = [randomUUID(), randomUUID()];
    await runInTransaction((tx) =>
      notificationsService.accept(tx, {
        dedupeKey: key,
        category: 'SYSTEM',
        priority: 'NORMAL',
        app: 'CUSTOMER',
        audience: { kind: 'users', userIds: users },
        channels: ['PUSH'],
        templateKey: 'admin.message',
        vars: { title: 'Later', body: 'Scheduled body' },
        source: 'admin',
        scheduledFor,
        ...extra,
      }),
    );
    return key;
  };

  it('SCHEDULED waits; when due it is released to the fan-out and reaches every user', async () => {
    const svc = t.app.diContainer.resolve('notificationsService');
    const future = await schedule(new Date(Date.now() + 3600_000));
    const due = await schedule(new Date(Date.now() - 1000));
    expect(await byDedupeKey(t.app, due)).toMatchObject({ status: 'SCHEDULED', recipientCount: 0 });

    await svc.releaseScheduled();
    const released = await byDedupeKey(t.app, due);
    expect(released?.status).toBe('PROCESSING');
    expect(t.fanoutsQueued).toContain(released?.id);
    expect((await byDedupeKey(t.app, future))?.status).toBe('SCHEDULED');

    await svc.fanout(released?.id ?? '');
    const sent = await byDedupeKey(t.app, due);
    expect(sent).toMatchObject({ status: 'SENT', recipientCount: 2 });
    expect(sent?.deliveries.map((d) => d.channel)).toEqual(['PUSH', 'PUSH']);
  });

  it('expire: past expiresAt before release → EXPIRED (never sent)', async () => {
    const key = await schedule(new Date(Date.now() + 3600_000), {
      expiresAt: new Date(Date.now() + 50),
    });
    await new Promise((r) => setTimeout(r, 100));
    await t.app.diContainer.resolve('notificationsService').expire();
    expect((await byDedupeKey(t.app, key))?.status).toBe('EXPIRED');
  });

  it('retention deletes old history with its recipients and deliveries', async () => {
    const key = await schedule(new Date(Date.now() - 1000));
    const db = t.app.diContainer.resolve('db');
    const svc = t.app.diContainer.resolve('notificationsService');
    await svc.releaseScheduled();
    const n = await byDedupeKey(t.app, key);
    await svc.fanout(n?.id ?? '');
    await db.notification.update({
      where: { id: n?.id ?? '' },
      data: { createdAt: new Date(Date.now() - 400 * 86_400_000) },
    });
    expect(await svc.purgeOld()).toBeGreaterThanOrEqual(1);
    expect(await byDedupeKey(t.app, key)).toBeNull();
    expect(await db.notificationRecipient.count({ where: { notificationId: n?.id ?? '' } })).toBe(
      0,
    );
  });
});
