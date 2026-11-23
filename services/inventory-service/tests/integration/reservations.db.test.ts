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
  levelOf,
  newVariant,
  newWarehouse,
  outboxEvents,
  randomPin,
  receive,
  staff,
} from './harness.js';

interface Line {
  warehouseId: string;
  variantId: string;
  qty: number;
  heldQty: number;
}
interface Reservation {
  id: string;
  orderRef: string;
  status: string;
  recoveredFromExpiry: boolean;
  lines: Line[];
  split?: boolean;
}

let app: FastifyInstance;
const boss = staff(
  'inventory.view',
  'inventory.configure',
  'inventory.receive',
  'inventory.adjust',
);
const warehouses: string[] = [];

const reserve = (body: object, idem = `rsv-${randomUUID()}`) =>
  call(app, 'POST', '/internal/inventory/reservations', { internal: true, idem, payload: body });

const paid = (r: Reservation) =>
  deliver(app, 'order.paid.v1', {
    orderId: r.orderRef,
    orderNo: 'ORD-26-IT',
    reservationId: r.id,
    paymentId: `pay-${randomUUID().slice(0, 8)}`,
    amount: '100.00',
  });

const released = (type: string, r: Reservation, lines: object[] = [], scope = 'FULL') =>
  deliver(app, type, {
    orderId: r.orderRef,
    orderNo: 'ORD-26-IT',
    reservationId: r.id,
    scope,
    lines,
    reasonCode: 'IT',
  });

const get = async (id: string) =>
  data<Reservation>(await call(app, 'GET', `/admin/inventory/reservations/${id}`, { user: boss }));

/** Pushes an ACTIVE reservation past its window and runs the expiry job. */
const expire = async (id: string) => {
  await app.diContainer
    .resolve('db')
    .stockReservation.update({ where: { id }, data: { expiresAt: new Date(Date.now() - 1000) } });
  await app.diContainer.resolve('reservationsService').expireDue();
};

