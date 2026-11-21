import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DB_URL, type TestApp, buildTestApp, byDedupeKey, deliver, envelope } from './harness.js';

const content = (over: Record<string, unknown> = {}) => ({
  contentId: randomUUID(),
  contentVersion: 1,
  kind: 'ALERT',
  severity: 'WARNING',
  title: 'Newcastle disease on 3 farms near Tanuku',
  placeLabel: 'Tanuku',
  summary: 'Confirmed in broiler and layer flocks around Tanuku and Attili.',
  ...over,
});

describe.skipIf(DB_URL === undefined)('content events → farm-segment fan-out', () => {
  let t: TestApp;
  beforeAll(async () => {
    t = await buildTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  const fanout = (id: string) => t.app.diContainer.resolve('notificationsService').fanout(id);
  const db = () => t.app.diContainer.resolve('db');

  it('10 000 readers in 20 pages: exactly one inbox row each, even after a crash mid fan-out', async () => {
    const data = content();
    const readers = Array.from({ length: 10_000 }, () => randomUUID());
    t.farmReaders.byContent.set(data.contentId, { segment: readers, savers: [] });
    t.farmReaders.calls = 0;
    t.farmReaders.failAtCall = 8; // farm-service fails on page 8

    expect(await deliver(t.app, envelope('content.published.v1', data))).toBe('processed');
    const n = await byDedupeKey(t.app, `content.published:${data.contentId}:v1`);
    expect(n).toMatchObject({
      status: 'PROCESSING',
      category: 'CONTENT',
      priority: 'HIGH',
      audienceType: 'FARM_CONTENT',
      templateKey: 'content.alert',
    });
    expect(n?.data).toEqual({ entityType: 'content', entityId: data.contentId, contentVersion: 1 });

    await expect(fanout(n?.id ?? '')).rejects.toThrow('farm-service down');
    const partial = await db().notificationRecipient.count({ where: { notificationId: n?.id } });
    expect(partial).toBe(7 * 500); // 7 committed pages, nothing half-written

    t.farmReaders.failAtCall = null;
    await fanout(n?.id ?? ''); // the retry resumes from the stored cursor
    const rows = await db().notificationRecipient.findMany({
      where: { notificationId: n?.id },
      select: { userId: true },
    });
    expect(rows).toHaveLength(10_000);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(10_000);
    const done = await db().notification.findUnique({ where: { id: n?.id } });
    expect(done).toMatchObject({ status: 'SENT', recipientCount: 10_000 });

    // A second fan-out run (sweep re-queue) adds nobody.
    await fanout(n?.id ?? '');
    expect(await db().notificationRecipient.count({ where: { notificationId: n?.id } })).toBe(
      10_000,
    );
  }, 120_000);

  it('duplicate deliveries: same event id and a re-emit with a new id → one notification', async () => {
    const data = content({ severity: 'INFO', kind: 'NEWS' });
    t.farmReaders.byContent.set(data.contentId, { segment: [randomUUID()], savers: [] });
    const event = envelope('content.published.v1', data);
    expect(await deliver(t.app, event)).toBe('processed');
    expect(await deliver(t.app, event)).toBe('duplicate');
    await deliver(t.app, envelope('content.published.v1', data)); // new event id, same version
    const all = await db().notification.findMany({ where: { entityId: data.contentId } });
    expect(all).toHaveLength(1);
    expect(all[0]?.templateKey).toBe('content.news');

    // A correction (new contentVersion) notifies once more — segment + savers.
    await deliver(
      t.app,
      envelope('content.corrected.v1', {
        ...data,
        contentVersion: 2,
        correctionNote: 'Corrected the affected mandals.',
      }),
    );
    const corrected = await byDedupeKey(t.app, `content.corrected:${data.contentId}:v2`);
    expect(corrected?.audience).toEqual({ contentId: data.contentId, scope: 'both' });
  });

  it('retraction of a never-pushed item reaches savers only', async () => {
    const data = content();
    const saver = randomUUID();
    t.farmReaders.byContent.set(data.contentId, { segment: [randomUUID()], savers: [saver] });
    await deliver(
      t.app,
      envelope('content.retracted.v1', {
        ...data,
        contentVersion: 3,
        retractNote: 'Lab results did not confirm ND.',
        wasNotified: false,
      }),
    );
    const n = await byDedupeKey(t.app, `content.retracted:${data.contentId}:v3`);
    expect(n?.audience).toEqual({ contentId: data.contentId, scope: 'savers' });
    await fanout(n?.id ?? '');
    const rows = await db().notificationRecipient.findMany({ where: { notificationId: n?.id } });
    expect(rows.map((r) => r.userId)).toEqual([saver]);
  });

  it('routine content stops pushing after 3 per 24 h (inbox only); CRITICAL alerts still push', async () => {
    const reader = randomUUID();
    const push = async (data: ReturnType<typeof content>) => {
      t.farmReaders.byContent.set(data.contentId, { segment: [reader], savers: [] });
      await deliver(t.app, envelope('content.published.v1', data));
      const n = await byDedupeKey(t.app, `content.published:${data.contentId}:v1`);
      await fanout(n?.id ?? '');
      return byDedupeKey(t.app, `content.published:${data.contentId}:v1`);
    };
    for (let i = 0; i < 3; i += 1) {
      const n = await push(content({ kind: 'NEWS', severity: null }));
      expect(n?.deliveries.map((d) => d.channel)).toEqual(['PUSH']);
    }
    const fourth = await push(content({ kind: 'NEWS', severity: null }));
    expect(fourth?.recipients).toHaveLength(1);
    expect(fourth?.deliveries).toHaveLength(0);

    const critical = await push(content({ severity: 'CRITICAL' }));
    expect(critical?.priority).toBe('CRITICAL');
    expect(critical?.deliveries.map((d) => d.channel)).toEqual(['PUSH']);
  });
});
