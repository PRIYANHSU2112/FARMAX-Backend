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
  productFacts,
  randomCode,
  randomPinBase,
  staff,
} from './harness.js';

/** D-57b Phase 5 W3.14: split across nodes, partial ship, backorders + allocator. */
let app: FastifyInstance;
const admin = staff([
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'quality.hold_release',
  'fulfilment.view',
  'fulfilment.manage',
  'fulfilment.reallocate',
]);
const V = randomUUID();
const PIN = String(randomPinBase() + 3);
let A = '';
let B = '';
let orderId = '';
const made: string[] = [];

interface Ctx {
  banner: { short: boolean; shortUnits: number };
  lines: { variantId: string; need: number; availableHere: number; shortHere: number }[];
  fit: { warehouseId: string; fit: string }[];
  shipments: { id: string; warehouseId: string; status: string }[];
  backorders: { id: string; status: string; qty: number; version: number }[];
}
interface Proposal {
  legs: { warehouseId: string; units: number; fleetSuggestion: { vehicleClass: string } }[];
  backorder: { variantId: string; qty: number }[];
}

const node = async (name: string, lat: number, lng: number, qty: number) => {
  const id = data<{ id: string }>(
    await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('sp'),
      name,
      type: 'DEPOT',
      addressLine: 'NH-16',
      city: 'Eluru',
      district: 'Eluru',
      stateCode: '37',
      pinCode: PIN,
      temperatureClasses: ['AMB'],
    }),
  ).id;
  made.push(id);
  await call(app, 'POST', `/admin/warehouses/${id}/service-areas`, admin, {
    expectedVersion: 0,
    stateCode: '37',
    district: 'Eluru',
    priority: 'HIGH',
    pins: [PIN],
  });
  await app.diContainer.resolve('db').wmsWarehouse.update({
    where: { id },
    data: { status: 'ACTIVE', isAllocatable: true, latitude: lat, longitude: lng },
  });
  const zone = data<{ id: string }>(
    await call(app, 'POST', `/admin/warehouses/${id}/zones`, admin, {
      code: 'A',
      name: 'Feed',
      temperatureClass: 'AMB',
    }),
  );
  await call(app, 'POST', `/admin/warehouses/${id}/zones/${zone.id}/racks`, admin, {
    maxWeightKg: 9000,
    volumeM3: 30,
    generateBins: { count: 1, maxWeightKg: 3000, volumeM3: 10 },
  });
  const [bin] = data<{ id: string }[]>(
    await call(app, 'GET', `/admin/warehouses/${id}/bins?limit=5`, admin),
  );
  const r = await call(
    app,
    'POST',
    '/wms/stock/receipts',
    admin,
    {
      warehouseId: id,
      lines: [
        {
          variantId: V,
          batchNo: `SP-${id.slice(0, 6)}`,
          expiryDate: '2027-06-01',
          qty,
          binId: bin?.id,
        },
      ],
    },
    { 'idempotency-key': randomUUID() },
  );
  for (const l of data<{ lines: { batchId: string }[] }>(r).lines)
    await call(app, 'POST', '/wms/stock/quality/release', admin, {
      warehouseId: id,
      batchId: l.batchId,
    });
  return id;
};

