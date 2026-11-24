import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  deliver,
  inventoryAvailability,
  inventoryCutover,
  orderService,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-57b Phase 5 W3.13: available-to-promise from WMS stock, demand, thresholds; storefront sync. */
let app: FastifyInstance;
const admin = staff([
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'inventory.configure',
  'quality.hold_release',
  'fulfilment.view',
]);
const A = randomUUID();
const PIN = '534008';
let W = '';
const SKU = `ATP-${A.slice(0, 6)}`;

interface Item {
  warehouseId: string;
  variantId: string;
  physical: number;
  openDemand: number;
  safetyStock: number;
  netAtp: number;
  projected24h: number;
  health: string;
  healthLabel: string;
  topLot: { batchNo: string; expiryDate: string | null } | null;
  zoneLabel: string | null;
  storefront: { publishedQty: number; inStock: boolean } | null;
}

describe.skipIf(DB_URL === undefined)('D-57b ATP against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    await app.diContainer.resolve('db').wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, {
      variantId: A,
      productId: randomUUID(),
      sku: SKU,
      barcode: null,
      productName: 'Grower Pellet 50 kg',
      variantName: 'Grower Pellet 50 kg',
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
        code: randomCode('atp'),
        name: 'IT ATP Depot',
        type: 'DEPOT',
        tagline: 'C&F Depot',
        addressLine: 'NH-16',
        city: 'Eluru',
        district: 'Eluru',
        stateCode: '37',
        pinCode: PIN,
        temperatureClasses: ['AMB'],
      }),
    ).id;
    const zone = data<{ id: string }>(
      await call(app, 'POST', `/admin/warehouses/${W}/zones`, admin, {
        code: 'B',
        name: 'Bay 04',
        temperatureClass: 'AMB',
      }),
    );
    await call(app, 'POST', `/admin/warehouses/${W}/zones/${zone.id}/racks`, admin, {
      maxWeightKg: 9000,
      volumeM3: 30,
      generateBins: { count: 1, maxWeightKg: 3000, volumeM3: 10 },
    });
    const [bin] = data<{ id: string }[]>(
      await call(app, 'GET', `/admin/warehouses/${W}/bins?limit=5`, admin),
    );
    const r = await call(
      app,
      'POST',
      '/wms/stock/receipts',
      admin,
      {
        warehouseId: W,
        lines: [
          {
            variantId: A,
            batchNo: `LOT-${SKU}`,
            expiryDate: '2027-03-28',
            qty: 30,
            binId: bin?.id,
          },
        ],
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(r.statusCode, r.body).toBe(201);
    for (const l of data<{ lines: { batchId: string }[] }>(r).lines)
      await call(app, 'POST', '/wms/stock/quality/release', admin, {
        warehouseId: W,
        batchId: l.batchId,
      });
    const t = await call(app, 'PUT', `/wms/stock/thresholds/${W}/${A}`, admin, {
      safetyStock: 5,
      reorderLevel: 20,
      targetStock: 100,
    });
    expect(t.statusCode, t.body).toBe(200);

    // Open demand: a confirmed order of 8 at W (shipment RELEASED, not dispatched).
    const orderId = randomUUID();
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
      customerPoRef: null,
      deliveryPromise: null,
      placedAt: new Date().toISOString(),
      paidAt: new Date().toISOString(),
      confirmedAt: new Date().toISOString(),
      totals: { grandTotal: '400.00' },
      customer: {
        name: 'Ravi',
        phone: '+919999922222',
        farmName: null,
        farmCode: null,
        gstin: null,
      },
      shipTo: {
        name: 'Ravi',
        phone: '+919999922222',
        line1: 'Plot 9',
        line2: null,
        landmark: null,
        village: 'Pedavegi',
        mandal: null,
        district: 'Eluru',
        stateCode: '37',
        pinCode: PIN,
        latitude: 16.8,
        longitude: 81.1,
        formatted: 'Plot 9, Pedavegi',
      },
      lines: [
        {
          lineNo: 1,
          variantId: A,
          productId: randomUUID(),
          sku: SKU,
          name: 'Grower Pellet',
          temperatureClass: 'AMB',
          qty: 8,
          cancelledQty: 0,
          unitPrice: '50.00',
          lineTotal: '400.00',
        },
      ],
      payment: {
        method: 'ONLINE',
        instrument: 'upi',
        providerRefMasked: '••••1111',
        capturedAt: null,
      },
      version: 1,
    });
    await deliver(app, 'order.placed.v1', {
      orderId,
      orderNo,
      userId: randomUUID(),
      farmId: randomUUID(),
      grandTotal: '400.00',
      paymentDueAt: new Date().toISOString(),
      shipTo: { name: 'Ravi', district: 'Eluru', pinCode: PIN },
    });
    await deliver(app, 'inventory.reservation_committed.v1', {
      reservationId,
      orderRef: orderId,
      recovered: false,
      lines: [{ warehouseId: W, variantId: A, qty: 8 }],
    });
    await deliver(app, 'order.confirmed.v1', {
      orderId,
      orderNo,
      reservationId,
      confirmedAt: new Date().toISOString(),
      lines: [{ lineNo: 1, variantId: A, qty: 8 }],
    });
  });

  afterAll(async () => {
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.update({ where: { id: W }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('ATP row: net = physical − demand − safety; health band; top FEFO lot + zone', async () => {
    const res = await call(app, 'GET', `/wms/atp/items?warehouseId=${W}&q=${SKU}`, admin);
    expect(res.statusCode, res.body).toBe(200);
    const [row] = data<Item[]>(res);
    expect(row).toMatchObject({
      variantId: A,
      physical: 30,
      openDemand: 8,
      safetyStock: 5,
      netAtp: 17,
      projected24h: 17,
      health: 'HIGH_DEMAND',
      healthLabel: 'High Demand',
    });
    expect(row?.topLot).toEqual({ batchNo: `LOT-${SKU}`.toUpperCase(), expiryDate: '2027-03-28' });
    expect(row?.zoneLabel).toContain('Bay 04');

    const low = await call(app, 'GET', `/wms/atp/items?warehouseId=${W}&health=LOW_BUFFER`, admin);
    expect(data<Item[]>(low).some((i) => i.variantId === A)).toBe(false);
    const paged = await call(app, 'GET', `/wms/atp/items?warehouseId=${W}&page=1&limit=10`, admin);
    expect(data<unknown[]>(paged).length).toBeGreaterThan(0);
    expect((JSON.parse(paged.body) as { meta: { total: number } }).meta.total).toBeGreaterThan(0);
  });

  it('KPIs, categories, node distribution, export', async () => {
    const k = data<{
      physical: number;
      openDemand: number;
      netAtp: number;
      availabilityRatePct: number;
      health: { highDemand: number };
    }>(await call(app, 'GET', `/wms/atp/kpis?warehouseId=${W}&fresh=true`, admin));
    expect(k).toMatchObject({ physical: 30, openDemand: 8, netAtp: 17 });
    expect(k.availabilityRatePct).toBe(56.7);
    expect(k.health.highDemand).toBe(1);

    const cats = data<{ total: number }>(
      await call(app, 'GET', `/wms/atp/categories?warehouseId=${W}`, admin),
    );
    expect(cats.total).toBe(1);

    const nodes = data<{ nodes: { warehouseId: string; tagline: string; netAtp: number }[] }>(
      await call(app, 'GET', '/admin/wms/atp/node-distribution', admin),
    );
    expect(nodes.nodes.find((n) => n.warehouseId === W)).toMatchObject({
      tagline: 'C&F Depot',
      netAtp: 17,
    });

    const csv = await call(app, 'GET', `/wms/atp/items/export.csv?warehouseId=${W}`, admin);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(SKU);
  });

  it('storefront sync (newest sequence wins) → sync-status; Sync Now; settings via inventory', async () => {
    await deliver(app, 'inventory.availability_changed.v1', {
      variantId: A,
      availableQty: 22,
      inStock: true,
      lowStock: false,
      sequence: 5,
    });
    await deliver(app, 'inventory.availability_changed.v1', {
      variantId: A,
      availableQty: 99,
      inStock: true,
      lowStock: false,
      sequence: 4,
    });
    const [row] = data<Item[]>(
      await call(app, 'GET', `/wms/atp/items?warehouseId=${W}&q=${SKU}`, admin),
    );
    expect(row?.storefront).toMatchObject({ publishedQty: 22, inStock: true });
    const sync = data<{ storefrontPublishedAt: string | null }>(
      await call(app, 'GET', '/wms/sync-status', admin),
    );
    expect(sync.storefrontPublishedAt).not.toBeNull();

    const now = await call(app, 'POST', '/wms/atp/sync', admin, { warehouseId: W });
    expect(now.statusCode, now.body).toBe(200);
    expect(inventoryAvailability.resyncs).toContain(W);

    expect((await call(app, 'PUT', '/wms/atp/settings', admin, { reason: 'x' })).statusCode).toBe(
      404,
    );
    const put = await call(app, 'PUT', '/admin/wms/atp/settings', admin, {
      healthBands: { healthy: 15, low: 5 },
      guardrailsEnabled: true,
      cartHoldLeaseSeconds: 900,
      reason: 'Peak season guardrails',
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(data(put)).toMatchObject({
      guardrailsEnabled: true,
      bufferFloorPct: 10,
      cartHoldLeaseSeconds: 900,
      healthBands: { healthy: 15, low: 5 },
    });
    // 17 of target 100 = 17 % → now Healthy (> 15 %).
    const [again] = data<Item[]>(
      await call(app, 'GET', `/wms/atp/items?warehouseId=${W}&q=${SKU}`, admin),
    );
    expect(again?.health).toBe('HEALTHY');
    const off = await call(app, 'PUT', '/admin/wms/atp/settings', admin, {
      guardrailsEnabled: false,
      healthBands: { healthy: 35, low: 10 },
      reason: 'Back to normal',
    });
    expect(data(off)).toMatchObject({ guardrailsEnabled: false, bufferFloorPct: 0 });
  });
});
