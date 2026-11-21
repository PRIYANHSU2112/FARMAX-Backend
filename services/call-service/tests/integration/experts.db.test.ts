import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  addFarm,
  addProduct,
  buildTestApp,
  call,
  categoryPaths,
  customer,
  data,
  errorOf,
  staff,
  vendorUser,
} from './harness.js';

interface Expert {
  id: string;
  version: number;
  isBookable: boolean;
  isActive: boolean;
  type: string;
}

describe.skipIf(DB_URL === undefined)('call-service experts + options (Postgres + Redis)', () => {
  let app: FastifyInstance;
  const configurer = staff('sales.view', 'sales.configure');
  const viewer = staff('sales.view');
  const brandId = randomUUID();
  const rootCat = randomUUID();
  const ndCat = randomUUID();

  const newExpert = async (o: Record<string, unknown> = {}) => {
    const userId = vendorUser();
    const res = await call(app, 'POST', '/calls/admin/experts', {
      user: configurer,
      payload: {
        userId,
        type: 'SALES_REP',
        displayName: 'Anil Varma',
        languages: ['en'],
        channels: ['VIDEO', 'PHONE'],
        ...o,
      },
    });
    return { res, userId };
  };

  beforeAll(async () => {
    app = await buildTestApp();
    categoryPaths.set(ndCat, [rootCat, ndCat]);
  });
  afterAll(async () => {
    await app.close();
  });

  describe('auth', () => {
    it('401 without a token; 403 without the permission; 403 for a customer on admin routes', async () => {
      expect((await call(app, 'GET', '/calls/admin/experts')).statusCode).toBe(401);
      const valid = { userId: vendorUser(), type: 'SPECIALIST', displayName: 'X Y', languages: ['en'], channels: ['PHONE'] };
      expect((await call(app, 'POST', '/calls/admin/experts', { user: viewer, payload: valid })).statusCode).toBe(403);
      expect((await call(app, 'GET', '/calls/admin/experts', { user: customer() })).statusCode).toBe(403);
    });

    it('expert self routes need an active expert profile', async () => {
      expect((await call(app, 'GET', '/calls/experts/me', { user: vendorUser() })).statusCode).toBe(403);
      expect((await call(app, 'GET', '/calls/experts/me', { user: customer() })).statusCode).toBe(403);
    });
  });

  describe('admin experts', () => {
    it('creates a rep (201), one profile per user (409), user must exist (422)', async () => {
      const { res, userId } = await newExpert();
      expect(res.statusCode).toBe(201);
      const again = await call(app, 'POST', '/calls/admin/experts', {
        user: configurer,
        payload: { userId, type: 'SPECIALIST', displayName: 'Dup', languages: ['en'], channels: ['PHONE'] },
      });
      expect(again.statusCode).toBe(409);
      const ghost = await call(app, 'POST', '/calls/admin/experts', {
        user: configurer,
        payload: { userId: randomUUID(), type: 'SPECIALIST', displayName: 'Ghost', languages: ['en'], channels: ['PHONE'] },
      });
      expect(ghost.statusCode).toBe(422);
    });

    it('VET is never bookable: defaults off, explicit true → 422, PATCH to VET turns it off', async () => {
      const vet = await newExpert({ type: 'VET', displayName: 'Dr. M. K. Rao' });
      expect(vet.res.statusCode).toBe(201);
      expect(data<Expert>(vet.res).isBookable).toBe(false);
      expect((await newExpert({ type: 'VET', isBookable: true })).res.statusCode).toBe(422);

      const rep = data<Expert>((await newExpert()).res);
      const toVet = await call(app, 'PATCH', `/calls/admin/experts/${rep.id}`, {
        user: configurer,
        payload: { type: 'VET', reason: 'Moved to the clinical team' },
      });
      expect(toVet.statusCode).toBe(200);
      expect(data<Expert>(toVet).isBookable).toBe(false);
    });

    it('rejects unknown languages and FARM_VISIT without territory', async () => {
      const lang = await newExpert({ languages: ['xx'] });
      expect(lang.res.statusCode).toBe(422);
      expect(errorOf(lang.res).details?.issues?.[0]?.path).toBe('languages');
      expect((await newExpert({ channels: ['FARM_VISIT'] })).res.statusCode).toBe(422);
      expect((await newExpert({ channels: ['FARM_VISIT'], territoryCodes: ['WG'] })).res.statusCode).toBe(201);
    });

    it('If-Match guards concurrent edits; deactivation needs a reason', async () => {
      const e = data<Expert>((await newExpert()).res);
      const stale = await call(app, 'PATCH', `/calls/admin/experts/${e.id}`, {
        user: configurer,
        headers: { 'if-match': String(e.version + 1) },
        payload: { title: 'Area Manager' },
      });
      expect(stale.statusCode).toBe(409);
      expect(errorOf(stale).details?.reason).toBe('VERSION_MISMATCH');
      const ok = await call(app, 'PATCH', `/calls/admin/experts/${e.id}`, {
        user: configurer,
        headers: { 'if-match': `"${e.version}"` },
        payload: { title: 'Area Manager' },
      });
      expect(data<Expert>(ok).version).toBe(e.version + 1);
      const noReason = await call(app, 'PATCH', `/calls/admin/experts/${e.id}`, {
        user: configurer,
        payload: { isActive: false },
      });
      expect(noReason.statusCode).toBe(422);
    });

    it('lists with filters and cursor', async () => {
      const res = await call(app, 'GET', '/calls/admin/experts?type=VET&limit=1', { user: viewer });
      expect(res.statusCode).toBe(200);
      const body = res.json<{ data: Expert[]; meta: { nextCursor: string | null } }>();
      expect(body.data).toHaveLength(1);
      expect(body.data[0]?.type).toBe('VET');
    });
  });

  describe('availability, time-off, holidays (bump poolGen)', () => {
    it('validates and replaces the week; bumps version and poolGen', async () => {
      const e = data<Expert>((await newExpert()).res);
      const gens = app.diContainer.resolve('gens');
      const before = Number(await gens.poolGen());

      const overlap = await call(app, 'PUT', `/calls/admin/experts/${e.id}/availability`, {
        user: configurer,
        payload: { rules: [{ weekday: 1, startMinute: 540, endMinute: 780 }, { weekday: 1, startMinute: 700, endMinute: 900 }] },
      });
      expect(overlap.statusCode).toBe(422);

      const res = await call(app, 'PUT', `/calls/admin/experts/${e.id}/availability`, {
        user: configurer,
        payload: {
          rules: [
            { weekday: 1, startMinute: 540, endMinute: 780 },
            { weekday: 1, startMinute: 780, endMinute: 1080, channels: ['VIDEO'] },
          ],
          breaks: [{ weekday: null, startMinute: 780, endMinute: 840 }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(data<{ rules: unknown[]; breaks: unknown[] }>(res).rules).toHaveLength(2);
      expect(Number(await gens.poolGen())).toBeGreaterThan(before);
      const detail = data<Expert & { rules: unknown[] }>(
        await call(app, 'GET', `/calls/admin/experts/${e.id}`, { user: viewer }),
      );
      expect(detail.rules).toHaveLength(2);
      expect(detail.version).toBe(e.version + 1);
    });

    it('time-off: future only, list, remove', async () => {
      const e = data<Expert>((await newExpert()).res);
      const past = await call(app, 'POST', `/calls/admin/experts/${e.id}/time-off`, {
        user: configurer,
        payload: { startAt: '2020-01-01T00:00:00.000Z', endAt: '2020-01-02T00:00:00.000Z' },
      });
      expect(past.statusCode).toBe(422);
      const start = new Date(Date.now() + 86_400_000).toISOString();
      const end = new Date(Date.now() + 2 * 86_400_000).toISOString();
      const added = await call(app, 'POST', `/calls/admin/experts/${e.id}/time-off`, {
        user: configurer,
        payload: { startAt: start, endAt: end, reason: 'Leave' },
      });
      expect(added.statusCode).toBe(201);
      const list = data<{ id: string }[]>(await call(app, 'GET', `/calls/admin/experts/${e.id}/time-off`, { user: viewer }));
      expect(list).toHaveLength(1);
      const del = await call(app, 'DELETE', `/calls/admin/experts/${e.id}/time-off/${list[0]?.id ?? ''}`, { user: configurer });
      expect(del.statusCode).toBe(204);
    });

    it('holidays: duplicate date + territory → 409 (also for "everywhere")', async () => {
      const date = `2031-0${String(1 + Math.floor(Math.random() * 9))}-1${String(Math.floor(Math.random() * 9))}`;
      const first = await call(app, 'POST', '/calls/admin/holidays', { user: configurer, payload: { date, name: 'Sankranti' } });
      expect(first.statusCode).toBe(201);
      expect((await call(app, 'POST', '/calls/admin/holidays', { user: configurer, payload: { date, name: 'Again' } })).statusCode).toBe(409);
      expect(
        (await call(app, 'POST', '/calls/admin/holidays', { user: configurer, payload: { date, name: 'Local', territoryCode: 'WG' } }))
          .statusCode,
      ).toBe(201);
      const list = data<unknown[]>(await call(app, 'GET', `/calls/admin/holidays?from=${date}&to=${date}`, { user: viewer }));
      expect(list).toHaveLength(2);
    });
  });

  describe('expert self-service + presence + recommendation', () => {
    it('me, edit own presentation fields, heartbeat → online', async () => {
      const { res, userId } = await newExpert({ categoryIds: [ndCat] });
      const e = data<Expert>(res);
      const me = await call(app, 'GET', '/calls/experts/me', { user: userId });
      expect(me.statusCode).toBe(200);
      expect(data<{ online: boolean }>(me).online).toBe(false);
      const edit = await call(app, 'PATCH', '/calls/experts/me', { user: userId, payload: { title: 'Field Specialist' } });
      expect(edit.statusCode).toBe(200);
      const skills = await call(app, 'PATCH', '/calls/experts/me', { user: userId, payload: { brandIds: [brandId] } });
      expect(skills.statusCode).toBe(422);
      expect((await call(app, 'PUT', '/calls/experts/me/presence', { user: userId })).statusCode).toBe(200);
      expect(data<{ online: boolean }>(await call(app, 'GET', '/calls/experts/me', { user: userId })).online).toBe(true);
      expect((await call(app, 'DELETE', '/calls/experts/me/presence', { user: userId })).statusCode).toBe(204);
      expect(e.id).toBeTruthy();
    });

    it('recommends the brand rep first, online beats offline, VET shown as not bookable, never an assignment', async () => {
      const farmer = customer();
      const productId = addProduct({ brandId, categoryId: ndCat });
      const farmId = addFarm(farmer, ['LAYER']);

      const rep = await newExpert({ displayName: 'Brand Rep', brandIds: [brandId] });
      const vet = await newExpert({ type: 'VET', displayName: 'Dr. Vet', categoryIds: [rootCat], productionTypes: ['LAYER'] });
      await call(app, 'PUT', '/calls/experts/me/presence', { user: vet.userId });
      // Online VET (category ancestor + production type + online = 50) beats an OFFLINE brand rep (40)…
      const url = `/calls/experts/recommended?productId=${productId}&farmId=${farmId}`;
      const first = await call(app, 'GET', url, { user: farmer });
      expect(data<{ experts: { id: string }[] }>(first).experts[0]?.id).toBe(data<Expert>(vet.res).id);
      // …but once the brand rep is online too, brand wins (60 vs 50).
      await call(app, 'PUT', '/calls/experts/me/presence', { user: rep.userId });

      const res = await call(app, 'GET', `/calls/experts/recommended?productId=${productId}&farmId=${farmId}&limit=3`, {
        user: farmer,
      });
      expect(res.statusCode).toBe(200);
      const body = data<{ assignment: string; experts: { id: string; online: boolean; isBookable: boolean; matchedOn: string[] }[] }>(res);
      expect(body.assignment).toBe('RECOMMENDATION_ONLY');
      const ids = body.experts.map((x) => x.id);
      expect(ids[0]).toBe(data<Expert>(rep.res).id);
      const vetCard = body.experts.find((x) => x.id === data<Expert>(vet.res).id);
      expect(vetCard).toMatchObject({ online: true, isBookable: false, matchedOn: ['CATEGORY', 'PRODUCTION_TYPE'] });
      expect(Object.keys(body.experts[0] ?? {})).not.toContain('userId');
    });

    it('someone else\'s farm → 404; staff → 403; unknown product → 404', async () => {
      const farmer = customer();
      const productId = addProduct({ brandId, categoryId: ndCat });
      const othersFarm = addFarm(customer(), ['BROILER']);
      expect(
        (await call(app, 'GET', `/calls/experts/recommended?productId=${productId}&farmId=${othersFarm}`, { user: farmer })).statusCode,
      ).toBe(404);
      expect((await call(app, 'GET', `/calls/experts/recommended?productId=${productId}`, { user: viewer })).statusCode).toBe(403);
      expect(
        (await call(app, 'GET', `/calls/experts/recommended?productId=${randomUUID()}`, { user: farmer })).statusCode,
      ).toBe(404);
    });
  });

  describe('options + settings', () => {
    it('channels cannot be created; codes are unique; scored types need scoreWeight', async () => {
      expect(
        (await call(app, 'POST', '/calls/admin/options', { user: configurer, payload: { type: 'CHANNEL', code: 'CHAT', label: 'Chat' } }))
          .statusCode,
      ).toBe(422);
      expect(
        (await call(app, 'POST', '/calls/admin/options', { user: configurer, payload: { type: 'INTENT', code: 'X_NOWEIGHT', label: 'X' } }))
          .statusCode,
      ).toBe(422);
      const code = `STOCK_${randomUUID().slice(0, 6).toUpperCase()}`;
      const payload = { type: 'INTENT', code, label: 'Stock & delivery date', meta: { scoreWeight: 5 } };
      expect((await call(app, 'POST', '/calls/admin/options', { user: configurer, payload })).statusCode).toBe(201);
      expect((await call(app, 'POST', '/calls/admin/options', { user: configurer, payload })).statusCode).toBe(409);
    });

    it('the last active LANGUAGE cannot be turned off', async () => {
      const langs = data<{ id: string; code: string; isActive: boolean }[]>(
        await call(app, 'GET', '/calls/admin/options?type=LANGUAGE', { user: viewer }),
      ).filter((l) => l.isActive);
      const reason = 'Testing the last-active guard';
      const toggled: string[] = [];
      for (const lang of langs.slice(0, -1)) {
        const r = await call(app, 'PATCH', `/calls/admin/options/${lang.id}`, { user: configurer, payload: { isActive: false, reason } });
        expect(r.statusCode).toBe(200);
        toggled.push(lang.id);
      }
      const last = langs.at(-1);
      const blocked = await call(app, 'PATCH', `/calls/admin/options/${last?.id ?? ''}`, {
        user: configurer,
        payload: { isActive: false, reason },
      });
      expect(blocked.statusCode).toBe(409);
      expect(errorOf(blocked).details?.reason).toBe('LAST_ACTIVE_OPTION');
      for (const id of toggled)
        await call(app, 'PATCH', `/calls/admin/options/${id}`, { user: configurer, payload: { isActive: true } });
    });

    it('settings: per-key validation (422 with paths), update refreshes the snapshot + poolGen', async () => {
      const bad = await call(app, 'PUT', '/calls/admin/settings/slotMinutes', {
        user: configurer,
        payload: { value: { VIDEO: 5, PHONE: 30 }, reason: 'Testing validation of slots' },
      });
      expect(bad.statusCode).toBe(422);
      expect(errorOf(bad).details?.issues?.map((i) => i.path)).toEqual(['value.VIDEO', 'value.FARM_VISIT']);

      const options = app.diContainer.resolve('optionsService');
      const gens = app.diContainer.resolve('gens');
      expect((await options.settings()).slotMinutes.FARM_VISIT).toBe(60);
      const before = Number(await gens.poolGen());
      const good = await call(app, 'PUT', '/calls/admin/settings/slotMinutes', {
        user: configurer,
        payload: { value: { VIDEO: 30, PHONE: 30, FARM_VISIT: 90 }, reason: 'Farm visits need longer slots' },
      });
      expect(good.statusCode).toBe(200);
      expect((await options.settings()).slotMinutes.FARM_VISIT).toBe(90);
      expect(Number(await gens.poolGen())).toBeGreaterThan(before);
      await call(app, 'PUT', '/calls/admin/settings/slotMinutes', {
        user: configurer,
        payload: { value: { VIDEO: 30, PHONE: 30, FARM_VISIT: 60 }, reason: 'Restore the default slot' },
      });
    });
  });

  it('Swagger lists every route with docs', async () => {
    const spec = (await call(app, 'GET', '/api-docs.json')).json<{ paths: Record<string, unknown> }>();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/calls/experts/recommended',
        '/calls/experts/me/presence',
        '/calls/admin/experts/{id}/availability',
        '/calls/admin/holidays',
        '/calls/admin/settings/{key}',
      ]),
    );
  });
});
