import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB_URL, type TestApp, buildTestApp, data, meta, signIn } from './harness.js';

const REASON = 'Integration test of the admin API';

/** Admin call with an optional Idempotency-Key. */
const as = (
  app: FastifyInstance,
  user: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: object,
  key?: string,
) =>
  app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${user}`,
      ...(key === undefined ? {} : { 'idempotency-key': key }),
    },
    ...(payload === undefined ? {} : { payload }),
  });

interface Detail {
  id: string;
  status: string;
  recipientCount: number;
  deliveryStats: Record<string, Record<string, number>>;
  title: string;
}

describe.skipIf(DB_URL === undefined)('admin notification APIs', () => {
  let t: TestApp;
  let manager: string;
  let viewer: string;
  beforeAll(async () => {
    t = await buildTestApp();
    manager = signIn('INTERNAL', ['notifications.manage', 'notifications.view']);
    viewer = signIn('INTERNAL', ['notifications.view']);
  });
  afterAll(async () => {
    await t.app.close();
  });

  const message = (over: object = {}) => ({
    app: 'CUSTOMER',
    audience: { type: 'USERS', userIds: [randomUUID(), randomUUID()] },
    channels: ['PUSH'],
    vars: { title: 'Price drop', body: 'Vaccines are 10% off this week.' },
    data: { entityType: 'offer', entityId: 'DIWALI26' },
    reason: REASON,
    ...over,
  });
  const send = (over: object = {}, key: string = randomUUID(), user = manager) =>
    as(t.app, user, 'POST', '/admin/notifications', message(over), key);

  it('requires staff + permission; customers and viewers cannot send', async () => {
    const customer = signIn('CUSTOMER');
    expect((await send({}, randomUUID(), customer)).statusCode).toBe(403);
    expect((await send({}, randomUUID(), viewer)).statusCode).toBe(403);
    expect((await as(t.app, viewer, 'GET', '/admin/notifications')).statusCode).toBe(200);
    expect((await as(t.app, customer, 'GET', '/admin/notifications')).statusCode).toBe(403);
  });

  it('sends to users, audited, idempotent per staff user + Idempotency-Key', async () => {
    expect((await as(t.app, manager, 'POST', '/admin/notifications', message())).statusCode).toBe(
      400,
    );

    const key = randomUUID();
    const first = await send({}, key);
    expect(first.statusCode).toBe(201);
    const n = data<Detail>(first);
    expect(n).toMatchObject({
      status: 'SENT',
      recipientCount: 2,
      title: 'Price drop',
      deliveryStats: { PUSH: { PENDING: 2 } },
    });
    expect(t.deliveriesQueued.filter((j) => j.channel === 'PUSH').length).toBeGreaterThanOrEqual(2);

    const replay = await send({ vars: { title: 'Other', body: 'Different body text' } }, key);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['idempotent-replay']).toBe('true');
    expect(data<Detail>(replay).id).toBe(n.id);

    const otherStaff = signIn('INTERNAL', ['notifications.manage', 'notifications.view']);
    expect(data<Detail>(await send({}, key, otherStaff)).id).not.toBe(n.id);

    const audit = await t.app.diContainer.resolve('db').notificationAuditLog.findMany({
      where: { targetId: n.id },
    });
    expect(audit).toEqual([
      expect.objectContaining({
        action: 'notification.send',
        actorUserId: manager,
        reason: REASON,
      }),
    ]);
  });

  it('validates audience, category, schedule and template values', async () => {
    const bad = async (over: object) => (await send(over)).statusCode;
    expect(await bad({ audience: { type: 'PERMISSION', permission: 'orders.confirm' } })).toBe(422);
    expect(await bad({ category: 'SECURITY' })).toBe(422);
    expect(await bad({ priority: 'CRITICAL' })).toBe(422);
    expect(await bad({ audience: { type: 'USER', userIds: [randomUUID(), randomUUID()] } })).toBe(
      422,
    );
    expect(await bad({ audience: { type: 'APP', userIds: [randomUUID()] } })).toBe(422);
    expect(await bad({ scheduledFor: new Date(Date.now() - 60_000).toISOString() })).toBe(422);
    expect(await bad({ vars: { title: 'only a title' } })).toBe(422);
    const res = await send({ templateKey: 'order.confirmed', vars: { wrong: 'x' } });
    expect(res.statusCode).toBe(422);
  });

  it('APP and PERMISSION audiences fan out in the background', async () => {
    const broadcast = data<Detail>(await send({ audience: { type: 'APP' } }));
    expect(broadcast.status).toBe('PROCESSING');
    expect(t.fanoutsQueued).toContain(broadcast.id);
    const staff = data<Detail>(
      await send({
        app: 'WAREHOUSE',
        audience: { type: 'PERMISSION', permission: 'inventory.view', warehouseId: randomUUID() },
      }),
    );
    expect(staff.status).toBe('PROCESSING');
    // Cancelling a fan-out in progress stops it (and keeps a running dev service from
    // broadcasting test data to every local user).
    for (const id of [broadcast.id, staff.id]) {
      const res = await as(t.app, manager, 'POST', `/admin/notifications/${id}/cancel`, {
        reason: REASON,
      });
      expect(data<Detail>(res).status).toBe('CANCELLED');
    }
    await t.app.diContainer.resolve('notificationsService').fanout(broadcast.id);
    expect(
      await t.app.diContainer
        .resolve('db')
        .notificationRecipient.count({ where: { notificationId: broadcast.id } }),
    ).toBe(0);
  });

  it('schedule → cancel (once); a sent notification cannot be cancelled', async () => {
    const later = new Date(Date.now() + 3600_000).toISOString();
    const scheduled = data<Detail>(await send({ scheduledFor: later }));
    expect(scheduled).toMatchObject({ status: 'SCHEDULED', recipientCount: 0 });

    const cancel = (id: string) =>
      as(t.app, manager, 'POST', `/admin/notifications/${id}/cancel`, { reason: REASON });
    const res = await cancel(scheduled.id);
    expect(res.statusCode).toBe(200);
    expect(data<Detail>(res).status).toBe('CANCELLED');
    expect((await cancel(scheduled.id)).statusCode).toBe(409);
    const sent = data<Detail>(await send());
    expect((await cancel(sent.id)).statusCode).toBe(409);
    expect((await cancel(randomUUID())).statusCode).toBe(404);
  });

  it('history: filter by source / entity, cursor paging, detail 404', async () => {
    const entityId = `it-${randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 3; i += 1) await send({ data: { entityType: 'offer', entityId } });
    const p1 = await as(
      t.app,
      viewer,
      'GET',
      `/admin/notifications?source=admin&entityId=${entityId}&limit=2`,
    );
    expect(data<Detail[]>(p1)).toHaveLength(2);
    const cursor = meta(p1).nextCursor ?? '';
    const p2 = await as(
      t.app,
      viewer,
      'GET',
      `/admin/notifications?entityId=${entityId}&limit=2&cursor=${cursor}`,
    );
    expect(data<Detail[]>(p2)).toHaveLength(1);
    expect(meta(p2).nextCursor).toBeNull();
    expect(
      (await as(t.app, viewer, 'GET', `/admin/notifications/${randomUUID()}`)).statusCode,
    ).toBe(404);
  });

  it('failed deliveries (DLQ): list, retry one, bulk retry; cancelled ones are not retryable', async () => {
    const db = t.app.diContainer.resolve('db');
    const n = data<Detail>(await send({ channels: ['PUSH', 'EMAIL'] }));
    await db.notificationDelivery.updateMany({
      where: { notificationId: n.id },
      data: {
        status: 'FAILED',
        attempts: 6,
        lastError: 'attempts exhausted: ETIMEDOUT',
        failedAt: new Date(),
      },
    });
    const dlq = await as(
      t.app,
      viewer,
      'GET',
      `/admin/notifications/deliveries?status=FAILED&notificationId=${n.id}`,
    );
    const rows = data<{ id: string; channel: string; title: string; lastError: string }[]>(dlq);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      title: 'Price drop',
      lastError: 'attempts exhausted: ETIMEDOUT',
    });
    expect(dlq.body).not.toMatch(/@|fcm-/);

    const one = rows.find((r) => r.channel === 'EMAIL')?.id ?? '';
    const retry = (id: string) =>
      as(t.app, manager, 'POST', `/admin/notifications/deliveries/${id}/retry`, { reason: REASON });
    expect(data(await retry(one))).toEqual({ retried: 1 });
    expect(await db.notificationDelivery.findUnique({ where: { id: one } })).toMatchObject({
      status: 'PENDING',
      attempts: 0,
      failedAt: null,
    });
    expect(t.deliveriesQueued.at(-1)).toMatchObject({ id: one, attempts: 0 });
    expect((await retry(one)).statusCode).toBe(409);
    expect((await retry(randomUUID())).statusCode).toBe(404);

    const bulk = await as(t.app, manager, 'POST', '/admin/notifications/deliveries/retry-failed', {
      notificationId: n.id,
      channel: 'PUSH',
      reason: REASON,
    });
    expect(data(bulk)).toEqual({ retried: 2 });

    // A FAILED delivery of a cancelled notification stays FAILED.
    const later = data<Detail>(
      await send({ scheduledFor: new Date(Date.now() + 3600_000).toISOString() }),
    );
    await as(t.app, manager, 'POST', `/admin/notifications/${later.id}/cancel`, { reason: REASON });
    const ghost = await db.notificationDelivery.findFirst({
      where: { notificationId: n.id, channel: 'EMAIL', status: 'FAILED' },
    });
    await db.notification.update({ where: { id: n.id }, data: { status: 'CANCELLED' } });
    if (ghost !== null) expect((await retry(ghost.id)).statusCode).toBe(409);
  });

  it('analytics: per channel outcomes; range limits', async () => {
    const res = await as(t.app, viewer, 'GET', '/admin/notifications/analytics');
    expect(res.statusCode).toBe(200);
    const a = data<{
      deliveries: { channel: string; inFlight: number }[];
      notifications: unknown[];
    }>(res);
    expect(a.deliveries.map((d) => d.channel)).toContain('PUSH');
    expect(a.notifications.length).toBeGreaterThan(0);
    const from = new Date(Date.now() - 100 * 86_400_000).toISOString();
    expect(
      (await as(t.app, viewer, 'GET', `/admin/notifications/analytics?from=${from}`)).statusCode,
    ).toBe(422);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect(
      (
        await as(
          t.app,
          viewer,
          'GET',
          `/admin/notifications/analytics?from=${future}&to=${new Date().toISOString()}`,
        )
      ).statusCode,
    ).toBe(422);
  });
});

