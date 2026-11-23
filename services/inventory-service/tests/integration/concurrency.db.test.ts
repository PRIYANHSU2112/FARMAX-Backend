import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

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

interface Reservation {
  id: string;
  orderRef: string;
  status: string;
  lines: { warehouseId: string; variantId: string; qty: number }[];
}

let app: FastifyInstance;
const boss = staff('inventory.view', 'inventory.configure', 'inventory.receive');
const warehouses: string[] = [];

const reserve = (pin: string, variantId: string, qty: number) =>
  call(app, 'POST', '/internal/inventory/reservations', {
    internal: true,
    idem: `rsv-${randomUUID()}`,
    payload: { orderRef: randomUUID(), pinCode: pin, lines: [{ variantId, qty }] },
  });

const orderEvent = (type: string, r: Reservation) =>
  deliver(app, type, {
    orderId: r.orderRef,
    orderNo: 'ORD-26-IT',
    reservationId: r.id,
    paymentId: 'pay-it',
    amount: '1.00',
    scope: 'FULL',
    lines: [],
    reasonCode: 'IT',
  });

const statusOf = async (id: string) =>
  (await app.diContainer.resolve('db').stockReservation.findUniqueOrThrow({ where: { id } }))
    .status;

// Hundreds of real transactions per test (Docker Desktop Postgres has a slow fsync on Windows).
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(DB_URL === undefined)('reservation concurrency against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.warehouse.deleteMany({ where: { id: { in: warehouses } } });
    await app.close();
  });

  it('200 parallel reserves against 50 units: exactly 50 succeed, nothing oversold', async () => {
    const pin = randomPin();
    const w = await newWarehouse(app, boss, pin);
    warehouses.push(w);
    const v = await newVariant(app);
    await receive(app, boss, w, [{ variantId: v, qty: 50 }]);

    const started = Date.now();
    const results = await Promise.all(Array.from({ length: 200 }, () => reserve(pin, v, 1)));
    // Generous bound for Docker Desktop Postgres; a regression to lock waits would blow it.
    expect(Date.now() - started).toBeLessThan(30_000);
    const ok = results.filter((r) => r.statusCode === 201);
    const refused = results.filter((r) => r.statusCode === 409);
    expect(ok).toHaveLength(50);
    expect(refused).toHaveLength(150);
    expect(refused.every((r) => errorOf(r).details?.reason === 'INSUFFICIENT_STOCK')).toBe(true);
    expect(await levelOf(app, w, v)).toMatchObject({ onHand: 50, reserved: 50 });
  });

  it('mixed quantities with split across two warehouses never exceed stock', async () => {
    const pin = randomPin();
    const a = await newWarehouse(app, boss, pin, { priority: 1 });
    const b = await newWarehouse(app, boss, pin, { priority: 2 });
    warehouses.push(a, b);
    const v = await newVariant(app);
    await receive(app, boss, a, [{ variantId: v, qty: 40 }]);
    await receive(app, boss, b, [{ variantId: v, qty: 35 }]);

    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) => reserve(pin, v, (i % 4) + 1)),
    );
    const held = results
      .filter((r) => r.statusCode === 201)
      .flatMap((r) => data<Reservation>(r).lines)
      .reduce((n, l) => n + l.qty, 0);
    const la = await levelOf(app, a, v);
    const lb = await levelOf(app, b, v);
    expect(la.reserved + lb.reserved).toBe(held);
    expect(la.reserved).toBeLessThanOrEqual(40);
    expect(lb.reserved).toBeLessThanOrEqual(35);
    expect(held).toBeGreaterThan(60); // nearly all 75 units go out under contention
    expect(results.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
  });

  it('commit racing release on the same reservation ends RELEASED with nothing held', async () => {
    const pin = randomPin();
    const w = await newWarehouse(app, boss, pin);
    warehouses.push(w);
    const v = await newVariant(app);
    await receive(app, boss, w, [{ variantId: v, qty: 20 }]);
    const rs = await Promise.all(Array.from({ length: 10 }, () => reserve(pin, v, 2)));
    const reservations = rs.map((r) => data<Reservation>(r));
    await Promise.all(
      reservations.flatMap((r) => [
        orderEvent('order.paid.v1', r),
        orderEvent('order.cancelled.v1', r),
      ]),
    );
    for (const r of reservations) expect(await statusOf(r.id)).toBe('RELEASED');
    expect((await levelOf(app, w, v)).reserved).toBe(0);
  });

  it('two expiry workers at once release each hold exactly once', async () => {
    const pin = randomPin();
    const w = await newWarehouse(app, boss, pin);
    warehouses.push(w);
    const v = await newVariant(app);
    await receive(app, boss, w, [{ variantId: v, qty: 30 }]);
    const rs = (await Promise.all(Array.from({ length: 30 }, () => reserve(pin, v, 1)))).map((r) =>
      data<Reservation>(r),
    );
    const db = app.diContainer.resolve('db');
    await db.stockReservation.updateMany({
      where: { id: { in: rs.map((r) => r.id) } },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const svc = app.diContainer.resolve('reservationsService');
    const [x, y] = await Promise.all([svc.expireDue(), svc.expireDue()]);
    expect(x.expired + y.expired).toBeGreaterThanOrEqual(30);
    expect((await levelOf(app, w, v)).reserved).toBe(0);
    for (const r of rs) {
      expect(await statusOf(r.id)).toBe('EXPIRED');
      expect(await outboxEvents(app, 'inventory.reservation_expired.v1', r.id)).toHaveLength(1);
    }
  });

  it('a late payment racing a new order for the last units: exactly one gets them', async () => {
    const pin = randomPin();
    const w = await newWarehouse(app, boss, pin);
    warehouses.push(w);
    const v = await newVariant(app);
    await receive(app, boss, w, [{ variantId: v, qty: 5 }]);
    for (let round = 0; round < 5; round += 1) {
      const first = data<Reservation>(await reserve(pin, v, 5));
      await app.diContainer
        .resolve('db')
        .stockReservation.update({ where: { id: first.id }, data: { expiresAt: new Date(0) } });
      await app.diContainer.resolve('reservationsService').expireDue();

      const [, second] = await Promise.all([
        orderEvent('order.paid.v1', first),
        reserve(pin, v, 5),
      ]);
      const recovered = (await statusOf(first.id)) === 'COMMITTED';
      const newOk = second.statusCode === 201;
      expect(recovered !== newOk).toBe(true); // exactly one winner
      expect((await levelOf(app, w, v)).reserved).toBe(5);

      // Reset for the next round.
      if (recovered) await orderEvent('order.cancelled.v1', first);
      if (newOk) await orderEvent('order.cancelled.v1', data<Reservation>(second));
      expect((await levelOf(app, w, v)).reserved).toBe(0);
    }
  });
});
