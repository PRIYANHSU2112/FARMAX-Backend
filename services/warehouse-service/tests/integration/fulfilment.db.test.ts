import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { FulfilmentFacts } from '../../src/adapters/order-client.js';
import {
  DB_URL,
  buildTestApp,
  call,
  data,
  deliver,
  errorOf,
  inventoryCutover,
  inventoryReservations,
  orderService,
  outbox,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-57b Phase 3: fulfilment core (orders → shipments → FEFO → floor), compliance, hold, saga. */
let app: FastifyInstance;
const ALL = [
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'inventory.pick',
  'inventory.exception_raise',
  'quality.hold_release',
  'fulfilment.view',
  'fulfilment.manage',
  'fulfilment.reallocate',
  'fulfilment.fefo_override',
  'compliance.review',
];
const admin = staff(ALL);
const reviewer = staff(ALL);
const A = randomUUID();
const R = randomUUID();
const TAG = randomUUID().slice(0, 4).toUpperCase();
const idem = () => ({ 'idempotency-key': randomUUID() });
let W: { id: string; bins: string[] };
let W2: { id: string; bins: string[] };
const PIN = '534001';

const facts = (
  variantId: string,
  sku: string,
  name: string,
  extra: Record<string, unknown> = {},
) => ({
  variantId,
  productId: randomUUID(),
  sku,
  barcode: null,
  productName: name,
  variantName: name,
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
  ...extra,
});

const makeWarehouse = async (name: string) => {
  const id = data<{ id: string }>(
    await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('ff'),
      name,
      type: 'DEPOT',
      addressLine: 'Plot 9, Industrial Estate',
      city: 'Eluru',
      district: 'Eluru',
      stateCode: '37',
      pinCode: PIN,
      temperatureClasses: ['AMB'],
    }),
  ).id;
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
    generateBins: { count: 3, maxWeightKg: 3000, volumeM3: 10 },
  });
  const bins = data<{ id: string }[]>(
    await call(app, 'GET', `/admin/warehouses/${id}/bins?limit=10`, admin),
  ).map((b) => b.id);
  return { id, bins };
};

const stockIn = async (
  warehouseId: string,
  lines: { variantId: string; batchNo: string; expiryDate: string; qty: number; binId: string }[],
) => {
  const r = await call(app, 'POST', '/wms/stock/receipts', admin, { warehouseId, lines }, idem());
  expect(r.statusCode, r.body).toBe(201);
  for (const l of data<{ lines: { batchId: string }[] }>(r).lines)
    await call(app, 'POST', '/wms/stock/quality/release', admin, {
      warehouseId,
      batchId: l.batchId,
    });
};

const summary = (warehouseId: string, variantId: string) =>
  app.diContainer
    .resolve('db')
    .wmsStockSummary.findUnique({ where: { warehouseId_variantId: { warehouseId, variantId } } });

const orderFacts = (
  orderId: string,
  orderNo: string,
  lines: { variantId: string; qty: number }[],
): FulfilmentFacts => ({
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
  customerPoRef: 'PO-8849201',
  deliveryPromise: null,
  placedAt: new Date().toISOString(),
  paidAt: new Date().toISOString(),
  confirmedAt: new Date().toISOString(),
  totals: { grandTotal: '1000.00', itemSubtotal: '950.00', freight: '50.00' },
  customer: {
    name: 'Ravi Kumar',
    phone: '+919999900000',
    farmName: 'Sri Lakshmi Poultry',
    farmCode: 'FARM-001',
    gstin: null,
  },
  shipTo: {
    name: 'Ravi Kumar',
    phone: '+919999900000',
    line1: 'Survey 12',
    line2: null,
    landmark: null,
    village: 'Pedavegi',
    mandal: null,
    district: 'Eluru',
    stateCode: '37',
    pinCode: PIN,
    latitude: 16.71,
    longitude: 81.1,
    formatted: 'Survey 12, Pedavegi, Eluru',
  },
  lines: lines.map((l, i) => ({
    lineNo: i + 1,
    variantId: l.variantId,
    productId: randomUUID(),
    sku: `SKU-${String(i)}`,
    name: `Product ${String(i)}`,
    temperatureClass: 'AMB',
    qty: l.qty,
    cancelledQty: 0,
    unitPrice: '50.00',
    lineTotal: (50 * l.qty).toFixed(2),
  })),
  payment: {
    method: 'ONLINE',
    instrument: 'upi',
    providerRefMasked: '••••1234',
    capturedAt: new Date().toISOString(),
  },
  version: 1,
});

