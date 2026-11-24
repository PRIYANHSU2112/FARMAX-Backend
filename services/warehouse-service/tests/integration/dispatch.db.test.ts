import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  deliver,
  errorOf,
  inventoryCutover,
  orderService,
  outbox,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-57b Phase 4a: route master, fleet, trips, weighbridge, gate-out (issue), pings, W3.08, W3.19. */
let app: FastifyInstance;
const ALL = [
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'inventory.pick',
  'quality.hold_release',
  'fulfilment.view',
  'fulfilment.manage',
  'logistics.fleet_manage',
  'logistics.dispatch_assign',
  'logistics.consignment_view',
];
const admin = staff(ALL);
const A = randomUUID();
const TAG = randomUUID().slice(0, 4).toUpperCase();
const PIN = '534007';
let W = '';
let bins: string[] = [];
let doorId = '';

const facts = (variantId: string) => ({
  variantId,
  productId: randomUUID(),
  sku: `DP-${variantId.slice(0, 4)}`,
  barcode: null,
  productName: 'Broiler Starter 50 kg',
  variantName: 'Broiler Starter 50 kg',
  manufacturerName: null,
  packSize: '50.000',
  packUnit: 'KG',
  isPrescriptionRequired: false,
  temperatureClass: 'AMB',
  shelfLifeMonths: 12,
  isActive: true,
  categoryId: randomUUID(),
  categoryPath: [randomUUID()],
  brandId: randomUUID(),
  brandName: 'NutriFarm',
  hsnCode: '2309',
  gstRate: '5.00',
  weightGrams: 50_000,
  minOrderQty: 1,
  maxOrderQty: null,
  version: 1,
});

/** An order of `qty` A, taken all the way to READY_TO_DISPATCH. */
const readyShipment = async (qty: number) => {
  const orderId = randomUUID();
  const orderNo = `ORD-26-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const reservationId = randomUUID();
  orderService.facts.set(orderId, {
    orderId,
    orderNo,
    userId: randomUUID(),
    farmId: randomUUID(),
    channel: 'APP',
    status: 'CONFIRMED',
    fulfilmentStage: null,
    paymentStatus: 'PAID',
    paymentMethod: 'ONLINE',
    refundStatus: 'NONE',
    customerPoRef: null,
    deliveryPromise: null,
    placedAt: new Date().toISOString(),
    paidAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(),
    totals: { grandTotal: '500.00' },
    customer: {
      name: 'Sita Devi',
      phone: '+919999911111',
      farmName: 'Devi Farms',
      farmCode: 'FARM-77',
      gstin: null,
    },
    shipTo: {
      name: 'Sita Devi',
      phone: '+919999911111',
      line1: 'Plot 4',
      line2: null,
      landmark: null,
      village: 'Bhimadole',
      mandal: null,
      district: 'Eluru',
      stateCode: '37',
      pinCode: PIN,
      latitude: 16.8,
      longitude: 81.26,
      formatted: 'Plot 4, Bhimadole',
    },
    lines: [
      {
        lineNo: 1,
        variantId: A,
        productId: randomUUID(),
        sku: 'DP',
        name: 'Broiler Starter',
        temperatureClass: 'AMB',
        qty,
        cancelledQty: 0,
        unitPrice: '50.00',
        lineTotal: (50 * qty).toFixed(2),
      },
    ],
    payment: {
      method: 'ONLINE',
      instrument: 'upi',
      providerRefMasked: '••••9876',
      capturedAt: new Date().toISOString(),
    },
    version: 1,
  });
  await deliver(app, 'order.placed.v1', {
    orderId,
    orderNo,
    userId: randomUUID(),
    farmId: randomUUID(),
    grandTotal: '500.00',
    paymentDueAt: new Date().toISOString(),
    shipTo: { name: 'Sita Devi', district: 'Eluru', pinCode: PIN },
  });
  await deliver(app, 'order.paid.v1', {
    orderId,
    orderNo,
    reservationId,
    paymentId: randomUUID(),
    amount: '500.00',
  });
  await deliver(app, 'inventory.reservation_committed.v1', {
    reservationId,
    orderRef: orderId,
    recovered: false,
    lines: [{ warehouseId: W, variantId: A, qty }],
  });
  await deliver(app, 'order.confirmed.v1', {
    orderId,
    orderNo,
    reservationId,
    confirmedAt: new Date().toISOString(),
    lines: [{ lineNo: 1, variantId: A, qty }],
  });
  const [s] = await app.diContainer.resolve('fulfilmentRepository').shipmentsOfOrder(orderId);
  const sid = s?.id ?? '';
  expect(
    (await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/allocations`, admin, {})).statusCode,
  ).toBe(201);
  expect(
    (
      await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/tasks`, admin, {
        assigneeUserId: admin,
      })
    ).statusCode,
  ).toBe(201);
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pick`, admin, {});
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pick/complete`, admin);
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pack`, admin, {
    packages: [{ packageType: 'BAG', count: qty }],
  });
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/qc`, admin, {
    checks: ['qty_match', 'batch_match', 'packaging', 'labels'].map((key) => ({
      key,
      passed: true,
    })),
  });
  const staged = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/stage`, admin, {});
  expect(data<{ status: string }>(staged).status).toBe('READY_TO_DISPATCH');
  return { orderId, orderNo, reservationId, shipmentId: sid, routeId: s?.routeId ?? null };
};