describe.skipIf(DB_URL === undefined)('admin template APIs', () => {
  let t: TestApp;
  let manager: string;
  beforeAll(async () => {
    t = await buildTestApp();
    manager = signIn('INTERNAL', ['notifications.manage', 'notifications.view']);
  });
  afterAll(async () => {
    await t.app.close();
  });

  interface Tpl {
    id: string;
    version: number;
    isActive: boolean;
    key: string;
  }

  it('create → draft version → preview → activate → roll back; variables are fixed', async () => {
    const key = `it.visit_${randomUUID().slice(0, 8)}`;
    const base = '/admin/notification-templates';
    const created = await as(t.app, manager, 'POST', base, {
      key,
      channel: 'IN_APP',
      title: 'Vet visit on {{visitDate}}',
      body: 'Dr. {{vetName}} visits on {{visitDate}}.',
      variables: [
        { name: 'vetName', type: 'string', maxLength: 60 },
        { name: 'visitDate', type: 'date' },
      ],
      reason: REASON,
    });
    expect(created.statusCode).toBe(201);
    const v1 = data<Tpl>(created);
    expect(v1).toMatchObject({ version: 1, isActive: true });

    const dup = await as(t.app, manager, 'POST', base, {
      key,
      channel: 'IN_APP',
      body: 'x',
      reason: REASON,
    });
    expect(dup.statusCode).toBe(409);
    const undeclared = await as(t.app, manager, 'POST', base, {
      key: `${key}_b`,
      channel: 'IN_APP',
      body: 'Hi {{name}}',
      reason: REASON,
    });
    expect(undeclared.statusCode).toBe(422);

    const draft = await as(t.app, manager, 'POST', `${base}/${v1.id}/versions`, {
      body: 'Reminder: Dr. {{vetName}} on {{visitDate}}.',
      activate: false,
      reason: REASON,
    });
    const v2 = data<Tpl>(draft);
    expect(v2).toMatchObject({ version: 2, isActive: false });
    expect(
      (
        await as(t.app, manager, 'POST', `${base}/${v1.id}/versions`, {
          body: 'Uses {{farmName}}',
          reason: REASON,
        })
      ).statusCode,
    ).toBe(422);

    const preview = await as(t.app, manager, 'POST', `${base}/${v2.id}/preview`, {
      vars: { vetName: 'Rao', visitDate: '2026-11-30T04:30:00Z' },
    });
    expect(data(preview)).toEqual({
      channel: 'IN_APP',
      title: 'Vet visit on 30 Nov 2026, 10:00 am',
      text: 'Reminder: Dr. Rao on 30 Nov 2026, 10:00 am.',
      html: null,
    });
    expect(
      (await as(t.app, manager, 'POST', `${base}/${v2.id}/preview`, { vars: {} })).statusCode,
    ).toBe(422);

    const templates = t.app.diContainer.resolve('templatesService');
    const vars = { vetName: 'Rao', visitDate: '2026-11-30T04:30:00Z' };
    expect((await templates.render(key, [], vars)).body).toBe(
      'Dr. Rao visits on 30 Nov 2026, 10:00 am.',
    );
    await as(t.app, manager, 'POST', `${base}/${v2.id}/activate`, { reason: REASON });
    expect((await templates.render(key, [], vars)).body).toBe(
      'Reminder: Dr. Rao on 30 Nov 2026, 10:00 am.',
    );
    await as(t.app, manager, 'POST', `${base}/${v1.id}/activate`, { reason: REASON });
    expect((await templates.render(key, [], vars)).version).toBe(1);

    const family = data<Tpl[]>(await as(t.app, manager, 'GET', `${base}?key=${key}`));
    expect(family.map((f) => [f.version, f.isActive])).toEqual([
      [2, false],
      [1, true],
    ]);
    const actions = await t.app.diContainer.resolve('db').notificationAuditLog.findMany({
      where: { targetId: { in: [v1.id, v2.id] } },
      select: { action: true },
    });
    expect(actions.map((a) => a.action).sort()).toEqual([
      'template.activate',
      'template.activate',
      'template.create',
      'template.version',
    ]);
  });

  it('lists seeded templates; viewers cannot write', async () => {
    const viewer = signIn('INTERNAL', ['notifications.view']);
    const list = await as(
      t.app,
      viewer,
      'GET',
      '/admin/notification-templates?key=order.confirmed&active=true',
    );
    expect(data<Tpl[]>(list).map((x) => x.key)).toEqual(['order.confirmed', 'order.confirmed']);
    const write = await as(t.app, viewer, 'POST', '/admin/notification-templates', {
      key: 'it.nope',
      channel: 'IN_APP',
      body: 'x',
      reason: REASON,
    });
    expect(write.statusCode).toBe(403);
  });
});
