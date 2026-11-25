import { createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  INTERNAL_TOKEN,
  buildTestApp,
  call,
  customer,
  data,
  deliver,
  errorOf,
  inventoryCutover,
  orderService,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-57b Phase 4b: OTP + POD delivery, override, failed / return, fulfil, settle, links, exports. */
let app: FastifyInstance;
const ALL = [
  'warehouse.view',
  'warehouse.create',
  'warehouse.configure',
  'inventory.view',
  'inventory.receive',
  'inventory.pick',
  'quality.hold_release',
  'fulfilment.view',
  'fulfilment.manage',
  'logistics.fleet_manage',
  'logistics.dispatch_assign',
  'logistics.consignment_view',
  'logistics.delivery_confirm',
  'logistics.delivery_override',
];
const admin = staff(ALL);
const second = staff(ALL);
const A = randomUUID();
const TAG = randomUUID().slice(0, 4).toUpperCase();
const PIN = '534008';
let W = '';
let bins: string[] = [];
let vehicleId = '';
let driverId = '';

const receipt = (uploaderId: string) => {
  const body = Buffer.from(
    JSON.stringify({
      purpose: 'wms_document',
      key: `test/wms/${randomCode('pod')}.jpg`,
      uploaderId,
      kind: 'image',
      mime: 'image/jpeg',
      size: 4096,
      fileName: 'pod.jpg',
      scanStatus: 'CLEAN',
      exp: Math.floor(Date.now() / 1000) + 600,
    }),
  ).toString('base64url');
  return `${body}.${createHmac('sha256', INTERNAL_TOKEN).update(body).digest('base64url')}`;
};

/** order → ready → trip → departed. Returns ids. */
const dispatched = async (qty: number, buyer: string) => {
  const orderId = randomUUID();
  const orderNo = `ORD-26-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const reservationId = randomUUID();
  await deliver(app, 'order.placed.v1', {
    orderId,
    orderNo,
    userId: buyer,
    farmId: randomUUID(),
    grandTotal: '500.00',
    paymentDueAt: new Date().toISOString(),
    shipTo: { name: 'Buyer', district: 'Eluru', pinCode: PIN },
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
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/allocations`, admin, {});
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/tasks`, admin, {
    assigneeUserId: admin,
  });
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
  await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/stage`, admin, {});
  const trip = data<{ id: string }>(
    await call(app, 'POST', '/wms/dispatch/trips', admin, {
      warehouseId: W,
      shipmentIds: [sid],
      vehicleId,
      driverId,
    }),
  );
  const dep = await call(app, 'POST', `/wms/dispatch/trips/${trip.id}/depart`, admin, {});
  expect(dep.statusCode, dep.body).toBe(200);
  return { orderId, orderNo, shipmentId: sid, tripId: trip.id };
};

const otpOf = async (buyer: string, orderId: string) =>
  data<{ deliveryOtp: string | null; status: string }[]>(
    await call(app, 'GET', `/shipments?orderId=${orderId}`, buyer),
  )[0];

const closeTrip = (tripId: string) =>
  call(app, 'POST', `/wms/dispatch/trips/${tripId}/complete`, admin);

