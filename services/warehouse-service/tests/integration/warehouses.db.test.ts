import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  errorOf,
  grantAt,
  outbox,
  prepareSetup,
  randomCode,
  randomPinBase,
  staff,
} from './harness.js';

interface Warehouse {
  id: string;
  code: string;
  status: string;
  version: number;
  coverageVersion: number;
  parentWarehouseId: string | null;
  reviewFields: string[];
  setup: { done: number; total: number };
}
interface Areas {
  coverageVersion: number;
  summary: { districts: number; pinCodes: number; unassignedPins: number; defaultPriority: string };
  areas: { id: string; kind: string; district: string | null; pinCount: number }[];
}

const CENTRAL = [
  'warehouse.view',
  'warehouse.create',
  'warehouse.configure',
  'warehouse.status_change',
];
let app: FastifyInstance;
const created: string[] = [];
const admin = staff(CENTRAL);

const depot = (o: Record<string, unknown> = {}) => ({
  code: randomCode('it'),
  name: 'IT C&F Depot',
  type: 'DEPOT',
  managerUserId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
  phone: '9876543210',
  addressLine: 'Plot 4, Industrial Estate',
  city: 'Tanuku',
  district: 'West Godavari',
  stateCode: '37',
  pinCode: '534211',
  capacity: { value: 50, unit: 'TONNES' },
  temperatureClasses: ['AMB', 'CC_REF'],
  ...o,
});

const create = async (o: Record<string, unknown> = {}) => {
  const res = await call(app, 'POST', '/admin/warehouses', admin, depot(o));
  expect(res.statusCode, res.body).toBe(201);
  const w = data<Warehouse>(res);
  created.push(w.id);
  return w;
};

const areasOf = async (id: string, user = admin) =>
  data<Areas>(await call(app, 'GET', `/admin/warehouses/${id}/service-areas`, user));

