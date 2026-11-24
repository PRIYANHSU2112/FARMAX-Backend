import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  app,
  call,
  captured,
  deliver,
  orderRow,
  outbox,
  placed,
  staff,
  startOrdersApp,
  variant,
} from './orders.harness.js';

/**
 * F1 consumer (D-57b): `shipment.status_changed.v1` → order status + fulfilmentStage, merged per
 * shipment by version (orders.shipmentStates). The happy path with version-less (pre-2026-11-24)
 * events, the cancel guard and the shortage refund are in orders.admin.db.test.ts; this file covers
 * multi-shipment snapshots, late / out-of-order events and the guards.
 */
const reviewer = staff('orders.view', 'orders.confirm');

type Placed = Awaited<ReturnType<typeof placed>>;
interface Ship {
  id: string;
  warehouseId: string;
}
/** [shipment, status, shipment version, delivered qty of order line 1] */
type State = [Ship, string, number, number?];

const ship = (): Ship => ({ id: randomUUID(), warehouseId: randomUUID() });

/** Placed, paid and stock committed (PENDING_ADMIN_CONFIRMATION). */
const ready = async (): Promise<Placed> => {
  const o = await placed();
  await captured(o);
  await deliver('inventory.reservation_committed.v1', {
    reservationId: randomUUID(),
    orderRef: o.order.id,
    recovered: false,
  });
  return o;
};

const confirmed = async (): Promise<Placed> => {
  const o = await ready();
  const res = await call('POST', `/admin/orders/${o.order.id}/confirm`, {
    user: reviewer,
    payload: { expectedVersion: (await orderRow(o.order.id)).version },
  });
  expect(res.statusCode, res.body).toBe(200);
  return o;
};

/** One transition of `moved`; the snapshot lists the order's shipments as that publisher saw them. */
const shipped = (o: Placed, at: string, moved: State, ...others: State[]) =>
  deliver('shipment.status_changed.v1', {
    shipmentId: moved[0].id,
    shipmentNo: 'SHP-IT-0001',
    orderId: o.order.id,
    orderNo: o.order.orderNo,
    warehouseId: moved[0].warehouseId,
    from: null,
    to: moved[1],
    at,
    orderShipments: [moved, ...others].map(([s, status, version, qty = 0]) => ({
      shipmentId: s.id,
      warehouseId: s.warehouseId,
      status,
      version,
      deliveredLines: qty > 0 ? [{ lineNo: 1, variantId: variant, qty }] : [],
    })),
  });

const now = () => new Date().toISOString();
const shipmentHistory = async (orderId: string) =>
  (
    await app.diContainer.resolve('db').orderStatusEvent.findMany({
      where: { orderId, reasonCode: { startsWith: 'SHIPMENT_' } },
      orderBy: { at: 'asc' },
    })
  ).map((e) => ({ to: e.toValue, actorType: e.actorType, reasonCode: e.reasonCode }));