describe.skipIf(DB_URL === undefined)('D-57b dispatch against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    await app.diContainer.resolve('db').wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    await app.diContainer.resolve('db').wmsShelfLifeRule.deleteMany({});
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, facts(A));
    W = data<{ id: string }>(
      await call(app, 'POST', '/admin/warehouses', admin, {
        code: randomCode('dp'),
        name: 'IT Dispatch Hub',
        type: 'MOTHER',
        tagline: 'Primary Mother Hub',
        addressLine: 'NH-16',
        city: 'Eluru',
        district: 'Eluru',
        stateCode: '37',
        pinCode: PIN,
        temperatureClasses: ['AMB'],
      }),
    ).id;
    const zone = data<{ id: string; isSecure: boolean }>(
      await call(app, 'POST', `/admin/warehouses/${W}/zones`, admin, {
        code: 'V',
        name: 'Vault',
        temperatureClass: 'AMB',
        isSecure: true,
      }),
    );
    expect(zone.isSecure).toBe(true);
    await call(app, 'POST', `/admin/warehouses/${W}/zones/${zone.id}/racks`, admin, {
      maxWeightKg: 9000,
      volumeM3: 30,
      generateBins: { count: 2, maxWeightKg: 3000, volumeM3: 10 },
    });
    bins = data<{ id: string }[]>(
      await call(app, 'GET', `/admin/warehouses/${W}/bins?limit=10`, admin),
    ).map((x) => x.id);
    const door = await call(app, 'POST', `/admin/warehouses/${W}/dock-doors`, admin, {
      code: 'HB-02',
      name: 'Heavy Bay 02',
      type: 'LOADING',
      vehicleClass: 'HEAVY_TRUCK',
      capacityPerDay: 40,
      capacityUnit: 'TONNES',
      equipment: 'WEIGHBRIDGE',
    });
    expect(door.statusCode, door.body).toBe(201);
    doorId = data<{ id: string; equipment: string }>(door).id;
    expect(data<{ equipment: string }>(door).equipment).toBe('WEIGHBRIDGE');
    const r = await call(
      app,
      'POST',
      '/wms/stock/receipts',
      admin,
      {
        warehouseId: W,
        lines: [
          { variantId: A, batchNo: `D1-${TAG}`, expiryDate: '2027-08-01', qty: 50, binId: bins[0] },
        ],
      },
      { 'idempotency-key': randomUUID() },
    );
    for (const l of data<{ lines: { batchId: string }[] }>(r).lines)
      await call(app, 'POST', '/wms/stock/quality/release', admin, {
        warehouseId: W,
        batchId: l.batchId,
      });
  });

  afterAll(async () => {
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.update({ where: { id: W }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('route master → fleet → trip → loading → weighbridge → depart (issue event) → pings → views → complete', async () => {
    const route = await call(app, 'POST', '/wms/dispatch/routes', admin, {
      warehouseId: W,
      code: `#8-${TAG}`,
      name: 'Route #8 – South Corridor',
      corridorName: 'NH-16 Express Corridor',
      pinCodes: [PIN],
      stops: [
        { name: 'Eluru hub', lat: 16.71, lng: 81.1 },
        { name: 'Bhimadole', lat: 16.8, lng: 81.26 },
        { name: 'Dwaraka Tirumala', lat: 16.95, lng: 81.25 },
      ],
    });
    expect(route.statusCode, route.body).toBe(201);
    const carrier = data<{ id: string }>(
      await call(app, 'POST', '/wms/dispatch/carriers', admin, {
        name: 'FarmX Fleet',
        type: 'OWN_FLEET',
      }),
    );
    const vehicle = await call(app, 'POST', '/wms/dispatch/vehicles', admin, {
      regNo: `AP39 TX ${TAG}`,
      carrierId: carrier.id,
      warehouseId: W,
      vehicleClass: 'HEAVY_TRUCK',
      capacityKg: 9000,
    });
    expect(vehicle.statusCode, vehicle.body).toBe(201);
    const v = data<{ id: string; regNo: string }>(vehicle);
    expect(v.regNo).toBe(`AP39TX${TAG}`);
    expect(
      (
        await call(app, 'POST', '/wms/dispatch/vehicles', admin, {
          regNo: `AP39TX${TAG}`,
          vehicleClass: 'TRUCK',
          capacityKg: 1000,
        })
      ).statusCode,
    ).toBe(409);
    const driver = data<{ id: string }>(
      await call(app, 'POST', '/wms/dispatch/drivers', admin, {
        name: 'Ramu',
        phone: '+919888877777',
        warehouseId: W,
        carrierId: carrier.id,
      }),
    );

    const s1 = await readyShipment(4);
    expect(s1.routeId).toBe(data<{ id: string }>(route).id);
    const trip = await call(app, 'POST', '/wms/dispatch/trips', admin, {
      warehouseId: W,
      shipmentIds: [s1.shipmentId],
      vehicleId: v.id,
      driverId: driver.id,
      dockDoorId: doorId,
      plannedDepartAt: new Date(Date.now() + 3_600_000).toISOString(),
      etaAt: new Date(Date.now() + 4 * 3_600_000).toISOString(),
    });
    expect(trip.statusCode, trip.body).toBe(201);
    const t = data<{ id: string; tripNo: string; status: string; plannedKg: number }>(trip);
    expect(t).toMatchObject({ status: 'PLANNED', plannedKg: 200 });
    const s2 = await readyShipment(2);
    const busy = await call(app, 'POST', '/wms/dispatch/trips', admin, {
      warehouseId: W,
      shipmentIds: [s2.shipmentId],
      vehicleId: v.id,
    });
    expect(errorOf(busy).details?.reason).toBe('VEHICLE_BUSY');

    const loading = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/loading`, admin, {
      gateIn: true,
      loadedPct: 60,
      shipments: [{ shipmentId: s1.shipmentId, loadedKg: 200 }],
    });
    expect(data<{ status: string; loadedPct: number }>(loading)).toMatchObject({
      status: 'LOADING',
      loadedPct: 60,
    });
    const weigh = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/weighbridge`, admin, {
      grossKg: 9203,
      tareKg: 9000,
      slipNo: 'WB-1',
    });
    expect(data<{ netKg: number; weightVerified: boolean; label: string }>(weigh)).toMatchObject({
      netKg: 203,
      weightVerified: true,
      label: 'Net: 0.20 T Verified',
    });

    const departed = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/depart`, admin, {});
    expect(departed.statusCode, departed.body).toBe(200);
    expect(data<{ status: string }>(departed).status).toBe('DEPARTED');
    const shipment = await app.diContainer.resolve('fulfilmentRepository').shipment(s1.shipmentId);
    expect(shipment?.status).toBe('DISPATCHED');
    expect(shipment?.dispatchId).not.toBeNull();
    const ev = (await outbox(app, 'shipment.dispatched.v1', W)) as {
      dispatchId: string;
      shipmentId: string;
      lines: { variantId: string; qty: number }[];
    }[];
    expect(ev.find((e) => e.shipmentId === s1.shipmentId)).toMatchObject({
      dispatchId: shipment?.dispatchId,
      lines: [{ variantId: A, qty: 4 }],
    });
    const stockEv = (await outbox(app, 'warehouse.stock_changed.v1', W)) as { kind: string }[];
    expect(stockEv.filter((e) => e.kind === 'ISSUE')).toHaveLength(0); // inventory learns it from the dispatch event
    const sum = await app.diContainer.resolve('db').wmsStockSummary.findUnique({
      where: { warehouseId_variantId: { warehouseId: W, variantId: A } },
    });
    expect(sum).toMatchObject({ packed: 2, available: 44 });

    const p1 = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/pings`, admin, {
      lat: 16.75,
      lng: 81.15,
      speedKmh: 42,
      remainingKm: 18,
      network: '4G',
    });
    expect(data<{ stored: boolean }>(p1).stored).toBe(true);
    const p2 = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/pings`, admin, {
      lat: 16.76,
      lng: 81.16,
      speedKmh: 40,
    });
    expect(data<{ stored: boolean }>(p2).stored).toBe(false);
    const track = data<{
      speedKmh: number;
      nextMilestone: { name: string } | null;
      network: string;
    }>(await call(app, 'GET', `/wms/dispatch/trips/${t.id}/tracking`, admin));
    expect(track).toMatchObject({ speedKmh: 40, network: null });
    expect(track.nextMilestone?.name).toBe('Bhimadole');

    for (const path of [
      `/fulfilment/dispatched?warehouseId=${W}&page=1`,
      `/fulfilment/shipments/${s1.shipmentId}/dispatch-summary`,
      `/fulfilment/shipments/${s1.shipmentId}/vehicle`,
      `/fulfilment/shipments/${s1.shipmentId}/tracking`,
      `/fulfilment/shipments/${s1.shipmentId}/dispatch-info`,
      `/dispatch/trips/${t.id}`,
      `/dispatch/trips/${t.id}/route`,
      `/dispatch/trips/${t.id}/weighbridge`,
      `/dispatch/trips?warehouseId=${W}&page=1`,
      `/dispatch/weighbridge/recent?warehouseId=${W}`,
      `/dispatch/routes?warehouseId=${W}`,
      '/dispatch/carriers',
      `/dispatch/vehicles?warehouseId=${W}&available=1`,
      `/dispatch/drivers?warehouseId=${W}`,
      `/bulk/kpis?warehouseId=${W}`,
      `/bulk/orders?warehouseId=${W}&tab=all&page=1`,
      `/bulk/bays?warehouseId=${W}`,
      `/bulk/corridors?warehouseId=${W}`,
    ]) {
      const r1 = await call(app, 'GET', `/wms${path}`, admin);
      expect(r1.statusCode, `${path} ${r1.body}`).toBe(200);
      const r2 = await call(app, 'GET', `/admin/wms${path}`, admin);
      expect(r2.statusCode, `admin ${path} ${r2.body}`).toBe(200);
    }
    const summary = data<{ bay: string; transit: { status: string } }>(
      await call(app, 'GET', `/wms/fulfilment/shipments/${s1.shipmentId}/dispatch-summary`, admin),
    );
    expect(summary).toMatchObject({ bay: 'HB-02', transit: { status: 'DEPARTED' } });
    const bays = data<{ bays: { code: string; heavy: boolean; equipment: string }[] }>(
      await call(app, 'GET', `/wms/bulk/bays?warehouseId=${W}`, admin),
    );
    expect(bays.bays.find((x) => x.code === 'HB-02')).toMatchObject({
      heavy: true,
      equipment: 'WEIGHBRIDGE',
    });
    const csv = await call(app, 'GET', `/wms/bulk/orders/export.csv?warehouseId=${W}`, admin);
    expect(csv.headers['content-type']).toContain('text/csv');

    const done = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/complete`, admin);
    expect(data<{ status: string }>(done).status).toBe('COMPLETED');
    const cancelLate = await call(app, 'POST', `/wms/dispatch/trips/${t.id}/cancel`, admin, {
      reason: 'Too late to cancel',
    });
    expect(cancelLate.statusCode).toBe(409);

    await deliver(app, 'inventory.issue_rejected.v1', {
      dispatchId: randomUUID(),
      shipmentId: s1.shipmentId,
      orderRef: s1.orderId,
      warehouseId: W,
      lines: [{ variantId: A, requested: 4, held: 0 }],
    });
    const ex = data<{ type: string; shipmentId: string }[]>(
      await call(app, 'GET', `/wms/fulfilment/exceptions?warehouseId=${W}`, admin),
    );
    expect(ex.some((e) => e.type === 'ISSUE_MISMATCH' && e.shipmentId === s1.shipmentId)).toBe(
      true,
    );

    const parts = await app.diContainer.resolve('dispatchRepository').maintainPingPartitions();
    expect(parts.dropped).toEqual([]);
    expect(
      await app.diContainer.resolve('dispatchRepository').downsamplePings(),
    ).toBeGreaterThanOrEqual(0);
  });
});