describe.skipIf(DB_URL === undefined)('D-57b split / partial / backorder against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    await app.diContainer.resolve('db').wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    await app.diContainer.resolve('db').wmsRoutingRule.updateMany({
      where: { deletedAt: null },
      data: { deletedAt: new Date() },
    });
    inventoryCutover.mode = 'WMS';
    productFacts.set(V, {
      variantId: V,
      productId: randomUUID(),
      sku: `SP-${V.slice(0, 4)}`,
      barcode: null,
      productName: 'Mineral Mix 25 kg',
      variantName: 'Mineral Mix 25 kg',
      manufacturerName: null,
      packSize: '25.000',
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
      weightGrams: 25_000,
      minOrderQty: 1,
      maxOrderQty: null,
      version: 1,
    });
    A = await node('IT Split Near', 16.79, 80.85, 4);
    B = await node('IT Split Far', 16.75, 81.68, 10);

    orderId = randomUUID();
    const reservationId = randomUUID();
    const orderNo = `ORD-26-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
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
      customerPoRef: 'PO-77',
      deliveryPromise: null,
      placedAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      totals: { grandTotal: '1000.00' },
      customer: {
        name: 'Lakshmi',
        phone: '+919999933333',
        farmName: null,
        farmCode: null,
        gstin: null,
      },
      shipTo: {
        name: 'Lakshmi',
        phone: '+919999933333',
        line1: 'Plot 1',
        line2: null,
        landmark: null,
        village: 'Nuzvid',
        mandal: null,
        district: 'Eluru',
        stateCode: '37',
        pinCode: PIN,
        latitude: 16.83,
        longitude: 80.85,
        formatted: 'Plot 1, Nuzvid',
      },
      lines: [
        {
          lineNo: 1,
          variantId: V,
          productId: randomUUID(),
          sku: 'SP',
          name: 'Mineral Mix',
          temperatureClass: 'AMB',
          qty: 10,
          cancelledQty: 0,
          unitPrice: '100.00',
          lineTotal: '1000.00',
        },
      ],
      payment: {
        method: 'ONLINE',
        instrument: 'upi',
        providerRefMasked: '••••3333',
        capturedAt: null,
      },
      version: 1,
    });
    await deliver(app, 'order.placed.v1', {
      orderId,
      orderNo,
      userId: randomUUID(),
      farmId: randomUUID(),
      grandTotal: '1000.00',
      paymentDueAt: new Date().toISOString(),
      shipTo: { name: 'Lakshmi', district: 'Eluru', pinCode: PIN },
    });
    await deliver(app, 'inventory.reservation_committed.v1', {
      reservationId,
      orderRef: orderId,
      recovered: false,
      lines: [{ warehouseId: A, variantId: V, qty: 10 }],
    });
    await deliver(app, 'order.confirmed.v1', {
      orderId,
      orderNo,
      reservationId,
      confirmedAt: new Date().toISOString(),
      lines: [{ lineNo: 1, variantId: V, qty: 10 }],
    });
  });

  afterAll(async () => {
    await app.diContainer.resolve('db').wmsWarehouse.updateMany({
      where: { id: { in: made } },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });
    await app.close();
  });

  it('context shows the shortage; strategies propose different legs', async () => {
    const ctx = data<Ctx>(
      await call(app, 'GET', `/wms/fulfilment/orders/${orderId}/split-context`, admin),
    );
    expect(ctx.banner).toMatchObject({ short: true, shortUnits: 6 });
    expect(ctx.lines[0]).toMatchObject({ need: 10, availableHere: 4, shortHere: 6 });
    expect(ctx.fit.find((f) => f.warehouseId === B)?.fit).toBe('ALL');

    const few = data<Proposal>(
      await call(
        app,
        'GET',
        `/wms/fulfilment/orders/${orderId}/split-proposal?strategy=FEWEST_SPLITS`,
        admin,
      ),
    );
    expect(few.legs.map((l) => [l.warehouseId, l.units])).toEqual([[B, 10]]);
    const cheap = data<Proposal>(
      await call(
        app,
        'GET',
        `/wms/fulfilment/orders/${orderId}/split-proposal?strategy=LEAST_COST`,
        admin,
      ),
    );
    expect(cheap.legs.map((l) => [l.warehouseId, l.units])).toEqual([
      [A, 4],
      [B, 6],
    ]);
    expect(cheap.backorder).toEqual([]);
    expect(cheap.legs[0]?.fleetSuggestion.vehicleClass).toBe('MINI_TRUCK');
  });

  it('preview checks, then execute: 4 stay at A, 6 move to B; customer notice event', async () => {
    const bad = data<{ ok: boolean; checks: { key: string; pass: boolean }[] }>(
      await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/split-preview`, admin, {
        legs: [{ warehouseId: A, lines: [{ variantId: V, qty: 4 }] }],
      }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.checks.find((c) => c.key === 'QTY_MATCH')?.pass).toBe(false);

    const plan = {
      legs: [
        { warehouseId: A, lines: [{ variantId: V, qty: 4 }] },
        { warehouseId: B, lines: [{ variantId: V, qty: 6 }] },
      ],
    };
    const good = data<{ ok: boolean; customerNotice: string }>(
      await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/split-preview`, admin, plan),
    );
    expect(good.ok).toBe(true);
    expect(good.customerNotice).toContain('2 deliveries');

    const res = await call(app, 'POST', `/admin/wms/fulfilment/orders/${orderId}/split`, admin, {
      ...plan,
      reason: 'Near depot short of mineral mix',
    });
    expect(res.statusCode, res.body).toBe(200);
    const out = data<{ legs: { warehouseId: string; status: string }[] }>(res);
    expect(out.legs.map((l) => l.status)).toEqual(['KEPT', 'COMPLETED']);
    const ctx = data<Ctx>(
      await call(app, 'GET', `/wms/fulfilment/orders/${orderId}/split-context`, admin),
    );
    expect(
      ctx.shipments
        .filter((s) => s.status !== 'CANCELLED')
        .map((s) => s.warehouseId)
        .sort(),
    ).toEqual([A, B].sort());
    const ev = await app.diContainer.resolve('db').outboxEvent.findMany({
      where: { type: 'shipment.split_planned.v1' },
      select: { payload: true },
    });
    expect(
      ev.some((e) => (e.payload as { data: { orderId: string } }).data.orderId === orderId),
    ).toBe(true);
  });

  it('partial ship backorders 1 unit; the allocator puts it back when stock allows; cancel path', async () => {
    let ctx = data<Ctx>(
      await call(app, 'GET', `/wms/fulfilment/orders/${orderId}/split-context`, admin),
    );
    const atA = ctx.shipments.find((s) => s.warehouseId === A && s.status !== 'CANCELLED');
    const noConsent = await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/partial`, admin, {
      shipmentId: atA?.id,
      lines: [{ variantId: V, shipQty: 3 }],
      remainder: 'BACKORDER',
      reason: 'One bag torn at the bin',
    });
    expect(errorOf(noConsent).details?.reason).toBe('CONSENT_REQUIRED');
    const part = await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/partial`, admin, {
      shipmentId: atA?.id,
      lines: [{ variantId: V, shipQty: 3 }],
      remainder: 'BACKORDER',
      promiseDate: '2026-12-30',
      consentLogged: true,
      reason: 'One bag torn at the bin',
    });
    expect(part.statusCode, part.body).toBe(200);
    ctx = data<Ctx>(part);
    expect(ctx.backorders.filter((b) => b.status === 'OPEN')).toHaveLength(1);
    const nav = data<{ backorders: number }>(
      await call(app, 'GET', `/wms/fulfilment/nav-counts?warehouseId=${A}`, admin),
    );
    expect(nav.backorders).toBe(1);
    const queue = await call(
      app,
      'GET',
      `/wms/fulfilment/backorders?warehouseId=${A}&status=OPEN`,
      admin,
    );
    expect(data<{ orderNo: string }[]>(queue)[0]?.orderNo).toMatch(/^ORD-26-/);

    const bo = ctx.backorders[0];
    const patched = await call(app, 'PATCH', `/wms/fulfilment/backorders/${bo?.id ?? ''}`, admin, {
      promiseDate: '2026-12-28',
      expectedVersion: bo?.version,
    });
    expect(data<{ promiseDate: string }>(patched).promiseDate).toBe('2026-12-28');

    // A holds 4 available; the shipment there needs 3 → the backorder (1) fits and goes back on.
    const run = await app.diContainer.resolve('fulfilmentSplit').allocateBackorders();
    expect(run.allocated).toBeGreaterThanOrEqual(1);
    ctx = data<Ctx>(
      await call(app, 'GET', `/wms/fulfilment/orders/${orderId}/split-context`, admin),
    );
    expect(ctx.backorders[0]?.status).toBe('ALLOCATED');
    expect(ctx.lines.reduce((n, l) => n + l.need, 0)).toBe(10);

    // CANCEL remainder → order-service cancels (refund + release); the event shrinks the line.
    const cancel = await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/partial`, admin, {
      shipmentId: atA?.id,
      lines: [{ variantId: V, shipQty: 2 }],
      remainder: 'CANCEL',
      reason: 'Customer agreed to fewer bags',
    });
    expect(cancel.statusCode, cancel.body).toBe(200);
    expect(orderService.cancelled.find((c) => c.orderId === orderId)?.lines).toEqual([
      { variantId: V, qty: 2 },
    ]);

    const slots = await call(app, 'GET', `/wms/fulfilment/dispatch-slots?warehouseId=${A}`, admin);
    expect(slots.statusCode, slots.body).toBe(200);
    const map = data<{ corridors: { warehouseId: string; active: boolean }[] }>(
      await call(app, 'GET', `/wms/fulfilment/orders/${orderId}/split-map`, admin),
    );
    expect(
      map.corridors
        .filter((c) => c.active)
        .map((c) => c.warehouseId)
        .sort(),
    ).toEqual([A, B].sort());
  });

  it('W3.15 amendments: quote, save (delivery + decrease), uncovered PIN event, manifest', async () => {
    const up = data<{ ok: boolean; issues: { code: string }[] }>(
      await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/amendments/quote`, admin, {
        lines: [{ variantId: V, qty: 12 }],
      }),
    );
    expect(up.ok).toBe(false);
    expect(up.issues.map((i) => i.code)).toContain('BALANCE_PAYMENT_NOT_AVAILABLE');
    const away = data<{ issues: { code: string }[] }>(
      await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/amendments/quote`, admin, {
        delivery: { pinCode: '110001' },
      }),
    );
    expect(away.issues.map((i) => i.code)).toContain('PIN_NOT_COVERED');
    const down = data<{ ok: boolean; refundEstimate: string }>(
      await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/amendments/quote`, admin, {
        lines: [{ variantId: V, qty: 9 }],
      }),
    );
    expect(down).toMatchObject({ ok: true, refundEstimate: '100.00' });

    const before = orderService.cancelled.length;
    const saved = await call(app, 'POST', `/wms/fulfilment/orders/${orderId}/amendments`, admin, {
      delivery: { contactName: 'Lakshmi Devi', deliveryPromise: '2026-12-31' },
      lines: [{ variantId: V, qty: 9 }],
      reason: 'Customer called to change the receiver',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(orderService.deliveryUpdates.at(-1)?.body).toMatchObject({
      contactName: 'Lakshmi Devi',
    });
    expect(orderService.cancelled.length).toBe(before + 1);

    await deliver(app, 'order.delivery_updated.v1', {
      orderId,
      orderNo: 'X',
      changes: ['pinCode'],
      pinCode: '110001',
      district: 'New Delhi',
      deliveryPromise: null,
    });
    const ex = await app.diContainer
      .resolve('db')
      .wmsException.findMany({ where: { orderId, type: 'ALLOCATION_ISSUE' } });
    expect(ex.length).toBeGreaterThanOrEqual(1);

    const ctx = data<Ctx>(
      await call(app, 'GET', `/wms/fulfilment/orders/${orderId}/split-context`, admin),
    );
    const sid =
      ctx.shipments.find((s) => s.warehouseId === B && s.status !== 'CANCELLED')?.id ?? '';
    const m = await call(app, 'GET', `/wms/fulfilment/shipments/${sid}/manifest`, admin);
    expect(m.statusCode, m.body).toBe(200);
    expect(data<{ shipTo: { customerPoRef: string } }>(m).shipTo.customerPoRef).toBe('PO-77');
  });
  it('W3.18 payments view: KPIs, ledger tabs, customer panel, SLA flag, export', async () => {
    const k = data<{ prepaidCleared: { orders: number }; modules: { credit: boolean } }>(
      await call(app, 'GET', `/wms/payments-view/kpis?warehouseId=${A}`, admin),
    );
    expect(k.prepaidCleared.orders).toBeGreaterThanOrEqual(1);
    expect(k.modules.credit).toBe(false);
    const res = await call(
      app,
      'GET',
      `/wms/payments-view/orders?tab=paid&warehouseId=${A}`,
      admin,
    );
    expect(res.statusCode, res.body).toBe(200);
    const row = data<{ orderId: string; valuation: string; userId: string; terms: string }[]>(
      res,
    ).find((r) => r.orderId === orderId);
    expect(row).toMatchObject({ valuation: 'UPI • Paid in advance', terms: 'PREPAID' });
    expect((JSON.parse(res.body) as { tabs: { paid: number } }).tabs.paid).toBeGreaterThanOrEqual(
      1,
    );
    const cust = await call(
      app,
      'GET',
      `/admin/wms/payments-view/customers/${row?.userId ?? ''}`,
      admin,
    );
    expect(data<{ orders: number; paymentTerms: string }>(cust)).toMatchObject({
      orders: 1,
      paymentTerms: 'PREPAID',
    });
    const sla = data<{ modules: { paymentStats: boolean } }>(
      await call(app, 'GET', '/admin/wms/payments-view/sla', admin),
    );
    expect(typeof sla.modules.paymentStats).toBe('boolean');
    const csv = await call(
      app,
      'GET',
      `/wms/payments-view/orders/export.csv?warehouseId=${A}`,
      admin,
    );
    expect(csv.body).toContain('order_no,placed_at');
  });
});
