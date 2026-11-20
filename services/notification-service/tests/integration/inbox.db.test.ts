import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { NotificationApp, NotificationCategory } from '../../src/domain.js';
import { DB_URL, type TestApp, buildTestApp, call, data, meta, signIn } from './harness.js';

interface Item {
  id: string;
  title: string;
  read: boolean;
  category: string;
  data: Record<string, unknown>;
}

/** Creates (and commits) one notification for `userIds` in `app`; returns its id. */
const notify = async (
  app: FastifyInstance,
  userIds: string[],
  o: { app?: NotificationApp; category?: NotificationCategory; title?: string } = {},
): Promise<string> => {
  const { notificationsService, runInTransaction } = app.diContainer.cradle;
  const accepted = await runInTransaction((tx) =>
    notificationsService.accept(tx, {
      dedupeKey: `it-inbox:${randomUUID()}`,
      category: o.category ?? 'SYSTEM',
      priority: 'NORMAL',
      app: o.app ?? 'CUSTOMER',
      audience: { kind: 'users', userIds },
      channels: [],
      templateKey: 'admin.message',
      vars: { title: o.title ?? 'Hello', body: 'Body text' },
      data: { entityType: 'order', entityId: randomUUID() },
      source: 'admin',
    }),
  );
  if (accepted === null) throw new Error('duplicate');
  await notificationsService.afterCommit(accepted);
  return accepted.notificationId;
};