/** placed → paid → committed (one warehouse) → confirmed. Returns the shipment. */
const placeOrder = async (
  lines: { variantId: string; qty: number; warehouseId: string }[],
  confirm = true,
) => {
  const orderId = randomUUID();
  const orderNo = `ORD-26-${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const reservationId = randomUUID();
  orderService.facts.set(orderId, orderFacts(orderId, orderNo, lines));
  await deliver(app, 'order.placed.v1', {
    orderId,
    orderNo,
    userId: randomUUID(),
    farmId: randomUUID(),
    grandTotal: '1000.00',
    paymentDueAt: new Date().toISOString(),
    shipTo: { name: 'Ravi Kumar', district: 'Eluru', pinCode: PIN },
  });
  await deliver(app, 'order.paid.v1', {
    orderId,
    orderNo,
    reservationId,
    paymentId: randomUUID(),
    amount: '1000.00',
  });
  await deliver(app, 'inventory.reservation_committed.v1', {
    reservationId,
    orderRef: orderId,
    recovered: false,
    lines,
  });
  if (confirm)
    await deliver(app, 'order.confirmed.v1', {
      orderId,
      orderNo,
      reservationId,
      confirmedAt: new Date().toISOString(),
      lines: lines.map((l, i) => ({ lineNo: i + 1, variantId: l.variantId, qty: l.qty })),
    });
  const shipments = await app.diContainer.resolve('fulfilmentRepository').shipmentsOfOrder(orderId);
  return { orderId, orderNo, reservationId, shipments };
};

describe.skipIf(DB_URL === undefined)('D-57b fulfilment core against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    await app.diContainer.resolve('db').wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    inventoryCutover.mode = 'WMS';
    // Shelf-life rules are global: start clean (an earlier failed run may have left one).
    await app.diContainer.resolve('db').wmsShelfLifeRule.deleteMany({});
    productFacts.set(A, facts(A, `LF-${A.slice(0, 4)}`, 'Layer Feed 50 kg'));
    productFacts.set(
      R,
      facts(R, `AB-${R.slice(0, 4)}`, 'Enrofloxacin 1 L', {
        drugSchedule: 'H',
        isAntimicrobial: true,
        weightGrams: 1000,
      }),
    );
    W = await makeWarehouse('IT FF Main');
    W2 = await makeWarehouse('IT FF Second');
    await stockIn(W.id, [
      {
        variantId: A,
        batchNo: `F1-${TAG}`,
        expiryDate: '2027-01-15',
        qty: 10,
        binId: W.bins[0] ?? '',
      },
      {
        variantId: A,
        batchNo: `F2-${TAG}`,
        expiryDate: '2027-06-01',
        qty: 20,
        binId: W.bins[1] ?? '',
      },
      {
        variantId: R,
        batchNo: `R1-${TAG}`,
        expiryDate: '2027-03-01',
        qty: 10,
        binId: W.bins[2] ?? '',
      },
    ]);
    await stockIn(W2.id, [
      {
        variantId: A,
        batchNo: `G1-${TAG}`,
        expiryDate: '2027-02-01',
        qty: 15,
        binId: W2.bins[0] ?? '',
      },
    ]);
  });

  afterAll(async () => {
    await app.diContainer.resolve('db').wmsWarehouse.updateMany({
      where: { id: { in: [W.id, W2.id] } },
      data: { deletedAt: new Date() },
    });
    await app.close();
  });

  it('order → shipment RELEASED → FEFO → assign → pick → pack → QC → stage (stock follows)', async () => {
    const o = await placeOrder([{ variantId: A, qty: 12, warehouseId: W.id }]);
    const [s] = o.shipments;
    expect(s?.status).toBe('RELEASED');
    expect(s?.slaDueAt).not.toBeNull();
    const ev = (await outbox(app, 'shipment.status_changed.v1', W.id)) as {
      orderId: string;
      to: string;
      orderShipments: { status: string; version: number }[];
    }[];
    const ofOrder = ev.filter((e) => e.orderId === o.orderId);
    expect(ofOrder.map((e) => e.to)).toEqual(['PENDING_RELEASE', 'RELEASED']);
    // Each snapshot carries the shipment version, so order-service can keep the newest state.
    const [created, released] = ofOrder.map((e) => e.orderShipments[0]);
    expect(released?.status).toBe('RELEASED');
    expect(released?.version).toBeGreaterThan(created?.version ?? Infinity);

    const detail = data<{
      factsLoaded: boolean;
      customerPoRef: string;
      payment: { label: string };
    }>(await call(app, 'GET', `/wms/fulfilment/orders/${o.orderId}`, admin));
    expect(detail).toMatchObject({ factsLoaded: true, customerPoRef: 'PO-8849201' });
    expect(detail.payment.label).toBe('UPI · Paid in advance');
    for (const path of [
      'customer',
      'items',
      'activity',
      'audit',
      'hold',
      'allocation-candidates',
      'allocation-map',
      'shelf-life-check',
    ]) {
      const res = await call(app, 'GET', `/wms/fulfilment/orders/${o.orderId}/${path}`, admin);
      expect(res.statusCode, `${path} ${res.body}`).toBe(200);
    }
    const list = await call(
      app,
      'GET',
      `/wms/fulfilment/orders?tab=new&warehouseId=${W.id}&page=1`,
      admin,
    );
    expect(list.body).toContain(o.orderNo);

    const sid = s?.id ?? '';
    const lots = data<{ lots: { batchNo: string; recommended: boolean; proposedQty: number }[] }>(
      await call(app, 'GET', `/wms/fulfilment/shipments/${sid}/lines/1/lots`, admin),
    );
    expect(lots.lots.map((l) => [l.batchNo, l.recommended, l.proposedQty])).toEqual([
      [`F1-${TAG}`, true, 10],
      [`F2-${TAG}`, true, 2],
    ]);
    const res = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/allocations`, admin, {});
    expect(res.statusCode, res.body).toBe(201);
    expect(data<{ complete: boolean }>(res).complete).toBe(true);
    expect(await summary(W.id, A)).toMatchObject({ available: 18, reserved: 12 });

    const task = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/tasks`, admin, {
      assigneeUserId: admin,
      priority: 'PRIORITY',
    });
    expect(task.statusCode, task.body).toBe(201);
    const t = data<{ id: string; checklist: { key: string }[] }>(task);
    const tick = await call(
      app,
      'PUT',
      `/wms/fulfilment/tasks/${t.id}/checklist/${t.checklist[0]?.key ?? ''}`,
      admin,
      { done: true },
    );
    expect(data<{ checklistDone: number }>(tick).checklistDone).toBe(1);
    const mine = data<{ id: string }[]>(
      await call(app, 'GET', '/wms/fulfilment/tasks?assignee=me', admin),
    );
    expect(mine.some((x) => x.id === t.id)).toBe(true);

    expect(
      (
        await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pack`, admin, {
          packages: [{ packageType: 'BAG' }],
        })
      ).statusCode,
    ).toBe(409);
    const picked = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pick`, admin, {});
    expect(data<{ status: string }>(picked).status).toBe('PICKING');
    expect(
      (await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pick/complete`, admin)).statusCode,
    ).toBe(200);
    const packed = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pack`, admin, {
      packages: [{ packageType: 'BAG', count: 12, weightKg: 50 }],
    });
    expect(data<{ status: string }>(packed).status).toBe('QC');
    expect(await summary(W.id, A)).toMatchObject({ available: 18, reserved: 0, packed: 12 });
    const checks = ['qty_match', 'batch_match', 'packaging', 'labels'].map((key) => ({
      key,
      passed: true,
    }));
    expect(
      (await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/stage`, admin, {})).statusCode,
    ).toBe(409);
    expect(
      (await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/qc`, admin, { checks }))
        .statusCode,
    ).toBe(200);
    const staged = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/stage`, admin, {});
    expect(data<{ status: string }>(staged).status).toBe('READY_TO_DISPATCH');
    expect(
      data<{ status: string }>(await call(app, 'GET', `/wms/fulfilment/tasks/${t.id}`, admin))
        .status,
    ).toBe('DONE');

    for (const path of [
      `/fulfilment/dashboard/status-strip?warehouseId=${W.id}&fresh=1`,
      `/fulfilment/dashboard/kpis?warehouseId=${W.id}&fresh=1`,
      `/fulfilment/dashboard/trend?warehouseId=${W.id}`,
      `/fulfilment/dashboard/fulfilment-rate?warehouseId=${W.id}`,
      `/fulfilment/dashboard/status-mix?warehouseId=${W.id}`,
      `/fulfilment/dashboard/recent-orders?warehouseId=${W.id}`,
      '/fulfilment/dashboard/warehouse-performance?groupBy=type',
      `/fulfilment/dashboard/ops-status?warehouseId=${W.id}`,
      '/sync-status',
      '/fulfilment/nav-counts',
      `/fulfilment/orders/kpis?warehouseId=${W.id}`,
      '/fulfilment/orders/filter-options?field=pin',
      `/fulfilment/processing/counts?warehouseId=${W.id}`,
      `/fulfilment/processing?stage=ready&warehouseId=${W.id}&page=1`,
      `/fulfilment/processing/kpis?warehouseId=${W.id}&fresh=1`,
      `/fulfilment/shipments/${sid}`,
      `/fulfilment/shipments/${sid}/lines`,
      `/fulfilment/shipments/${sid}/allocation-summary`,
      `/fulfilment/shipments/${sid}/allocations`,
      `/fulfilment/operators?warehouseId=${W.id}`,
      '/fulfilment/task-templates/PICK_PACK',
      `/fulfilment/exceptions/kpis?warehouseId=${W.id}`,
      `/stock/reservations/kpis?warehouseId=${W.id}&fresh=1`,
      `/stock/reservations?tab=picked&warehouseId=${W.id}`,
      '/settings/sop',
      '/fulfilment/shelf-life-rules',
    ]) {
      const r1 = await call(app, 'GET', `/wms${path}`, admin);
      expect(r1.statusCode, `${path} ${r1.body}`).toBe(200);
      const r2 = await call(app, 'GET', `/admin/wms${path}`, admin);
      expect(r2.statusCode, `admin ${path} ${r2.body}`).toBe(200);
    }
    const strip = data<{ buckets: { key: string; count: number }[] }>(
      await call(
        app,
        'GET',
        `/wms/fulfilment/dashboard/status-strip?warehouseId=${W.id}&fresh=1`,
        admin,
      ),
    );
    expect(strip.buckets.find((x) => x.key === 'READY')?.count).toBeGreaterThanOrEqual(1);
  });

  it('compliance gate: regulated order waits; waiver with step-up; reviewer approves; hold; cancel frees lots', async () => {
    const o = await placeOrder([{ variantId: R, qty: 2, warehouseId: W.id }]);
    const sid = o.shipments[0]?.id ?? '';
    const blocked = await call(
      app,
      'POST',
      `/wms/fulfilment/shipments/${sid}/allocations`,
      admin,
      {},
    );
    expect(blocked.statusCode).toBe(409);
    expect(errorOf(blocked).details?.reason).toBe('COMPLIANCE_PENDING');
    const cases = data<{ id: string; orderId: string; skuLabel: string }[]>(
      await call(app, 'GET', '/wms/compliance/cases?status=PENDING', admin),
    );
    const c = cases.find((x) => x.orderId === o.orderId);
    expect(c?.skuLabel).toBe('1 SKUs (1 Restricted)');
    const detail = data<{ checklist: { id: string; type: string }[]; version: number }>(
      await call(app, 'GET', `/wms/compliance/cases/${c?.id ?? ''}`, admin),
    );
    expect(detail.checklist.map((x) => x.type)).toEqual(['VET_RX']);
    for (const p of [
      'kpis',
      `cases/${c?.id ?? ''}/restricted-ledger`,
      `cases/${c?.id ?? ''}/evidence`,
      'registry',
      'inspectors',
    ]) {
      const r = await call(app, 'GET', `/wms/compliance/${p}`, admin);
      expect(r.statusCode, `${p} ${r.body}`).toBe(200);
    }
    const noDoc = await call(
      app,
      'POST',
      `/wms/compliance/cases/${c?.id ?? ''}/checks/${detail.checklist[0]?.id ?? ''}/decision`,
      reviewer,
      { decision: 'VERIFIED' },
    );
    expect(errorOf(noDoc).details?.reason).toBe('DOCUMENT_MISSING');
    const early = await call(
      app,
      'POST',
      `/wms/compliance/cases/${c?.id ?? ''}/decision`,
      reviewer,
      { decision: 'APPROVE', expectedVersion: detail.version },
    );
    expect(errorOf(early).details?.reason).toBe('CHECKS_PENDING');
    const badCode = await call(
      app,
      'POST',
      `/wms/compliance/cases/${c?.id ?? ''}/waiver`,
      reviewer,
      { authorizationNo: 'F19-001', totpCode: '000000' },
    );
    expect(badCode.statusCode).toBe(422);
    const waived = await call(
      app,
      'POST',
      `/wms/compliance/cases/${c?.id ?? ''}/waiver`,
      reviewer,
      { authorizationNo: 'F19-001', totpCode: '123456' },
    );
    expect(waived.statusCode, waived.body).toBe(200);
    const v = data<{ version: number }>(waived).version;
    const ok = await call(app, 'POST', `/wms/compliance/cases/${c?.id ?? ''}/decision`, reviewer, {
      decision: 'APPROVE',
      expectedVersion: v,
    });
    expect(data<{ status: string }>(ok).status).toBe('APPROVED');

    expect(
      (await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/allocations`, admin, {}))
        .statusCode,
    ).toBe(201);
    expect(await summary(W.id, R)).toMatchObject({ available: 8, reserved: 2 });
    const held = await call(app, 'POST', `/wms/fulfilment/orders/${o.orderId}/hold`, admin, {
      reasonCode: 'CUSTOMER_REQUEST',
      note: 'Farmer asked to wait',
    });
    expect(held.statusCode, held.body).toBe(200);
    const soft = await app.diContainer
      .resolve('db')
      .wmsLotAllocation.findMany({ where: { shipmentId: sid, status: 'ALLOCATED' } });
    expect(soft.every((a) => a.soft)).toBe(true);
    const onHold = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/pick`, admin, {});
    expect(errorOf(onHold).details?.reason).toBe('ON_HOLD');

    await deliver(app, 'order.cancelled.v1', {
      orderId: o.orderId,
      orderNo: o.orderNo,
      reservationId: o.reservationId,
      scope: 'FULL',
      lines: [],
      reasonCode: 'BUYER',
    });
    const after = await app.diContainer.resolve('fulfilmentRepository').shipment(sid);
    expect(after?.status).toBe('CANCELLED');
    expect(await summary(W.id, R)).toMatchObject({ available: 10, reserved: 0 });
    const hold = await app.diContainer.resolve('fulfilmentRepository').openHold(o.orderId);
    expect(hold).toBeNull();
  });

  it('reallocation saga: completes (lines move) or fails cleanly (locks released)', async () => {
    const o = await placeOrder([{ variantId: A, qty: 3, warehouseId: W.id }]);
    inventoryReservations.answer = {
      ok: false,
      definitive: true,
      reason: 'INSUFFICIENT_STOCK',
      message: 'no stock',
    };
    const failed = await call(
      app,
      'POST',
      `/admin/wms/fulfilment/orders/${o.orderId}/allocate`,
      admin,
      { warehouseId: W2.id, reason: 'Nearer warehouse' },
    );
    expect(failed.statusCode, failed.body).toBe(201);
    expect(data<{ status: string }>(failed).status).toBe('FAILED');
    const line = await app.diContainer
      .resolve('db')
      .wmsShipmentLine.findFirstOrThrow({ where: { shipmentId: o.shipments[0]?.id ?? '' } });
    expect(line.reallocationId).toBeNull();

    inventoryReservations.answer = { ok: true, replayed: false };
    const done = await call(
      app,
      'POST',
      `/admin/wms/fulfilment/orders/${o.orderId}/allocate`,
      admin,
      { warehouseId: W2.id, reason: 'Nearer warehouse' },
    );
    expect(data<{ status: string }>(done).status).toBe('COMPLETED');
    expect(inventoryReservations.reallocate.at(-1)).toMatchObject({
      reservationId: o.reservationId,
      moves: [{ variantId: A, fromWarehouseId: W.id, toWarehouseId: W2.id, qty: 3 }],
    });
    const shipments = await app.diContainer
      .resolve('fulfilmentRepository')
      .shipmentsOfOrder(o.orderId);
    expect(shipments.map((s) => [s.warehouseId === W.id ? 'W' : 'W2', s.status]).sort()).toEqual([
      ['W', 'CANCELLED'],
      ['W2', 'RELEASED'],
    ]);
    const scoped = staff([], { [W.id]: ALL.filter((k) => k !== 'fulfilment.reallocate') });
    const denied = await call(app, 'POST', `/wms/fulfilment/orders/${o.orderId}/allocate`, scoped, {
      warehouseId: W.id,
      reason: 'Move it back',
    });
    expect([403, 404]).toContain(denied.statusCode);
  });

  it('shortage → SHORTAGE exception (partial allocation); partial release shrinks the line; resolve', async () => {
    const o = await placeOrder([{ variantId: A, qty: 25, warehouseId: W.id }]);
    const sid = o.shipments[0]?.id ?? '';
    const res = await call(app, 'POST', `/wms/fulfilment/shipments/${sid}/allocations`, admin, {});
    expect(data<{ complete: boolean; short: { short: number }[] }>(res)).toMatchObject({
      complete: false,
      short: [{ short: 7 }],
    });
    const ex = data<{ id: string; type: string; shipmentId: string }[]>(
      await call(app, 'GET', `/wms/fulfilment/exceptions?warehouseId=${W.id}`, admin),
    );
    const shortage = ex.find((e) => e.shipmentId === sid && e.type === 'SHORTAGE');
    expect(shortage).toBeDefined();
    const csv = await call(
      app,
      'GET',
      `/wms/fulfilment/exceptions/export.csv?warehouseId=${W.id}`,
      admin,
    );
    expect(csv.headers['content-type']).toContain('text/csv');

    await deliver(app, 'inventory.reservation_released.v1', {
      reservationId: o.reservationId,
      orderRef: o.orderId,
      scope: 'PARTIAL',
      lines: [{ variantId: A, qty: 10, warehouseId: W.id }],
    });
    const s = await app.diContainer.resolve('fulfilmentRepository').shipment(sid);
    expect(s?.lines[0]).toMatchObject({ qty: 25, cancelledQty: 10, allocatedQty: 15 });
    expect(await summary(W.id, A)).toMatchObject({ available: 3, reserved: 15 });

    const resolved = await call(
      app,
      'POST',
      `/wms/fulfilment/exceptions/${shortage?.id ?? ''}/resolve`,
      admin,
      { action: 'NO_ACTION', note: 'Customer reduced the order' },
    );
    expect(data<{ status: string }>(resolved).status).toBe('RESOLVED');
    const split = await call(
      app,
      'POST',
      `/wms/fulfilment/exceptions/${shortage?.id ?? ''}/resolve`,
      admin,
      { action: 'SPLIT' },
    );
    expect(split.statusCode).toBe(409);
  });

  it('allocation reconcile acts only on the second run; jobs and admin settings', async () => {
    const o = await placeOrder([{ variantId: A, qty: 2, warehouseId: W2.id }]);
    inventoryReservations.openLines.set(W2.id, [
      {
        reservationId: o.reservationId,
        orderRef: o.orderId,
        variantId: A,
        heldQty: 1,
        issuedQty: 0,
      },
    ]);
    const jobs = app.diContainer.resolve('fulfilmentJobs');
    const first = await jobs.reconcileAllocations();
    expect(first.acted).toBe(0);
    await jobs.reconcileAllocations();
    const s = await app.diContainer
      .resolve('fulfilmentRepository')
      .shipment(o.shipments[0]?.id ?? '');
    expect(s?.lines[0]).toMatchObject({ qty: 2, cancelledQty: 1 });
    const report = data<{ mismatches: number }>(
      await call(app, 'GET', '/admin/wms/ops/reconcile/allocation', admin),
    );
    expect(report.mismatches).toBeGreaterThanOrEqual(1);
    inventoryReservations.openLines.clear();

    expect(await jobs.slaWatch()).toMatchObject({ checked: expect.any(Number) as number });
    expect(await app.diContainer.resolve('fulfilmentOrders').recoverReallocations()).toMatchObject({
      checked: expect.any(Number) as number,
    });
    expect(await app.diContainer.resolve('complianceService').escalate()).toMatchObject({
      checked: expect.any(Number) as number,
    });
    await jobs.rollup();

    const put = await call(app, 'PUT', '/admin/wms/fulfilment/settings', admin, {
      'fulfilment.pickTargetMin': 25,
    });
    expect(data(put)['fulfilment.pickTargetMin']).toBe(25);
    expect(
      (
        await call(app, 'PUT', '/wms/fulfilment/settings', admin, {
          'fulfilment.pickTargetMin': 25,
        })
      ).statusCode,
    ).toBe(404);
    const rule = await call(app, 'POST', '/admin/wms/fulfilment/shelf-life-rules', admin, {
      name: 'AP poultry 180 days',
      stateCode: '37',
      minRemainingDays: 180,
    });
    expect(rule.statusCode, rule.body).toBe(201);
    const o2 = await placeOrder([{ variantId: A, qty: 1, warehouseId: W2.id }]);
    const lots = data<{
      minShelfLifeDays: number;
      lots: { eligible: boolean; ineligibleReason: string | null }[];
    }>(
      await call(
        app,
        'GET',
        `/wms/fulfilment/shipments/${o2.shipments[0]?.id ?? ''}/lines/1/lots`,
        admin,
      ),
    );
    expect(lots.minShelfLifeDays).toBe(180);
    await call(
      app,
      'DELETE',
      `/admin/wms/fulfilment/shelf-life-rules/${data<{ id: string }>(rule).id}`,
      admin,
    );
  });
});
