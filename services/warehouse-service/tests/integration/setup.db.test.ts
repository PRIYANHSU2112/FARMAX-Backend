import { createHmac } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  INTERNAL_TOKEN,
  TEMPLATE,
  WEEK,
  buildTestApp,
  call,
  data,
  errorOf,
  randomCode,
  staff,
} from './harness.js';
import { isOverlapViolation } from '../../src/features/docks/docks.service.js';

/** Setup screens (D-56 P2): storage, dock & yard, calendar, storage rules, team. */
const CENTRAL = [
  'warehouse.view',
  'warehouse.create',
  'warehouse.configure',
  'warehouse.operate',
  'warehouse.status_change',
  'warehouse.team_manage',
];
let app: FastifyInstance;
let w = '';
const admin = staff(CENTRAL);
const base = () => `/admin/warehouses/${w}`;

/** A media-service receipt (same format and secret media-service uses). */
const receipt = (uploaderId: string, purpose = 'staff_document') => {
  const body = Buffer.from(
    JSON.stringify({
      purpose,
      key: `test/staff/${randomCode('k')}.pdf`,
      uploaderId,
      kind: 'document',
      mime: 'application/pdf',
      size: 2048,
      fileName: 'id.pdf',
      scanStatus: 'CLEAN',
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', INTERNAL_TOKEN).update(body).digest('base64url')}`;
};

describe.skipIf(DB_URL === undefined)('warehouse setup screens against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const res = await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('it'),
      name: 'IT Setup Depot',
      type: 'DEPOT',
      addressLine: 'Plot 9, Industrial Estate',
      city: 'Eluru',
      district: 'Eluru',
      stateCode: '37',
      pinCode: '534001',
      temperatureClasses: ['AMB', 'CC_REF'],
    });
    w = data<{ id: string }>(res).id;
  });

  afterAll(async () => {
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.update({ where: { id: w }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('storage: zone → rack with auto bins; bins never exceed the rack', async () => {
    const zone = data<{ id: string; version: number }>(
      await call(app, 'POST', `${base()}/zones`, admin, {
        code: 'b',
        name: 'Seeds',
        temperatureClass: 'CC_REF',
        minTempC: 2,
        maxTempC: 8,
      }),
    );
    const rackRes = await call(app, 'POST', `${base()}/zones/${zone.id}/racks`, admin, {
      maxWeightKg: 3500,
      volumeM3: 12,
      generateBins: { count: 3, maxWeightKg: 1000, volumeM3: 2.5 },
    });
    expect(rackRes.statusCode, rackRes.body).toBe(201);
    const rack = data<{
      id: string;
      code: string;
      binCount: number;
      availableVolumeM3: string;
      availablePct: number;
    }>(rackRes);
    expect(rack).toMatchObject({
      code: 'B-01',
      binCount: 3,
      availableVolumeM3: '4.500',
      availablePct: 37.5,
    });

    const tooMuch = await call(app, 'POST', `${base()}/racks/${rack.id}/bins`, admin, {
      count: 1,
      maxWeightKg: 10,
      volumeM3: 5,
    });
    expect(errorOf(tooMuch).details?.reason).toBe('RACK_CAPACITY_EXCEEDED');

    const more = await call(app, 'POST', `${base()}/racks/${rack.id}/bins`, admin, {
      bins: [{ maxWeightKg: 0.01, volumeM3: 1 }],
    });
    expect(more.statusCode, more.body).toBe(201);
    expect(data<{ code: string }[]>(more)[0]?.code).toBe('B-01-04');

    const bins = await call(app, 'GET', `${base()}/bins?rackId=${rack.id}&limit=2`, admin);
    expect(data<unknown[]>(bins)).toHaveLength(2);
    expect(bins.json<{ meta: { nextCursor: string } }>().meta.nextCursor).toBe('B-01-02');

    const layout = data<{ zones: { code: string; racks: { bins: unknown[] }[] }[] }>(
      await call(app, 'GET', `${base()}/storage/layout`, admin),
    );
    expect(layout.zones.find((z) => z.code === 'B')?.racks[0]?.bins).toHaveLength(4);
    const busy = await call(app, 'DELETE', `${base()}/zones/${zone.id}`, admin);
    expect(errorOf(busy).details?.reason).toBe('NOT_EMPTY');
  });

  it('docks: no double booking, busy door, capacity per unit (never added)', async () => {
    const door = data<{ id: string; version: number }>(
      await call(app, 'POST', `${base()}/dock-doors`, admin, {
        code: 'D1',
        name: 'Door 1',
        type: 'UNLOADING',
        vehicleClass: 'TRUCK',
        capacityPerDay: 40,
        capacityUnit: 'TONNES',
      }),
    );
    await call(app, 'POST', `${base()}/dock-doors`, admin, {
      code: 'D2',
      name: 'Door 2',
      type: 'BOTH',
      vehicleClass: 'ANY',
      capacityPerDay: 60,
      capacityUnit: 'PALLETS',
    });
    const start = new Date(Date.now() + 60_000);
    const end = new Date(start.getTime() + 3600_000);
    const booked = await call(app, 'POST', `${base()}/dock-doors/${door.id}/bookings`, admin, {
      refNo: 'INB-1045',
      direction: 'INBOUND',
      loadQty: 8,
      plannedStart: start.toISOString(),
      plannedEnd: end.toISOString(),
    });
    expect(booked.statusCode, booked.body).toBe(201);
    const clash = await call(app, 'POST', `${base()}/dock-doors/${door.id}/bookings`, admin, {
      refNo: 'INB-1046',
      direction: 'INBOUND',
      loadQty: 5,
      plannedStart: new Date(start.getTime() + 600_000).toISOString(),
      plannedEnd: end.toISOString(),
    });
    expect(errorOf(clash).details?.reason).toBe('DOCK_BUSY');
    const wrongWay = await call(app, 'POST', `${base()}/dock-doors/${door.id}/bookings`, admin, {
      refNo: 'OUT-1',
      direction: 'OUTBOUND',
      loadQty: 1,
      plannedStart: new Date(end.getTime() + 60_000).toISOString(),
      plannedEnd: new Date(end.getTime() + 120_000).toISOString(),
    });
    expect(wrongWay.statusCode).toBe(422);

    const bookingId = data<{ id: string }>(booked).id;
    await call(app, 'POST', `${base()}/dock-bookings/${bookingId}/start`, admin);
    const doors = data<
      { code: string; displayStatus: string; currentUse: { refNo: string } | null }[]
    >(await call(app, 'GET', `${base()}/dock-doors`, admin));
    expect(doors.find((d) => d.code === 'D1')).toMatchObject({
      displayStatus: 'BUSY',
      currentUse: { refNo: 'INB-1045' },
    });

    const unit = await call(app, 'PATCH', `${base()}/dock-doors/${door.id}`, admin, {
      expectedVersion: door.version,
      capacityUnit: 'PALLETS',
    });
    expect(errorOf(unit).details?.reason).toBe('DOOR_HAS_BOOKINGS');

    const summary = data<{
      doors: { busy: number };
      unloadingCapacity: { unit: string; total: string; used: string }[];
    }>(await call(app, 'GET', `${base()}/dock-yard`, admin));
    expect(summary.doors.busy).toBe(1);
    expect(summary.unloadingCapacity).toEqual([
      expect.objectContaining({ unit: 'PALLETS', total: '60.00' }),
      expect.objectContaining({ unit: 'TONNES', total: '40.00', used: '8.00' }),
    ]);
    await call(app, 'POST', `${base()}/dock-bookings/${bookingId}/complete`, admin);

    // The database itself refuses an overlap that slips past the locked pre-check (a race).
    const repo = app.diContainer.resolve('docksRepository');
    const run = app.diContainer.resolve('runInTransaction');
    const later = new Date(end.getTime() + 2 * 3600_000);
    const row = {
      warehouseId: w,
      dockDoorId: door.id,
      direction: 'INBOUND' as const,
      refNo: 'RACE-1',
      loadQty: 1,
      loadUnit: 'TONNES' as const,
      plannedStart: later,
      plannedEnd: new Date(later.getTime() + 3600_000),
    };
    await run((tx) => repo.createBooking(tx, row));
    const race: unknown = await run((tx) =>
      repo.createBooking(tx, { ...row, refNo: 'RACE-2' }),
    ).catch((error: unknown) => error);
    expect(isOverlapViolation(race)).toBe(true);

    const slot = data<{ id: string }>(
      await call(app, 'POST', `${base()}/yard-slots`, admin, { code: 'Y1' }),
    );
    const occupied = await call(app, 'POST', `${base()}/yard-slots/${slot.id}/occupy`, admin, {
      vehicleNo: 'ap 37 bc 2210',
    });
    expect(data(occupied)).toMatchObject({ status: 'OCCUPIED', occupiedByRef: 'AP 37 BC 2210' });
    const again = await call(app, 'POST', `${base()}/yard-slots/${slot.id}/occupy`, admin, {
      vehicleNo: 'AP 01 X 1',
    });
    expect(errorOf(again).details?.reason).toBe('INVALID_TRANSITION');
    await call(app, 'POST', `${base()}/yard-slots/${slot.id}/release`, admin);
    const staging = await call(app, 'POST', `${base()}/staging-areas`, admin, {
      name: 'Inbound A',
      kind: 'INBOUND',
      capacityPallets: 100,
    });
    expect(staging.statusCode).toBe(201);
  });

  it('calendar: hours, shifts (break inside), holidays, cut-offs in one view', async () => {
    await call(app, 'PUT', `${base()}/operating-hours`, admin, { days: WEEK });
    const badBreak = await call(app, 'POST', `${base()}/shifts`, admin, {
      name: 'Morning',
      startsAt: '06:00',
      endsAt: '14:00',
      breakStartsAt: '15:00',
      breakEndsAt: '15:30',
      isoDays: [1, 2, 3],
    });
    expect(badBreak.statusCode).toBe(422);
    const night = await call(app, 'POST', `${base()}/shifts`, admin, {
      name: 'Night',
      startsAt: '22:00',
      endsAt: '06:00',
      overnight: true,
      breakStartsAt: '02:00',
      breakEndsAt: '02:30',
      isoDays: [1, 2, 3, 4, 5, 6, 7],
    });
    expect(night.statusCode, night.body).toBe(201);
    const limited = await call(app, 'POST', `${base()}/holidays`, admin, {
      date: '2099-01-26',
      name: 'Republic Day',
      mode: 'LIMITED',
      limitedFrom: '08:00',
      limitedTo: '14:00',
    });
    expect(limited.statusCode).toBe(201);
    await call(app, 'PUT', `${base()}/cutoffs`, admin, {
      cutoffs: [
        { type: 'SAME_DAY_STANDARD', cutoffTime: '17:00' },
        { type: 'SAME_DAY_COLD', cutoffTime: '15:00' },
      ],
    });
    const cal = data<{
      operatingHours: { isOpen: boolean }[];
      shifts: unknown[];
      upcomingHolidays: { count: number; next: { name: string } };
      cutoffs: { type: string; cutoffTime: string | null }[];
    }>(await call(app, 'GET', `${base()}/calendar`, admin));
    expect(cal.operatingHours.filter((d) => d.isOpen)).toHaveLength(6);
    expect(cal.shifts).toHaveLength(1);
    expect(cal.upcomingHolidays).toMatchObject({ count: 1, next: { name: 'Republic Day' } });
    expect(cal.cutoffs).toEqual([
      { type: 'SAME_DAY_STANDARD', cutoffTime: '17:00' },
      { type: 'SAME_DAY_COLD', cutoffTime: '15:00' },
      { type: 'NEXT_DAY', cutoffTime: null },
    ]);
  });

  it('storage rules: saved NOT_ENFORCED, a same-zone conflict needs review', async () => {
    const feed = '0193a5f2-7c1e-7b2a-9f00-00000000c001';
    const chem = '0193a5f2-7c1e-7b2a-9f00-00000000c002';
    await call(app, 'POST', `${base()}/zones`, admin, {
      code: 'MIX',
      name: 'Mixed',
      temperatureClass: 'AMB',
      productCategoryIds: [feed, chem],
    });
    const created = await call(app, 'POST', `${base()}/storage-rules`, admin, {
      type: 'SEGREGATION',
      name: 'Chemical separation',
      subjectCategoryIds: [chem],
      keepAwayCategoryIds: [feed],
      minDistance: 10,
      minDistanceUnit: 'FEET',
    });
    expect(created.statusCode, created.body).toBe(201);
    expect(data(created)).toMatchObject({
      enforcement: 'NOT_ENFORCED',
      minDistanceM: '3.05',
      warnings: [expect.objectContaining({ code: 'SAME_ZONE_CONFLICT' })],
    });
    const noZone = await call(app, 'POST', `${base()}/storage-rules`, admin, {
      type: 'FOOD_GRADE_ZONE',
      name: 'Food grade',
      subjectCategoryIds: [feed],
    });
    expect(noZone.statusCode).toBe(422);
    const summary = data(await call(app, 'GET', `${base()}/storage-rules/summary`, admin));
    expect(summary).toMatchObject({
      activeRules: 1,
      restrictedItems: 1,
      itemsNeedingReview: 1,
      enforcement: 'NOT_ENFORCED',
    });
  });

  it('team: invite, documents complete, read-only roles panel, remove', async () => {
    const added = await call(app, 'POST', `${base()}/team`, admin, {
      fullName: 'Pooja Verma',
      email: 'pooja.it@farmx.in',
      phone: '9876543210',
      roleId: TEMPLATE.id,
      workAreas: ['RECEIVING'],
    });
    expect(added.statusCode, added.body).toBe(201);
    const m = data<{ userId: string; status: string; documentStatus: string; phone: string }>(
      added,
    );
    expect(m).toMatchObject({
      status: 'ACTIVE',
      documentStatus: 'PENDING',
      phone: '+919876543210',
    });

    const forged = await call(app, 'PUT', `${base()}/team/${m.userId}/documents`, admin, {
      docType: 'ID_PROOF',
      receipt: receipt(admin, 'support'),
    });
    expect(forged.statusCode).toBe(422);
    for (const docType of ['ID_PROOF', 'ADDRESS_PROOF', 'PHOTO'])
      await call(app, 'PUT', `${base()}/team/${m.userId}/documents`, admin, {
        docType,
        receipt: receipt(admin),
      });
    const list = data<{ userId: string; documentStatus: string }[]>(
      await call(app, 'GET', `${base()}/team`, admin),
    );
    expect(list.find((x) => x.userId === m.userId)?.documentStatus).toBe('COMPLETE');

    const roles = data<{ editable: boolean; roles: { modules: Record<string, boolean> }[] }>(
      await call(app, 'GET', '/admin/warehouses/team/roles', admin),
    );
    expect(roles.editable).toBe(false);
    expect(roles.roles[0]?.modules).toMatchObject({ PICKING: true, RECEIVING: false });

    const removed = await call(app, 'DELETE', `${base()}/team/${m.userId}`, admin, {
      reason: 'moved to Tanuku',
    });
    expect(data(removed)).toMatchObject({ status: 'INACTIVE' });
  });

  it('activation now needs storage and hours; this warehouse has both', async () => {
    const w0 = data<{ setup: { steps: { key: string; done: boolean }[] } }>(
      await call(app, 'GET', base(), admin),
    );
    const done = Object.fromEntries(w0.setup.steps.map((s) => [s.key, s.done]));
    expect(done).toMatchObject({ storage: true, calendar: true });
  });
});
