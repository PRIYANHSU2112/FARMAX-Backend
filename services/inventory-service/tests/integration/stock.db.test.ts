import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  errorOf,
  ledgerOnHand,
  levelOf,
  newVariant,
  newWarehouse,
  outboxEvents,
  randomPin,
  receive,
  staff,
} from './harness.js';

let app: FastifyInstance;
const boss = staff(
  'inventory.view',
  'inventory.configure',
  'inventory.receive',
  'inventory.exception_raise',
  'inventory.write_off',
  'inventory.adjust',
);
const approver = staff('inventory.view', 'inventory.adjust');
const viewer = staff('inventory.view');
const warehouses: string[] = [];

const op = (path: string, user: string, idem: string, payload: object) =>
  call(app, 'POST', `/admin/inventory/${path}`, { user, idem, payload });

describe.skipIf(DB_URL === undefined)('stock operations against Postgres', () => {
  let w: string;
  let v: string;

  beforeAll(async () => {
    app = await buildTestApp();
    w = await newWarehouse(app, boss, randomPin());
    warehouses.push(w);
    v = await newVariant(app);
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.warehouse.deleteMany({ where: { id: { in: warehouses } } });
    await app.close();
  });

  it('receives stock, writes the ledger and replays an Idempotency-Key without moving twice', async () => {
    const idem = `grn-${randomUUID()}`;
    const body = { warehouseId: w, reference: 'GRN-IT-1', lines: [{ variantId: v, qty: 100 }] };
    const first = await op('receipts', boss, idem, body);
    expect(first.statusCode, first.body).toBe(201);
    const again = await op('receipts', boss, idem, body);
    expect(again.statusCode).toBe(200);
    expect(data<{ id: string }>(again).id).toBe(data<{ id: string }>(first).id);
    expect((await levelOf(app, w, v)).onHand).toBe(100);
    expect(await ledgerOnHand(app, w, v)).toBe(100);

    const reused = await op('receipts', boss, idem, { ...body, lines: [{ variantId: v, qty: 5 }] });
    expect(reused.statusCode).toBe(422);
  });

  it('requires the Idempotency-Key header and a known, active variant', async () => {
    const noKey = await call(app, 'POST', '/admin/inventory/receipts', {
      user: boss,
      payload: { warehouseId: w, lines: [{ variantId: v, qty: 1 }] },
    });
    expect(noKey.statusCode).toBe(400);
    const inactive = await newVariant(app, { active: false });
    const res = await op('receipts', boss, `grn-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: inactive, qty: 1 }],
    });
    expect(res.statusCode).toBe(422);
  });

  it('damages only unreserved stock and writes off only damaged stock', async () => {
    const tooMuch = await op('damage', boss, `dmg-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: 1000 }],
      reason: 'IT: more than we have',
    });
    expect(tooMuch.statusCode).toBe(409);
    expect(errorOf(tooMuch).details?.reason).toBe('INSUFFICIENT_STOCK');

    const dmg = await op('damage', boss, `dmg-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: 4 }],
      reason: 'IT: four vials cracked',
    });
    expect(dmg.statusCode, dmg.body).toBe(201);
    expect(await levelOf(app, w, v)).toMatchObject({ onHand: 96, damaged: 4 });

    const wo = await op('write-offs', boss, `wo-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: 5 }],
      reason: 'IT: more than damaged',
    });
    expect(wo.statusCode).toBe(409);
    const ok = await op('write-offs', boss, `wo-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: 4 }],
      reason: 'IT: destroyed under SOP',
    });
    expect(ok.statusCode).toBe(201);
    expect(await levelOf(app, w, v)).toMatchObject({ onHand: 96, damaged: 0 });
    expect(await ledgerOnHand(app, w, v)).toBe(96);
  });

  it('adjustments wait for a DIFFERENT approver (SoD) and never go below reserved', async () => {
    const req = await op('adjustments', boss, `adj-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: -6 }],
      reason: 'IT: cycle count short by six',
    });
    expect(req.statusCode, req.body).toBe(201);
    const id = data<{ id: string; status: string }>(req).id;
    expect(data<{ status: string }>(req).status).toBe('PENDING');
    expect((await levelOf(app, w, v)).onHand).toBe(96);

    const self = await call(app, 'POST', `/admin/inventory/adjustments/${id}/approve`, {
      user: boss,
      payload: { reason: 'IT: approving my own request' },
    });
    expect(self.statusCode).toBe(403);
    const okRes = await call(app, 'POST', `/admin/inventory/adjustments/${id}/approve`, {
      user: approver,
      payload: { reason: 'IT: verified the count sheet' },
    });
    expect(okRes.statusCode, okRes.body).toBe(200);
    expect((await levelOf(app, w, v)).onHand).toBe(90);
    expect(await ledgerOnHand(app, w, v)).toBe(90);

    const twice = await call(app, 'POST', `/admin/inventory/adjustments/${id}/approve`, {
      user: approver,
      payload: { reason: 'IT: approve again' },
    });
    expect(twice.statusCode).toBe(409);

    // Hold 85 units, then try to adjust out 10 (onHand 90 − 10 < 85 reserved) → 409.
    const db = app.diContainer.resolve('db');
    await db.stockLevel.update({
      where: { warehouseId_variantId: { warehouseId: w, variantId: v } },
      data: { reserved: 85 },
    });
    const big = await op('adjustments', boss, `adj-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: -10 }],
      reason: 'IT: would cut into reserved stock',
    });
    const blocked = await call(
      app,
      'POST',
      `/admin/inventory/adjustments/${data<{ id: string }>(big).id}/approve`,
      { user: approver, payload: { reason: 'IT: should be refused' } },
    );
    expect(blocked.statusCode).toBe(409);
    await db.stockLevel.update({
      where: { warehouseId_variantId: { warehouseId: w, variantId: v } },
      data: { reserved: 0 },
    });
  });

  it('sets thresholds (staff with inventory.configure only) and lists low stock', async () => {
    const denied = await call(app, 'PATCH', `/admin/inventory/stock/${w}/${v}/thresholds`, {
      user: viewer,
      payload: { reorderLevel: 95, reason: 'IT: viewer cannot' },
    });
    expect(denied.statusCode).toBe(403);
    const res = await call(app, 'PATCH', `/admin/inventory/stock/${w}/${v}/thresholds`, {
      user: boss,
      payload: { reorderLevel: 95, safetyStock: 10, reason: 'IT: monsoon buffer' },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(data(res)).toMatchObject({ onHand: 90, safetyStock: 10, sellable: 80, lowStock: true });
    const low = await call(app, 'GET', `/admin/inventory/stock?warehouseId=${w}&lowStock=true`, {
      user: viewer,
    });
    expect(data<{ variantId: string }[]>(low).map((l) => l.variantId)).toContain(v);
  });

  it('publishes availability once per change and low stock once per dip', async () => {
    const publisher = app.diContainer.resolve('availabilityPublisher');
    // Drain everything pending (other variants too), then check this variant's events.
    for (let i = 0; i < 20 && (await publisher.publishDirty()).variants > 0; i += 1);
    const avail = await outboxEvents(app, 'inventory.availability_changed.v1', v);
    expect(avail.length).toBeGreaterThan(0);
    expect(avail.at(-1)?.data).toMatchObject({ variantId: v, availableQty: 80, lowStock: true });
    const lowOnce = await outboxEvents(app, 'inventory.low_stock.v1', v);
    expect(lowOnce).toHaveLength(1);

    // Nothing changed: re-marking the variant publishes nothing new.
    const thresholds = await call(app, 'PATCH', `/admin/inventory/stock/${w}/${v}/thresholds`, {
      user: boss,
      payload: { reorderLevel: 95, reason: 'IT: same value again' },
    });
    expect(thresholds.statusCode).toBe(200);
    for (let i = 0; i < 20 && (await publisher.publishDirty()).variants > 0; i += 1);
    expect(await outboxEvents(app, 'inventory.availability_changed.v1', v)).toHaveLength(
      avail.length,
    );
    expect(await outboxEvents(app, 'inventory.low_stock.v1', v)).toHaveLength(1);

    // Back above the threshold (silent reset), then down again → a second alert.
    await receive(app, boss, w, [{ variantId: v, qty: 50 }]);
    await publisher.publishDirty();
    const dmg = await op('damage', boss, `dmg-${randomUUID()}`, {
      warehouseId: w,
      lines: [{ variantId: v, qty: 50 }],
      reason: 'IT: second dip below reorder level',
    });
    expect(dmg.statusCode).toBe(201);
    await publisher.publishDirty();
    expect(await outboxEvents(app, 'inventory.low_stock.v1', v)).toHaveLength(2);
  });
});