describe.skipIf(DB_URL === undefined)('user APIs against Postgres + Redis', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('401 without a token', async () => {
    for (const url of [
      '/notifications',
      '/notifications/unread-count',
      '/notifications/preferences',
    ])
      expect((await call(t.app, 'GET', url)).statusCode).toBe(401);
  });

  it('lists newest first with a stable cursor; filters unread / category', async () => {
    const user = signIn();
    const first = await notify(t.app, [user], { title: 'one' });
    await notify(t.app, [user], { title: 'two', category: 'PROMO' });
    await notify(t.app, [user], { title: 'three' });

    const p1 = await call(t.app, 'GET', '/notifications?limit=2', { user });
    expect(p1.statusCode).toBe(200);
    expect(data<Item[]>(p1).map((i) => i.title)).toEqual(['three', 'two']);
    const cursor = meta(p1).nextCursor;
    expect(cursor).not.toBeNull();

    await notify(t.app, [user], { title: 'four' }); // arrives between pages
    const p2 = await call(t.app, 'GET', `/notifications?limit=2&cursor=${cursor ?? ''}`, { user });
    expect(data<Item[]>(p2).map((i) => i.title)).toEqual(['one']);
    expect(meta(p2).nextCursor).toBeNull();

    const promos = await call(t.app, 'GET', '/notifications?category=PROMO', { user });
    expect(data<Item[]>(promos).map((i) => i.title)).toEqual(['two']);

    await call(t.app, 'POST', `/notifications/${first}/read`, { user });
    const unread = await call(t.app, 'GET', '/notifications?unread=true', { user });
    expect(data<Item[]>(unread).map((i) => i.title)).toEqual(['four', 'three', 'two']);
  });

  it('apps are isolated and decided by the token, never by the client', async () => {
    const customer = signIn('CUSTOMER');
    const staff = signIn('INTERNAL');
    const adminOnly = await notify(t.app, [staff], { app: 'ADMIN', title: 'admin' });
    await notify(t.app, [staff], { app: 'WAREHOUSE', title: 'warehouse' });

    expect(
      (await call(t.app, 'GET', '/notifications?app=ADMIN', { user: customer })).statusCode,
    ).toBe(403);
    const adminInbox = await call(t.app, 'GET', '/notifications', { user: staff });
    expect(data<Item[]>(adminInbox).map((i) => i.title)).toEqual(['admin']);
    const whInbox = await call(t.app, 'GET', '/notifications?app=WAREHOUSE', { user: staff });
    expect(data<Item[]>(whInbox).map((i) => i.title)).toEqual(['warehouse']);
    // The ADMIN entry is not reachable through the WAREHOUSE inbox.
    expect(
      (await call(t.app, 'GET', `/notifications/${adminOnly}?app=WAREHOUSE`, { user: staff }))
        .statusCode,
    ).toBe(404);
  });

  it("another user's notification answers 404 (get and read)", async () => {
    const owner = signIn();
    const other = signIn();
    const id = await notify(t.app, [owner]);
    expect((await call(t.app, 'GET', `/notifications/${id}`, { user: other })).statusCode).toBe(
      404,
    );
    expect(
      (await call(t.app, 'POST', `/notifications/${id}/read`, { user: other })).statusCode,
    ).toBe(404);
    const own = await call(t.app, 'GET', `/notifications/${id}`, { user: owner });
    expect(data<Item>(own)).toMatchObject({ id, read: false, data: { entityType: 'order' } });
  });

  it('read is idempotent; read-all respects `before`; expired entries are hidden', async () => {
    const user = signIn();
    const a = await notify(t.app, [user]);
    await notify(t.app, [user]);
    const expired = await notify(t.app, [user]);
    await t.app.diContainer.resolve('db').notificationRecipient.updateMany({
      where: { notificationId: expired },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const count = async () =>
      data<{ unreadCount: number }>(
        await call(t.app, 'GET', '/notifications/unread-count', { user }),
      ).unreadCount;
    expect(await count()).toBe(2);
    expect((await call(t.app, 'GET', `/notifications/${expired}`, { user })).statusCode).toBe(404);

    const r1 = await call(t.app, 'POST', `/notifications/${a}/read`, { user });
    expect(data(r1)).toEqual({ id: a, read: true, unreadCount: 1 });
    const r2 = await call(t.app, 'POST', `/notifications/${a}/read`, { user });
    expect(data(r2)).toEqual({ id: a, read: true, unreadCount: 1 });

    const past = new Date(Date.now() - 60_000).toISOString();
    const none = await call(t.app, 'POST', '/notifications/read-all', {
      user,
      payload: { before: past },
    });
    expect(data(none)).toEqual({ updated: 0, unreadCount: 1 });
    const all = await call(t.app, 'POST', '/notifications/read-all', { user, payload: {} });
    expect(data(all)).toEqual({ updated: 1, unreadCount: 0 });
  });

  it('preferences: defaults, partial update, SECURITY is read-only', async () => {
    const user = signIn();
    const initial = data<{ category: string; push: boolean; email: boolean; mandatory: boolean }[]>(
      await call(t.app, 'GET', '/notifications/preferences', { user }),
    );
    expect(initial.find((p) => p.category === 'ORDER')).toMatchObject({ push: true, email: true });
    expect(initial.find((p) => p.category === 'PROMO')).toMatchObject({ push: false });
    expect(initial.find((p) => p.category === 'SECURITY')).toMatchObject({ mandatory: true });

    const changes = [
      { category: 'ORDER', channel: 'EMAIL', enabled: false },
      { category: 'PROMO', channel: 'PUSH', enabled: true },
    ];
    const updated = await call(t.app, 'PUT', '/notifications/preferences', {
      user,
      payload: { changes },
    });
    expect(updated.statusCode).toBe(200);
    const rows = data<{ category: string; push: boolean; email: boolean }[]>(updated);
    expect(rows.find((p) => p.category === 'ORDER')).toMatchObject({ push: true, email: false });
    expect(rows.find((p) => p.category === 'PROMO')).toMatchObject({ push: true });
    // Upsert: flipping back updates the same row.
    await call(t.app, 'PUT', '/notifications/preferences', {
      user,
      payload: { changes: [{ category: 'ORDER', channel: 'EMAIL', enabled: true }] },
    });
    const again = data<{ category: string; email: boolean }[]>(
      await call(t.app, 'GET', '/notifications/preferences', { user }),
    );
    expect(again.find((p) => p.category === 'ORDER')?.email).toBe(true);

    for (const bad of [
      [{ category: 'SECURITY', channel: 'PUSH', enabled: false }],
      [{ category: 'ORDER', channel: 'IN_APP', enabled: false }],
      [changes[0], changes[0]],
      [],
    ]) {
      const res = await call(t.app, 'PUT', '/notifications/preferences', {
        user,
        payload: { changes: bad },
      });
      expect(res.statusCode).toBe(422);
    }
  });

  it('devices: token never echoed, moves between accounts, capped at 10, own-only delete', async () => {
    const a = signIn();
    const b = signIn();
    const token = `fcm-token-${randomUUID()}`;
    const reg = await call(t.app, 'POST', '/notifications/devices', {
      user: a,
      payload: { token, platform: 'ANDROID', deviceId: 'install-1' },
    });
    expect(reg.statusCode).toBe(200);
    expect(reg.body).not.toContain(token);
    const device = data<{ id: string; app: string }>(reg);
    expect(device.app).toBe('CUSTOMER');

    // Same token signed in by B (resold phone) → moves to B.
    await call(t.app, 'POST', '/notifications/devices', {
      user: b,
      payload: { token, platform: 'ANDROID' },
    });
    expect(
      data<unknown[]>(await call(t.app, 'GET', '/notifications/devices', { user: a })),
    ).toHaveLength(0);
    expect(
      data<unknown[]>(await call(t.app, 'GET', '/notifications/devices', { user: b })),
    ).toHaveLength(1);

    // A cannot remove B's device; B can (twice: idempotent).
    expect(
      (await call(t.app, 'DELETE', `/notifications/devices/${device.id}`, { user: a })).statusCode,
    ).toBe(404);
    expect(
      (await call(t.app, 'DELETE', `/notifications/devices/${device.id}`, { user: b })).statusCode,
    ).toBe(204);
    expect(
      (await call(t.app, 'DELETE', `/notifications/devices/${device.id}`, { user: b })).statusCode,
    ).toBe(204);

    // Cap: 11 registrations → 10 active (rate limit is 10/min, so write directly after 9 calls).
    const devices = t.app.diContainer.resolve('devicesService');
    for (let i = 0; i < 11; i += 1)
      await devices.register(a, 'CUSTOMER', { token: `fcm-cap-${randomUUID()}`, platform: 'IOS' });
    expect(
      data<unknown[]>(await call(t.app, 'GET', '/notifications/devices', { user: a })),
    ).toHaveLength(10);

    const bad = await call(t.app, 'POST', '/notifications/devices', {
      user: a,
      payload: { token: 'short', platform: 'NOKIA' },
    });
    expect(bad.statusCode).toBe(422);
    const wrongApp = await call(t.app, 'POST', '/notifications/devices', {
      user: a,
      payload: { token: `fcm-${randomUUID()}`, platform: 'WEB', app: 'ADMIN' },
    });
    expect(wrongApp.statusCode).toBe(403);
  });
});

/** Reads SSE frames from a fetch body until `count` named events arrived. */
const readEvents = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  count: number,
): Promise<{ event: string; data: unknown }[]> => {
  const decoder = new TextDecoder();
  const events: { event: string; data: unknown }[] = [];
  let buffer = '';
  while (events.length < count) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const event = /^event: (.+)$/m.exec(frame)?.[1];
      const payload = /^data: (.+)$/m.exec(frame)?.[1];
      if (event !== undefined && payload !== undefined)
        events.push({ event, data: JSON.parse(payload) as unknown });
      end = buffer.indexOf('\n\n');
    }
  }
  return events;
};

