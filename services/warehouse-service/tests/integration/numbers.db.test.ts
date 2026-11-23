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
  inventoryStats,
  prepareSetup,
  randomCode,
  staff,
} from './harness.js';

/** W2 numbers (D-56 P3): order read model, stock snapshots, overview, HAS_OPEN_ORDERS. */
const CENTRAL = [
  'warehouse.view',
  'warehouse.create',
  'warehouse.configure',
  'warehouse.status_change',
];
let app: FastifyInstance;
let w = '';
const admin = staff(CENTRAL);
const base = () => `/admin/warehouses/${w}`;
const order1 = randomUUID();
const order2 = randomUUID();
const feedCategory = randomUUID();

interface Order {
  orderId: string;
  orderNo: string | null;
  shipToName: string | null;
  unitCount: number;
  lineCount: number;
  status: string;
}
const ordersOf = async (status = 'OPEN') =>
  data<Order[]>(await call(app, 'GET', `${base()}/orders?status=${status}`, admin));

describe.skipIf(DB_URL === undefined)('warehouse numbers against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const res = await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('it'),
      name: 'IT Numbers Depot',
      type: 'DEPOT',
      managerUserId: '0193a5f2-7c1e-7b2a-9f00-1a2b3c4d5e31',
      phone: '9876543210',
      addressLine: 'Plot 7, Industrial Estate',
      city: 'Nuzvid',
      district: 'Eluru',
      stateCode: '37',
      pinCode: '521201',
      capacity: { value: 50, unit: 'TONNES' },
      temperatureClasses: ['AMB', 'CC_REF'],
      isAllocatable: false,
    });
    w = data<{ id: string }>(res).id;
    await prepareSetup(app, admin, w);
    const on = await call(app, 'POST', `${base()}/activate`, admin, { expectedVersion: 0 });
    expect(on.statusCode, on.body).toBe(200);
  });

  afterAll(async () => {
    inventoryStats.rows = [];
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.update({ where: { id: w }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('orders: placed + committed → NEW here only; confirmed → ALLOCATED; redelivery is a no-op', async () => {
    await deliver(app, 'order.placed.v1', {
      orderId: order1,
      orderNo: 'FX-IT-0001',
      userId: randomUUID(),
      farmId: randomUUID(),
      grandTotal: '1200.00',
      paymentDueAt: new Date().toISOString(),
      shipTo: { name: 'Sri Lakshmi Poultry', district: 'Eluru', pinCode: '534001' },
    });
    const committed = {
      reservationId: randomUUID(),
      orderRef: order1,
      recovered: false,
      lines: [
        { warehouseId: w, variantId: 'a0000000-0000-7000-8000-000000000001', qty: 4 },
        { warehouseId: w, variantId: 'a0000000-0000-7000-8000-000000000002', qty: 6 },
        { warehouseId: randomUUID(), variantId: 'a0000000-0000-7000-8000-000000000001', qty: 9 },
      ],
    };
    await deliver(app, 'inventory.reservation_committed.v1', committed);
    await deliver(app, 'inventory.reservation_committed.v1', committed);
    expect(await ordersOf()).toEqual([
      expect.objectContaining({
        orderId: order1,
        orderNo: 'FX-IT-0001',
        shipToName: 'Sri Lakshmi Poultry',
        lineCount: 2,
        unitCount: 10,
        status: 'NEW',
      }),
    ]);
    await deliver(app, 'order.confirmed.v1', {
      orderId: order1,
      orderNo: 'FX-IT-0001',
      reservationId: committed.reservationId,
      confirmedAt: new Date().toISOString(),
      lines: [],
    });
    expect((await ordersOf())[0]?.status).toBe('ALLOCATED');
  });

  it('stock snapshot feeds overview, stock tab, details header, list and summary', async () => {
    inventoryStats.rows = [
      {
        warehouseId: w,
        onHand: 120,
        reserved: 20,
        damaged: 0,
        available: 100,
        skuCount: 2,
        usedKg: '1500.00',
        weighedUnits: 100,
        unweighedUnits: 20,
        unweighedSkus: 1,
        weightKnownPct: 83.3,
        categories: [
          { rootCategoryId: feedCategory, skuCount: 1, onHand: 90, reserved: 20, available: 70 },
          { rootCategoryId: null, skuCount: 1, onHand: 30, reserved: 0, available: 30 },
        ],
      },
    ];
    const refreshed = await app.diContainer.resolve('statsService').refresh();
    expect('warehouses' in refreshed).toBe(true);

    const o = data(await call(app, 'GET', `${base()}/overview`, admin));
    expect(o).toMatchObject({
      stale: false,
      stock: {
        onHand: { value: 120, vsLast7DaysPct: null },
        available: { value: 100 },
        skuCount: 2,
      },
      activeOrders: { new: 0, allocated: 1, total: 1, inPicking: null },
      ordersToProcess: { count: 1 },
      capacity: {
        totalKg: '50000.00',
        usedKg: '1500.00',
        availableKg: '48500.00',
        usedPct: 3,
        weightKnownPct: 83.3,
      },
      info: { typeLabel: 'C&F depot', operatingHoursToday: { holiday: null } },
      modules: { transfers: false },
    });
    const board = o.statusBoard as { key: string; state: string }[];
    expect(board.map((r) => r.state)).toEqual([
      expect.stringMatching(/OPERATIONAL|CLOSED_TODAY/),
      'NOT_CONFIGURED',
      'CONNECTED',
    ]);

    const byCat = data<{
      totals: { onHand: number };
      categories: { rootCategoryId: string | null; sharePct: number }[];
    }>(await call(app, 'GET', `${base()}/stock-by-category`, admin));
    expect(byCat.totals.onHand).toBe(120);
    expect(byCat.categories).toEqual([
      expect.objectContaining({ rootCategoryId: feedCategory, sharePct: 75 }),
      expect.objectContaining({ rootCategoryId: null, sharePct: 25 }),
    ]);

    const detail = data<{ stock: { onHand: number }; capacityUsedPct: number }>(
      await call(app, 'GET', base(), admin),
    );
    expect(detail).toMatchObject({ stock: { onHand: 120 }, capacityUsedPct: 3 });

    const list = data<{ id: string; stockUnits: number; capacityUsedPct: number }[]>(
      await call(app, 'GET', '/admin/warehouses?q=IT Numbers Depot&limit=100', admin),
    );
    expect(list.find((x) => x.id === w)).toMatchObject({ stockUnits: 120, capacityUsedPct: 3 });

    const summary = data<{ totalStockUnits: number; asOf: string | null }>(
      await call(app, 'GET', '/admin/warehouses/summary', admin),
    );
    expect(summary.totalStockUnits).toBeGreaterThanOrEqual(120);
    expect(summary.asOf).not.toBeNull();

    // inventory down → the last snapshot stays.
    inventoryStats.rows = null;
    expect(await app.diContainer.resolve('statsService').refresh()).toEqual({ skipped: true });
    const again = data<{ stock: { onHand: { value: number } } }>(
      await call(app, 'GET', `${base()}/overview`, admin),
    );
    expect(again.stock.onHand.value).toBe(120);
  });

  it('cannot deactivate with open orders; releases and delivery close them', async () => {
    const blocked = await call(app, 'POST', `${base()}/deactivate`, admin, {
      expectedVersion: 1,
      reason: 'closing the depot',
    });
    expect(errorOf(blocked).details).toMatchObject({ reason: 'HAS_OPEN_ORDERS', openOrders: 1 });

    await deliver(app, 'inventory.reservation_released.v1', {
      reservationId: randomUUID(),
      orderRef: order1,
      scope: 'PARTIAL',
      lines: [{ warehouseId: w, variantId: 'a0000000-0000-7000-8000-000000000001', qty: 4 }],
    });
    expect((await ordersOf())[0]).toMatchObject({
      lineCount: 1,
      unitCount: 6,
      status: 'ALLOCATED',
    });
    await deliver(app, 'order.delivered.v1', {
      orderId: order1,
      orderNo: 'FX-IT-0001',
      userId: randomUUID(),
      deliveredAt: new Date().toISOString(),
      lines: [],
      netPaidPaise: 120000,
    });
    expect(await ordersOf('DELIVERED')).toHaveLength(1);

    await deliver(app, 'inventory.reservation_committed.v1', {
      reservationId: randomUUID(),
      orderRef: order2,
      recovered: false,
      lines: [{ warehouseId: w, variantId: 'a0000000-0000-7000-8000-000000000003', qty: 2 }],
    });
    await deliver(app, 'order.cancelled.v1', {
      orderId: order2,
      orderNo: 'FX-IT-0002',
      reservationId: null,
      scope: 'FULL',
      lines: [],
      reasonCode: 'CUSTOMER',
    });
    expect(await ordersOf('CANCELLED')).toEqual([
      expect.objectContaining({ orderId: order2, orderNo: null }),
    ]);

    const off = await call(app, 'POST', `${base()}/deactivate`, admin, {
      expectedVersion: 1,
      reason: 'closing the depot',
    });
    expect(off.statusCode, off.body).toBe(200);
  });

  it('a warehouse outside the scope answers 404', async () => {
    const other = staff([], { [randomUUID()]: ['warehouse.view'] });
    const res = await call(app, 'GET', `${base()}/overview`, other);
    expect(res.statusCode).toBe(404);
  });
});