describe.skipIf(DB_URL === undefined)('F1 shipment status consumer', () => {
  beforeAll(async () => {
    await startOrdersApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('RELEASED only tracks the stage; ALLOCATED moves the order to IN_FULFILMENT', async () => {
    const o = await confirmed();
    const a = ship();
    await shipped(o, now(), [a, 'RELEASED', 1]);
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'CONFIRMED',
      fulfilmentStage: 'RELEASED',
    });
    expect(await shipmentHistory(o.order.id)).toEqual([]);

    await shipped(o, now(), [a, 'ALLOCATED', 2]);
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'IN_FULFILMENT',
      fulfilmentStage: 'ALLOCATED',
    });
    expect(await shipmentHistory(o.order.id)).toEqual([
      { to: 'IN_FULFILMENT', actorType: 'SERVICE', reasonCode: 'SHIPMENT_ALLOCATED' },
    ]);
  });

  it('two shipments: one delivered → PARTIALLY_DELIVERED; a late older event changes nothing; both → DELIVERED once, lines summed', async () => {
    const o = await confirmed();
    const [a, b] = [ship(), ship()];
    await shipped(o, now(), [a, 'ALLOCATED', 2], [b, 'RELEASED', 1]);
    await shipped(o, now(), [a, 'DELIVERED', 6, 1], [b, 'PICKING', 4]);
    const partial = await orderRow(o.order.id);
    expect(partial).toMatchObject({
      status: 'PARTIALLY_DELIVERED',
      fulfilmentStage: 'DELIVERED',
      deliveredAt: null,
    });
    expect(await outbox('order.delivered.v1', o.order.id)).toHaveLength(0);

    // An older event redelivered late (a was still picking then): status AND stage stay put.
    await shipped(o, now(), [a, 'PICKING', 4], [b, 'PICKING', 4]);
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'PARTIALLY_DELIVERED',
      fulfilmentStage: 'DELIVERED',
      version: partial.version,
    });

    const at = now();
    await shipped(o, at, [b, 'DELIVERED', 8, 1], [a, 'DELIVERED', 6, 1]);
    expect(await orderRow(o.order.id)).toMatchObject({
      status: 'DELIVERED',
      deliveredAt: new Date(at),
    });
    const events = await outbox('order.delivered.v1', o.order.id);
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toMatchObject({
      orderId: o.order.id,
      deliveredAt: at,
      lines: [{ lineNo: 1, variantId: variant, qty: 2 }],
      netPaidPaise: 20_000,
    });

    // b reaches FULFILLED later: no second order.delivered, no extra status row.
    await shipped(o, now(), [b, 'FULFILLED', 9, 1], [a, 'DELIVERED', 6, 1]);
    expect(await outbox('order.delivered.v1', o.order.id)).toHaveLength(1);
    expect((await shipmentHistory(o.order.id)).map((h) => h.to)).toEqual([
      'IN_FULFILMENT',
      'PARTIALLY_DELIVERED',
      'DELIVERED',
    ]);
  });

  it('two snapshots that each missed the other shipment’s change still add up to DELIVERED', async () => {
    const o = await confirmed();
    const [a, b] = [ship(), ship()];
    await shipped(o, now(), [a, 'PICKING', 3], [b, 'ALLOCATED', 2]);
    const picking = await orderRow(o.order.id);
    expect(picking.fulfilmentStage).toBe('PICKING');

    // b moves but the most advanced stage is still PICKING: kept without bumping the order version.
    await shipped(o, now(), [b, 'ASSIGNED', 3], [a, 'PICKING', 3]);
    expect(await orderRow(o.order.id)).toMatchObject({
      fulfilmentStage: 'PICKING',
      version: picking.version,
      shipmentStates: { [b.id]: { status: 'ASSIGNED', version: 3 } },
    });

    await shipped(o, now(), [a, 'OUT_FOR_DELIVERY', 5], [b, 'OUT_FOR_DELIVERY', 5]);
    // Both delivered at the same moment in two warehouses: each snapshot shows the other as before.
    await shipped(o, now(), [b, 'DELIVERED', 6, 1], [a, 'OUT_FOR_DELIVERY', 5]);
    expect((await orderRow(o.order.id)).status).toBe('PARTIALLY_DELIVERED');
    await shipped(o, now(), [a, 'DELIVERED', 6, 1], [b, 'OUT_FOR_DELIVERY', 5]);
    expect((await orderRow(o.order.id)).status).toBe('DELIVERED');
    const [ev] = await outbox('order.delivered.v1', o.order.id);
    expect(ev?.data).toMatchObject({ lines: [{ lineNo: 1, variantId: variant, qty: 2 }] });
  });

  it('cancelled shipments do not count; FULFILLED counts as delivered; a returned leg keeps it partial', async () => {
    const full = await confirmed();
    const [a, b] = [ship(), ship()];
    await shipped(full, now(), [b, 'FULFILLED', 9, 2], [a, 'CANCELLED', 3]);
    expect((await orderRow(full.order.id)).status).toBe('DELIVERED');
    expect(await outbox('order.delivered.v1', full.order.id)).toHaveLength(1);

    const returned = await confirmed();
    const [c, d] = [ship(), ship()];
    await shipped(returned, now(), [c, 'DELIVERED', 6, 1], [d, 'RETURNED_TO_WAREHOUSE', 8]);
    expect((await orderRow(returned.order.id)).status).toBe('PARTIALLY_DELIVERED');
    expect(await outbox('order.delivered.v1', returned.order.id)).toHaveLength(0);

    // Every shipment cancelled: the order closes through its own cancel flow, not here.
    const gone = await confirmed();
    const e = ship();
    await shipped(gone, now(), [e, 'ALLOCATED', 2]);
    await shipped(gone, now(), [e, 'CANCELLED', 3]);
    expect(await orderRow(gone.order.id)).toMatchObject({
      status: 'IN_FULFILMENT',
      fulfilmentStage: 'ALLOCATED',
      shipmentStates: { [e.id]: { status: 'CANCELLED', version: 3 } },
    });
  });

  it('ignored for unconfirmed, closed and unknown orders', async () => {
    const pending = await ready();
    await shipped(pending, now(), [ship(), 'DELIVERED', 6, 2]);
    expect(await orderRow(pending.order.id)).toMatchObject({
      status: 'PENDING_ADMIN_CONFIRMATION',
      fulfilmentStage: null,
      shipmentStates: null,
    });

    const rejected = await ready();
    const res = await call('POST', `/admin/orders/${rejected.order.id}/reject`, {
      user: staff('orders.view', 'orders.confirm', 'refunds.initiate'),
      payload: {
        expectedVersion: (await orderRow(rejected.order.id)).version,
        reasonCode: 'OUT_OF_STOCK_PHYSICAL',
        reason: 'IT rejected before any shipment moved',
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    await shipped(rejected, now(), [ship(), 'DELIVERED', 6, 2]);
    expect((await orderRow(rejected.order.id)).status).toBe('REJECTED');

    const ghost = {
      ...pending,
      order: { ...pending.order, id: randomUUID(), orderNo: 'FX-NONE' },
    };
    await shipped(ghost, now(), [ship(), 'DELIVERED', 6, 2]);
    for (const id of [pending.order.id, rejected.order.id, ghost.order.id])
      expect(await outbox('order.delivered.v1', id)).toHaveLength(0);
  });
});