describe.skipIf(DB_URL === undefined)('SSE live stream (real HTTP + Redis pub/sub)', () => {
  let t: TestApp;
  let base: string;
  beforeAll(async () => {
    t = await buildTestApp();
    base = await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await t.app.close();
  });

  const open = (user: string, controller: AbortController) =>
    fetch(`${base}/notifications/stream`, {
      headers: { authorization: `Bearer ${user}` },
      signal: controller.signal,
    });

  it('pushes the unread count, new notifications and read changes', async () => {
    const user = signIn();
    await notify(t.app, [user]);
    const controller = new AbortController();
    try {
      const res = await open(user, controller);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/event-stream');
      const reader = (res.body as ReadableStream<Uint8Array>).getReader();
      expect(await readEvents(reader, 1)).toEqual([
        { event: 'unread_count', data: { unreadCount: 1 } },
      ]);

      const id = await notify(t.app, [user], { title: 'live' });
      const [created] = await readEvents(reader, 1);
      expect(created).toMatchObject({
        event: 'notification',
        data: { id, title: 'live', read: false },
      });

      await call(t.app, 'POST', `/notifications/${id}/read`, { user });
      expect(await readEvents(reader, 1)).toEqual([
        { event: 'unread_count', data: { unreadCount: 1 } },
      ]);
    } finally {
      controller.abort();
    }
  });

  it('a user may hold at most 5 streams (6th → 429); closing one frees a slot', async () => {
    const user = signIn();
    const controllers = Array.from({ length: 6 }, () => new AbortController());
    try {
      const statuses: number[] = [];
      for (const c of controllers.slice(0, 5)) {
        const res = await open(user, c);
        statuses.push(res.status);
        await readEvents((res.body as ReadableStream<Uint8Array>).getReader(), 1);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200]);
      expect((await open(user, controllers[5] ?? new AbortController())).status).toBe(429);

      controllers[0]?.abort();
      let status = 0;
      for (let i = 0; i < 20 && status !== 200; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const retry = new AbortController();
        controllers.push(retry);
        status = (await open(user, retry)).status;
      }
      expect(status).toBe(200);
    } finally {
      for (const c of controllers) c.abort();
    }
  });
});