describe.skipIf(DB_URL === undefined)('D-57b delivery against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const db = app.diContainer.resolve('db');
    await db.wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    await db.wmsShelfLifeRule.deleteMany({});
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, {
      variantId: A,
      productId: randomUUID(),
      sku: `DL-${A.slice(0, 4)}`,
      barcode: null,
      productName: 'Layer Mash 50 kg',
      variantName: 'Layer Mash 50 kg',
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
    W = data<{ id: string }>(
      await call(app, 'POST', '/admin/warehouses', admin, {
        code: randomCode('dl'),
        name: 'IT Delivery Depot',
        type: 'DEPOT',
        addressLine: 'Road 1',
        city: 'Eluru',
        district: 'Eluru',
        stateCode: '37',
        pinCode: PIN,
        temperatureClasses: ['AMB'],
      }),
    ).id;
    const zone = data<{ id: string }>(
      await call(app, 'POST', `/admin/warehouses/${W}/zones`, admin, {
        code: 'A',
        name: 'Feed',
        temperatureClass: 'AMB',
      }),
    );
    await call(app, 'POST', `/admin/warehouses/${W}/zones/${zone.id}/racks`, admin, {
      maxWeightKg: 9000,
      volumeM3: 30,
      generateBins: { count: 2, maxWeightKg: 3000, volumeM3: 10 },
    });
    bins = data<{ id: string }[]>(
      await call(app, 'GET', `/admin/warehouses/${W}/bins?limit=10`, admin),
    ).map((x) => x.id);
    const r = await call(
      app,
      'POST',
      '/wms/stock/receipts',
      admin,
      {
        warehouseId: W,
        lines: [
          { variantId: A, batchNo: `L1-${TAG}`, expiryDate: '2027-09-01', qty: 60, binId: bins[0] },
        ],
      },
      { 'idempotency-key': randomUUID() },
    );
    for (const l of data<{ lines: { batchId: string }[] }>(r).lines)
      await call(app, 'POST', '/wms/stock/quality/release', admin, {
        warehouseId: W,
        batchId: l.batchId,
      });
    vehicleId = data<{ id: string }>(
      await call(app, 'POST', '/wms/dispatch/vehicles', admin, {
        regNo: `AP37${TAG}`,
        warehouseId: W,
        vehicleClass: 'TRUCK',
        capacityKg: 5000,
      }),
    ).id;
    driverId = data<{ id: string }>(
      await call(app, 'POST', '/wms/dispatch/drivers', admin, {
        name: 'Krishna',
        phone: '+919777766666',
        warehouseId: W,
      }),
    ).id;
  });

  afterAll(async () => {
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.update({ where: { id: W }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('OTP delivery (code only in the customer app) → short delivery → fulfil → settle (refund + POD)', async () => {
    const buyer = customer();
    const d = await dispatched(4, buyer);
    expect((await otpOf(buyer, d.orderId))?.deliveryOtp).toBeNull();
    const ofd = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/out-for-delivery`,
      admin,
    );
    expect(ofd.statusCode, ofd.body).toBe(200);
    expect(ofd.body).not.toMatch(/"otp"|deliveryOtp/);
    const otp = (await otpOf(buyer, d.orderId))?.deliveryOtp ?? '';
    expect(otp).toMatch(/^\d{6}$/);
    const other = customer();
    expect(
      await call(app, 'GET', `/shipments?orderId=${d.orderId}`, other).then((r) =>
        data<unknown[]>(r),
      ),
    ).toEqual([]);
    expect((await call(app, 'GET', '/shipments', admin)).statusCode).toBe(403);

    const wrong = String((Number(otp) + 1) % 1_000_000).padStart(6, '0');
    const bad = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/deliver`,
      admin,
      { otp: wrong, receiverName: 'Buyer' },
    );
    expect(bad.statusCode).toBe(422);
    const ok = await call(app, 'POST', `/wms/fulfilment/shipments/${d.shipmentId}/deliver`, admin, {
      otp,
      receiverName: 'Buyer',
      receivedLines: [{ lineNo: 1, qty: 3 }],
      podReceipts: [receipt(admin)],
      lat: 16.7,
      lng: 81.1,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<{ status: string; lines: { delivered: number }[] }>(ok)).toMatchObject({
      status: 'DELIVERED',
      lines: [{ delivered: 3 }],
    });
    const pod = data<{
      otp: { verified: boolean; verifiedAt: string };
      receiverName: string;
      photos: unknown[];
    }>(await call(app, 'GET', `/wms/fulfilment/shipments/${d.shipmentId}/pod`, admin));
    expect(pod.otp.verified).toBe(true);
    expect(pod.photos).toHaveLength(1);
    expect(JSON.stringify(pod)).not.toContain(otp);
    expect((await otpOf(buyer, d.orderId))?.deliveryOtp).toBeNull();

    const fulfilled = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/fulfil`,
      admin,
    );
    expect(
      data<{ status: string; settlement: { status: string; reason: string } }>(fulfilled),
    ).toMatchObject({
      status: 'FULFILLED',
      settlement: { status: 'PENDING', reason: 'DISCREPANCY' },
    });
    const v = data<{ version: number }>(fulfilled).version;
    const settled = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/settle`,
      admin,
      { resolution: 'REFUND_SHORTAGE', expectedVersion: v },
    );
    expect(settled.statusCode, settled.body).toBe(200);
    expect(data<{ settlement: { status: string } }>(settled).settlement.status).toBe('SETTLED');
    expect(orderService.refunds.at(-1)).toMatchObject({
      orderId: d.orderId,
      shipmentId: d.shipmentId,
      lines: [{ lineNo: 1, qty: 1 }],
    });
    await closeTrip(d.tripId);

    for (const path of [
      `/fulfilment/delivered/kpis?warehouseId=${W}`,
      `/fulfilment/delivered?warehouseId=${W}&page=1`,
      `/fulfilment/fulfilled/kpis?warehouseId=${W}`,
      `/fulfilment/fulfilled?warehouseId=${W}&tab=settled&page=1`,
    ]) {
      const r1 = await call(app, 'GET', `/wms${path}`, admin);
      expect(r1.statusCode, `${path} ${r1.body}`).toBe(200);
      expect((await call(app, 'GET', `/admin/wms${path}`, admin)).statusCode).toBe(200);
    }
    const row = data<
      { shipmentId: string; otp: { verified: boolean }; settlement: { label: string } }[]
    >(await call(app, 'GET', `/wms/fulfilment/fulfilled?warehouseId=${W}`, admin)).find(
      (x) => x.shipmentId === d.shipmentId,
    );
    expect(row?.settlement.label).toBe('Settled');
  });

  it('override needs a second approver; OTP lock after 5 wrong codes; failed → return to warehouse', async () => {
    const buyer = customer();
    const d = await dispatched(2, buyer);
    await call(app, 'POST', `/wms/fulfilment/shipments/${d.shipmentId}/out-for-delivery`, admin);
    const otp = (await otpOf(buyer, d.orderId))?.deliveryOtp ?? '';
    const wrong = String((Number(otp) + 7) % 1_000_000).padStart(6, '0');
    for (let i = 0; i < 4; i += 1)
      expect(
        (
          await call(app, 'POST', `/wms/fulfilment/shipments/${d.shipmentId}/deliver`, admin, {
            otp: wrong,
            receiverName: 'Bo',
          })
        ).statusCode,
      ).toBe(422);
    const locked = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/deliver`,
      admin,
      { otp: wrong, receiverName: 'Bo' },
    );
    expect(locked.statusCode).toBe(423);
    expect(
      (
        await call(app, 'POST', `/wms/fulfilment/shipments/${d.shipmentId}/deliver`, admin, {
          otp,
          receiverName: 'Bo',
        })
      ).statusCode,
    ).toBe(423);
    const ov = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/deliver-override`,
      admin,
      {
        reason: 'Customer phone switched off',
        receiverName: 'Farm manager',
        podReceipts: [receipt(admin)],
      },
    );
    expect(ov.statusCode, ov.body).toBe(200);
    const f = data<{ version: number; settlement: { reason: string } }>(
      await call(app, 'POST', `/wms/fulfilment/shipments/${d.shipmentId}/fulfil`, admin),
    );
    expect(f.settlement.reason).toBe('OTP_LOCK');
    const self = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/settle`,
      admin,
      { resolution: 'APPROVE_OVERRIDE', expectedVersion: f.version },
    );
    expect(self.statusCode).toBe(403);
    const approved = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d.shipmentId}/settle`,
      second,
      { resolution: 'APPROVE_OVERRIDE', expectedVersion: f.version },
    );
    expect(data<{ settlement: { status: string } }>(approved).settlement.status).toBe('SETTLED');
    await closeTrip(d.tripId);

    const d2 = await dispatched(3, customer());
    await call(app, 'POST', `/wms/fulfilment/shipments/${d2.shipmentId}/out-for-delivery`, admin);
    const failed = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d2.shipmentId}/delivery-failed`,
      admin,
      { reason: 'Farm gate locked' },
    );
    expect(data<{ status: string }>(failed).status).toBe('DELIVERY_FAILED');
    const before = await app.diContainer.resolve('db').wmsStockSummary.findUnique({
      where: { warehouseId_variantId: { warehouseId: W, variantId: A } },
    });
    const back = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${d2.shipmentId}/return-to-warehouse`,
      admin,
      { reason: 'Returned after failed attempt' },
    );
    expect(back.statusCode, back.body).toBe(200);
    expect(data<{ status: string }>(back).status).toBe('RETURNED_TO_WAREHOUSE');
    const after = await app.diContainer.resolve('db').wmsStockSummary.findUnique({
      where: { warehouseId_variantId: { warehouseId: W, variantId: A } },
    });
    expect((after?.returned ?? 0) - (before?.returned ?? 0)).toBe(3);
    await closeTrip(d2.tripId);
  });

  it('3PL driver link: trip view, ping, out for delivery and OTP delivery; revoke → 410', async () => {
    const buyer = customer();
    const d = await dispatched(1, buyer);
    const link = await call(app, 'POST', `/wms/dispatch/trips/${d.tripId}/driver-link`, admin, {
      phone: '+919666655555',
    });
    expect(link.statusCode, link.body).toBe(201);
    const { token } = data<{ token: string; url: string }>(link);
    const trip = await call(app, 'GET', `/driver/trips/${token}`);
    expect(trip.statusCode, trip.body).toBe(200);
    expect(data<{ drops: { shipmentId: string }[] }>(trip).drops[0]?.shipmentId).toBe(d.shipmentId);
    expect(
      (await call(app, 'POST', `/driver/trips/${token}/pings`, undefined, { lat: 16.7, lng: 81.1 }))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(app, 'POST', `/driver/trips/${token}/shipments/${randomUUID()}/out-for-delivery`))
        .statusCode,
    ).toBe(404);
    expect(
      (await call(app, 'POST', `/driver/trips/${token}/shipments/${d.shipmentId}/out-for-delivery`))
        .statusCode,
    ).toBe(200);
    const otp = (await otpOf(buyer, d.orderId))?.deliveryOtp ?? '';
    const done = await call(
      app,
      'POST',
      `/driver/trips/${token}/shipments/${d.shipmentId}/deliver`,
      undefined,
      { otp, receiverName: 'Buyer' },
    );
    expect(done.statusCode, done.body).toBe(200);
    const pod = data<{ deliveredVia: string }>(
      await call(app, 'GET', `/wms/fulfilment/shipments/${d.shipmentId}/pod`, admin),
    );
    expect(pod.deliveredVia).toBe('DRIVER_LINK');
    expect(
      (await call(app, 'DELETE', `/wms/dispatch/trips/${d.tripId}/driver-link`, admin)).statusCode,
    ).toBe(200);
    const gone = await call(app, 'GET', `/driver/trips/${token}`);
    expect(gone.statusCode).toBe(410);
    expect(errorOf(gone).details?.reason).toBe('LINK_EXPIRED');
    expect((await call(app, 'GET', `/driver/trips/${'x'.repeat(43)}`)).statusCode).toBe(404);
    await closeTrip(d.tripId);
  });

  it('POD archive export: queued → built → downloaded (requester only)', async () => {
    const created = await call(app, 'POST', '/wms/exports', admin, {
      type: 'POD_ARCHIVE',
      filters: { warehouseId: W },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = data<{ id: string }>(created).id;
    expect((await call(app, 'GET', `/wms/exports/${id}/download`, admin)).statusCode).toBe(409);
    await app.diContainer.resolve('fulfilmentDelivery').runExports();
    const st = data<{ status: string; rowCount: number }>(
      await call(app, 'GET', `/wms/exports/${id}`, admin),
    );
    expect(st.status).toBe('READY');
    expect(st.rowCount).toBeGreaterThanOrEqual(3);
    const dl = await call(app, 'GET', `/wms/exports/${id}/download`, admin);
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-type']).toContain('text/csv');
    expect(dl.body.split('\n')[0]).toContain('Photo / signature links');
    expect((await call(app, 'GET', `/wms/exports/${id}`, second)).statusCode).toBe(404);
  });
});