describe.skipIf(DB_URL === undefined)('reservations against Postgres', () => {
  const pin = randomPin();
  let a: string; // priority 10
  let b: string; // priority 20, cold chain
  let v: string;
  let cold: string;

  beforeAll(async () => {
    app = await buildTestApp();
    a = await newWarehouse(app, boss, pin, { priority: 10 });
    b = await newWarehouse(app, boss, pin, { priority: 20, hasColdChain: true });
    warehouses.push(a, b);
    v = await newVariant(app);
    cold = await newVariant(app, { temperatureClass: 'CC_REF' });
    await receive(app, boss, a, [{ variantId: v, qty: 5 }]);
    await receive(app, boss, b, [
      { variantId: v, qty: 10 },
      { variantId: cold, qty: 6 },
    ]);
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.warehouse.deleteMany({ where: { id: { in: warehouses } } });
    await app.close();
  });

  it('rejects calls without the internal service token', async () => {
    const res = await call(app, 'POST', '/internal/inventory/reservations', {
      idem: 'no-token-123',
      payload: { orderRef: 'x', pinCode: pin, lines: [{ variantId: v, qty: 1 }] },
    });
    expect(res.statusCode).toBe(401);
  });

  it('splits one variant 5 + 7 across warehouses for an order of 12, and replays the key', async () => {
    const body = { orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 12 }] };
    const idem = `rsv-${randomUUID()}`;
    const res = await reserve(body, idem);
    expect(res.statusCode, res.body).toBe(201);
    const r = data<Reservation>(res);
    expect(r.split).toBe(true);
    expect(r.lines.map((l) => [l.warehouseId === a ? 'A' : 'B', l.qty]).sort()).toEqual([
      ['A', 5],
      ['B', 7],
    ]);
    expect((await levelOf(app, a, v)).reserved).toBe(5);
    expect((await levelOf(app, b, v)).reserved).toBe(7);

    const again = await reserve(body, idem);
    expect(again.statusCode).toBe(200);
    expect(data<Reservation>(again).id).toBe(r.id);
    expect((await levelOf(app, b, v)).reserved).toBe(7);

    const sameOrder = await reserve(body);
    expect(sameOrder.statusCode).toBe(409);
    expect(errorOf(sameOrder).details?.reason).toBe('ORDER_ALREADY_RESERVED');

    await released('order.cancelled.v1', r);
    expect((await get(r.id)).status).toBe('RELEASED');
    expect((await levelOf(app, a, v)).reserved).toBe(0);
    expect((await levelOf(app, b, v)).reserved).toBe(0);
    expect(await outboxEvents(app, 'inventory.reservation_released.v1', r.id)).toHaveLength(1);
  });

  it('never reserves safety stock and refuses to split when split allocation is off', async () => {
    const res = await call(app, 'PATCH', `/admin/inventory/stock/${b}/${v}/thresholds`, {
      user: boss,
      payload: { safetyStock: 4, reason: 'IT: keep four in reserve' },
    });
    expect(res.statusCode).toBe(200);
    const short = await reserve({
      orderRef: randomUUID(),
      pinCode: pin,
      lines: [{ variantId: v, qty: 12 }], // 5 (A) + 6 sellable (B: 10 − 4) = 11
    });
    expect(short.statusCode).toBe(409);
    expect(errorOf(short).details).toMatchObject({
      reason: 'INSUFFICIENT_STOCK',
      shortfall: [{ variantId: v, requested: 12, available: 11 }],
    });
    await call(app, 'PATCH', `/admin/inventory/stock/${b}/${v}/thresholds`, {
      user: boss,
      payload: { safetyStock: 0, reason: 'IT: reset safety stock' },
    });

    const settings = app.diContainer.resolve('settingsService');
    const actor = { userId: randomUUID(), ip: null, requestId: null };
    await settings.update(actor, {
      allowSplitAllocation: false,
      reason: 'IT: no split for a test',
    });
    try {
      const noSplit = await reserve({
        orderRef: randomUUID(),
        pinCode: pin,
        lines: [{ variantId: v, qty: 12 }],
      });
      expect(noSplit.statusCode).toBe(409);
    } finally {
      await settings.update(actor, { allowSplitAllocation: true, reason: 'IT: split back on' });
    }
  });

  it('sends cold-chain variants only to a cold-chain warehouse; unknown PIN is not serviceable', async () => {
    const res = await reserve({
      orderRef: randomUUID(),
      pinCode: pin,
      lines: [{ variantId: cold, qty: 2 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    const r = data<Reservation>(res);
    expect(r.lines.map((l) => l.warehouseId)).toEqual([b]);
    await released('order.failed.v1', r);

    const nowhere = await reserve({
      orderRef: randomUUID(),
      pinCode: randomPin(),
      lines: [{ variantId: v, qty: 1 }],
    });
    expect(nowhere.statusCode).toBe(409);
    expect(errorOf(nowhere).details?.reason).toBe('NOT_SERVICEABLE');
  });

  it('commits on order.paid (no expiry afterwards) and answers a duplicate commit again', async () => {
    const r = data<Reservation>(
      await reserve({ orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 3 }] }),
    );
    await paid(r);
    expect((await get(r.id)).status).toBe('COMMITTED');
    await expire(r.id); // past expiresAt, but committed reservations never expire
    expect((await get(r.id)).status).toBe('COMMITTED');
    await paid(r);
    const committed = await outboxEvents(app, 'inventory.reservation_committed.v1', r.id);
    expect(committed).toHaveLength(2);
    // D-56: what is held per warehouse travels with the event (the duplicate answers it too).
    for (const event of committed)
      expect((event.data as { lines: unknown[] }).lines).toEqual([
        { warehouseId: r.lines[0]?.warehouseId, variantId: v, qty: 3 },
      ]);
    await released('order.rejected.v1', r);
    expect((await get(r.id)).status).toBe('RELEASED');
    expect((await levelOf(app, a, v)).reserved).toBe(0);
  });

  it('expires an unpaid hold, then recovers it on a late payment while stock is sellable', async () => {
    const r = data<Reservation>(
      await reserve({ orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 4 }] }),
    );
    await expire(r.id);
    expect((await get(r.id)).status).toBe('EXPIRED');
    expect((await levelOf(app, a, v)).reserved).toBe(0);
    expect(await outboxEvents(app, 'inventory.reservation_expired.v1', r.id)).toHaveLength(1);

    await paid(r);
    const after = await get(r.id);
    expect(after).toMatchObject({ status: 'COMMITTED', recoveredFromExpiry: true });
    expect((await levelOf(app, a, v)).reserved).toBe(4);
    await released('order.cancelled.v1', r);
  });

  it('rejects a late payment when the stock is gone (nothing moves, order is told)', async () => {
    const r = data<Reservation>(
      await reserve({ orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 5 }] }),
    );
    expect(r.lines.map((l) => l.warehouseId)).toEqual([a]);
    await expire(r.id);
    // Someone else takes all of A's stock meanwhile.
    const other = data<Reservation>(
      await reserve({ orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 5 }] }),
    );
    expect(other.lines.map((l) => l.warehouseId)).toEqual([a]);

    await paid(r);
    expect((await get(r.id)).status).toBe('REJECTED');
    expect((await levelOf(app, a, v)).reserved).toBe(5); // only `other` holds it
    const rejected = await outboxEvents(app, 'inventory.reservation_rejected.v1', r.id);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.data).toMatchObject({ shortfall: [{ variantId: v, requested: 5 }] });

    // Releasing a rejected reservation is a no-op that still answers.
    await released('order.failed.v1', r);
    expect((await get(r.id)).status).toBe('REJECTED');
    await released('order.cancelled.v1', other);
  });

  it('releases part of a committed reservation (partial cancel), then the rest', async () => {
    const r = data<Reservation>(
      await reserve({ orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 12 }] }),
    );
    await paid(r);
    // Cancel 6 of 12: smallest held line first → A's 5, then 1 from B.
    await released('order.cancelled.v1', r, [{ variantId: v, qty: 6 }], 'PARTIAL');
    const part = await get(r.id);
    expect(part.status).toBe('COMMITTED');
    expect(part.lines.reduce((n, l) => n + l.heldQty, 0)).toBe(6);
    expect((await levelOf(app, a, v)).reserved).toBe(0);
    expect((await levelOf(app, b, v)).reserved).toBe(6);
    // Lines are per (warehouse, variant) since D-56: the warehouse read model needs the node.
    const events = await outboxEvents(app, 'inventory.reservation_released.v1', r.id);
    const releasedLines = (events.at(-1)?.data as { lines: unknown[] }).lines;
    expect(events.at(-1)?.data).toMatchObject({ scope: 'PARTIAL' });
    expect(releasedLines).toEqual(
      expect.arrayContaining([
        { warehouseId: a, variantId: v, qty: 5 },
        { warehouseId: b, variantId: v, qty: 1 },
      ]),
    );
    expect(releasedLines).toHaveLength(2);

    await released('order.cancelled.v1', r);
    expect((await get(r.id)).status).toBe('RELEASED');
    expect((await levelOf(app, b, v)).reserved).toBe(0);
  });

  it('lets an admin force-release with a reason (audited)', async () => {
    const r = data<Reservation>(
      await reserve({ orderRef: randomUUID(), pinCode: pin, lines: [{ variantId: v, qty: 1 }] }),
    );
    const res = await call(app, 'POST', `/admin/inventory/reservations/${r.id}/release`, {
      user: boss,
      payload: { reason: 'IT: order cancelled by phone' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(data<Reservation>(res).status).toBe('RELEASED');
    const twice = await call(app, 'POST', `/admin/inventory/reservations/${r.id}/release`, {
      user: boss,
      payload: { reason: 'IT: release again' },
    });
    expect(twice.statusCode).toBe(409);
  });

  it('dry-runs availability without holding anything', async () => {
    const res = await call(app, 'POST', '/internal/inventory/availability', {
      internal: true,
      payload: { pinCode: pin, lines: [{ variantId: v, qty: 15 }] },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(data(res)).toMatchObject({ fulfillable: true, split: true });
    expect((await levelOf(app, a, v)).reserved).toBe(0);
  });
});