describe.skipIf(DB_URL === undefined)('warehouse-service against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    // Drafts and test warehouses are soft-deleted so they never count as a live central.
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.updateMany({ where: { id: { in: created } }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('creates a SETUP draft (kg from tonnes, +91 phone, upper-case code) and emits it', async () => {
    const w = await create({ code: randomCode('it').toLowerCase() });
    expect(w).toMatchObject({ status: 'SETUP', version: 0, coverageVersion: 0 });
    const full = data(await call(app, 'GET', `/admin/warehouses/${w.id}`, admin));
    expect(full).toMatchObject({ capacityKg: '50000.00', phone: '+919876543210' });
    expect(w.code).toBe(w.code.toUpperCase());
    const events = await outbox(app, 'warehouse.upserted.v1', w.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'SETUP', version: 0, deleted: false });

    const dup = await call(app, 'POST', '/admin/warehouses', admin, depot({ code: w.code }));
    expect(dup.statusCode).toBe(409);
    expect(errorOf(dup).details?.reason).toBe('DUPLICATE_CODE');
    const free = await call(
      app,
      'GET',
      `/admin/warehouses/code-availability?code=${w.code}`,
      admin,
    );
    expect(data(free)).toEqual({ code: w.code, available: false });
  });

  it('allows one live central warehouse; a depot defaults to it as parent', async () => {
    const db = app.diContainer.resolve('db');
    const live = await db.wmsWarehouse.findFirst({
      where: { type: 'MOTHER', deletedAt: null, status: { not: 'INACTIVE' } },
    });
    const mother = live ?? (await create({ type: 'MOTHER', name: 'IT Central' }));
    const second = await call(app, 'POST', '/admin/warehouses', admin, depot({ type: 'MOTHER' }));
    expect(second.statusCode).toBe(409);
    expect(errorOf(second).details?.reason).toBe('CENTRAL_EXISTS');
    const d = await create();
    expect(d.parentWarehouseId).toBe(mother.id);
  });

  it('service areas: ranges, version check, one area per PIN, full coverage event', async () => {
    const w = await create();
    const base = randomPinBase();
    const add = await call(app, 'POST', `/admin/warehouses/${w.id}/service-areas`, admin, {
      expectedVersion: 0,
      stateCode: '37',
      district: 'West Godavari',
      priority: 'HIGH',
      pins: [`${String(base + 1)}-${String(base + 5)}`, String(base + 9)],
    });
    expect(add.statusCode, add.body).toBe(201);
    const view = data<Areas>(add);
    expect(view.coverageVersion).toBe(1);
    expect(view.summary).toMatchObject({ districts: 1, pinCodes: 6, defaultPriority: 'HIGH' });

    const stale = await call(app, 'POST', `/admin/warehouses/${w.id}/service-areas`, admin, {
      expectedVersion: 0,
      stateCode: '37',
      district: 'Eluru',
      priority: 'LOW',
      pins: [String(base + 20)],
    });
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).details?.reason).toBe('VERSION_CONFLICT');

    const taken = await call(app, 'POST', `/admin/warehouses/${w.id}/service-areas`, admin, {
      expectedVersion: 1,
      stateCode: '37',
      district: 'Eluru',
      priority: 'LOW',
      pins: [String(base + 3)],
    });
    expect(taken.statusCode).toBe(409);
    expect(errorOf(taken).details?.reason).toBe('PIN_TAKEN');

    const coverage = await outbox(app, 'warehouse.coverage_replaced.v1', w.id);
    expect(coverage).toHaveLength(1);
    expect(coverage[0]).toMatchObject({ coverageVersion: 1 });
    expect((coverage[0]?.entries as unknown[]).length).toBe(6);

    const preview = await call(app, 'GET', `/admin/warehouses/coverage/${String(base + 2)}`, admin);
    expect(
      data<{ warehouseId: string; priorityRank: number; routable: boolean }[]>(preview),
    ).toEqual([expect.objectContaining({ warehouseId: w.id, priorityRank: 10, routable: false })]);

    // Editing the priority re-ranks the area's PINs.
    const areaId = view.areas[0]?.id ?? '';
    await call(app, 'PATCH', `/admin/warehouses/${w.id}/service-areas/${areaId}`, admin, {
      expectedVersion: 1,
      priority: 'LOW',
      removePins: [String(base + 9)],
    });
    const after = await areasOf(w.id);
    expect(after).toMatchObject({
      coverageVersion: 2,
      summary: { pinCodes: 5, defaultPriority: 'LOW' },
    });
  });

  it('activation needs the checklist, then routes; limit needs a reason', async () => {
    const w = await create();
    const early = await call(app, 'POST', `/admin/warehouses/${w.id}/activate`, admin, {
      expectedVersion: 0,
    });
    expect(early.statusCode).toBe(422);
    expect(JSON.stringify(errorOf(early).details?.issues)).toContain('setup.serviceArea');

    const base = randomPinBase();
    await call(app, 'POST', `/admin/warehouses/${w.id}/service-areas`, admin, {
      expectedVersion: 0,
      stateCode: '37',
      district: 'West Godavari',
      priority: 'MEDIUM',
      pins: [String(base + 1)],
    });
    const notYet = await call(app, 'POST', `/admin/warehouses/${w.id}/activate`, admin, {
      expectedVersion: 0,
    });
    expect(JSON.stringify(errorOf(notYet).details?.issues)).toContain('setup.storage');
    await prepareSetup(app, admin, w.id);
    const on = await call(app, 'POST', `/admin/warehouses/${w.id}/activate`, admin, {
      expectedVersion: 0,
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(data<Warehouse>(on)).toMatchObject({ status: 'ACTIVE', version: 1 });

    const noReason = await call(app, 'POST', `/admin/warehouses/${w.id}/limit`, admin, {
      expectedVersion: 1,
    });
    expect(noReason.statusCode).toBe(422);
    const limited = await call(app, 'POST', `/admin/warehouses/${w.id}/limit`, admin, {
      expectedVersion: 1,
      reason: 'Cold room under maintenance',
    });
    expect(data<Warehouse>(limited).status).toBe('LIMITED');
    const bad = await call(app, 'POST', `/admin/warehouses/${w.id}/activate`, admin, {
      expectedVersion: 2,
    });
    expect(errorOf(bad).details?.reason).toBe('INVALID_TRANSITION');
    const statuses = (await outbox(app, 'warehouse.upserted.v1', w.id)).map((e) => e.status);
    expect(statuses).toEqual(['SETUP', 'ACTIVE', 'LIMITED']);
  });

  it('warehouse-scoped staff see only their warehouses (others 404, drafts hidden)', async () => {
    const mine = await create();
    const other = await create();
    const draft = await create();
    for (const w of [mine, other]) {
      await call(app, 'POST', `/admin/warehouses/${w.id}/service-areas`, admin, {
        expectedVersion: 0,
        stateCode: '37',
        district: 'West Godavari',
        priority: 'HIGH',
        pins: [String(randomPinBase() + 1)],
      });
      await prepareSetup(app, admin, w.id);
      await call(app, 'POST', `/admin/warehouses/${w.id}/activate`, admin, { expectedVersion: 0 });
    }
    const manager = staff([]);
    grantAt(manager, mine.id, ['warehouse.view', 'warehouse.configure']);
    grantAt(manager, draft.id, ['warehouse.view']);

    const list = data<{ id: string }[]>(
      await call(app, 'GET', '/admin/warehouses?limit=100', manager),
    );
    expect(list.map((w) => w.id)).toEqual([mine.id]);
    expect((await call(app, 'GET', `/admin/warehouses/${other.id}`, manager)).statusCode).toBe(404);
    expect((await call(app, 'GET', `/admin/warehouses/${draft.id}`, manager)).statusCode).toBe(404);
    const edit = await call(app, 'PATCH', `/admin/warehouses/${other.id}`, manager, {
      expectedVersion: 1,
      name: 'Hijack',
    });
    expect(edit.statusCode).toBe(404);
    const status = await call(app, 'POST', `/admin/warehouses/${mine.id}/limit`, manager, {
      expectedVersion: 1,
      reason: 'not allowed for a manager',
    });
    expect(status.statusCode).toBe(403);
    const me = data<{ warehouses: { id: string; permissions: string[] }[]; canSeeAll: boolean }>(
      await call(app, 'GET', '/admin/wms/me', manager),
    );
    expect(me.canSeeAll).toBe(false);
    expect(me.warehouses.map((w) => w.id)).toEqual([mine.id]);
    expect(me.warehouses[0]?.permissions).toEqual(['warehouse.configure', 'warehouse.view']);
  });

  it('imported PINs keep their rank until moved to a district (explicit, audited)', async () => {
    const w = await create();
    const db = app.diContainer.resolve('db');
    const base = randomPinBase();
    // What the D-56 migration produces: an IMPORTED area with the old exact priorities.
    const area = await db.wmsServiceArea.create({
      data: { warehouseId: w.id, kind: 'IMPORTED', pinCount: 2 },
    });
    await db.wmsServiceAreaPin.createMany({
      data: [
        { warehouseId: w.id, pinCode: String(base + 1), areaId: area.id, priorityRank: 7 },
        { warehouseId: w.id, pinCode: String(base + 2), areaId: area.id, priorityRank: 100 },
      ],
    });
    const before = await areasOf(w.id);
    expect(before.summary).toMatchObject({ unassignedPins: 2, districts: 0 });

    const moved = await call(
      app,
      'POST',
      `/admin/warehouses/${w.id}/service-areas/${area.id}/reassign`,
      admin,
      { expectedVersion: 0, all: true, stateCode: '37', district: 'Eluru', priority: 'HIGH' },
    );
    expect(moved.statusCode, moved.body).toBe(200);
    const after = data<Areas>(moved);
    expect(after.summary).toMatchObject({ unassignedPins: 0, districts: 1, pinCodes: 2 });
    expect(after.areas.map((a) => a.kind)).toEqual(['DISTRICT']);
    const event = (await outbox(app, 'warehouse.coverage_replaced.v1', w.id)).at(-1);
    expect(event?.entries).toEqual([
      { pinCode: String(base + 1), priority: 10 },
      { pinCode: String(base + 2), priority: 10 },
    ]);
  });

  it('confirming imported fields clears the review list', async () => {
    const w = await create();
    await app.diContainer.resolve('db').wmsWarehouse.update({
      where: { id: w.id },
      data: { reviewFields: ['district', 'temperatureClasses'], importedAt: new Date() },
    });
    const res = await call(app, 'PATCH', `/admin/warehouses/${w.id}`, admin, {
      expectedVersion: 0,
      district: 'West Godavari',
      confirm: ['temperatureClasses'],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(data<Warehouse>(res).reviewFields).toEqual([]);
  });

  it('summary, lookups, districts, search, export and discard', async () => {
    const w = await create({ name: 'Zeta Searchable Depot' });
    const summary = data<{ total: number }>(
      await call(app, 'GET', '/admin/warehouses/summary', admin),
    );
    expect(summary.total).toBeGreaterThan(0);
    const lookups = data<{ states: unknown[] }>(
      await call(app, 'GET', '/admin/warehouses/lookups', admin),
    );
    expect(lookups.states).toHaveLength(36);
    const districts = data<string[]>(
      await call(app, 'GET', '/admin/warehouses/lookups/districts?stateCode=37', admin),
    );
    expect(districts).toContain('West Godavari');
    const search = data<{ warehouseId: string }[]>(
      await call(app, 'GET', '/admin/wms/search?q=zeta%20searchable', admin),
    );
    expect(search.map((r) => r.warehouseId)).toContain(w.id);

    const csv = await call(app, 'GET', '/admin/warehouses/export.csv?q=zeta', admin);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain('Zeta Searchable Depot');

    const gone = await call(app, 'DELETE', `/admin/warehouses/${w.id}?expectedVersion=0`, admin);
    expect(gone.statusCode).toBe(204);
    expect((await call(app, 'GET', `/admin/warehouses/${w.id}`, admin)).statusCode).toBe(404);
    expect((await outbox(app, 'warehouse.upserted.v1', w.id)).at(-1)).toMatchObject({
      deleted: true,
    });
  });

  it('refuses callers without a staff token or without the permission', async () => {
    expect((await call(app, 'GET', '/admin/warehouses')).statusCode).toBe(401);
    const nobody = staff([]);
    expect((await call(app, 'GET', '/admin/warehouses', nobody)).statusCode).toBe(403);
    const viewer = staff(['warehouse.view']);
    expect((await call(app, 'POST', '/admin/warehouses', viewer, depot())).statusCode).toBe(403);
  });
});
