import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  deliver,
  randomPin,
  staff,
  warehouseFacts,
} from './harness.js';

/**
 * The warehouse projection (D-56): warehouse-service owns the master data; inventory applies
 * `warehouse.upserted.v1` / `warehouse.coverage_replaced.v1` (version-guarded, same ids).
 */
let app: FastifyInstance;
const created: string[] = [];
const configurer = staff('inventory.view', 'inventory.configure');
const viewer = staff('inventory.view');

const project = async (o: Record<string, unknown> = {}) => {
  const facts = warehouseFacts(o);
  created.push(facts.warehouseId);
  await deliver(app, 'warehouse.upserted.v1', facts);
  return facts;
};
const cover = (warehouseId: string, coverageVersion: number, entries: object[]) =>
  deliver(app, 'warehouse.coverage_replaced.v1', { warehouseId, coverageVersion, entries });
const row = (id: string) => app.diContainer.resolve('db').warehouse.findUnique({ where: { id } });
const candidates = (pin: string) =>
  app.diContainer.resolve('warehousesService').candidatesForPin(pin);

describe.skipIf(DB_URL === undefined)('warehouse projection + settings against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.warehouse.deleteMany({ where: { id: { in: created } } });
    await app.close();
  });

  it('maps status and temperature classes onto the allocation flags', async () => {
    const active = await project({ temperatureClasses: ['AMB', 'CC_FRZ'] });
    expect(await row(active.warehouseId)).toMatchObject({
      isActive: true,
      isAllocatable: true,
      hasColdChain: true,
    });
    const limited = await project({ status: 'LIMITED' });
    expect(await row(limited.warehouseId)).toMatchObject({ isActive: true, isAllocatable: false });
    const draft = await project({ status: 'SETUP' });
    expect(await row(draft.warehouseId)).toMatchObject({ isActive: false, isAllocatable: false });
    const switchedOff = await project({ isAllocatable: false });
    expect(await row(switchedOff.warehouseId)).toMatchObject({ isAllocatable: false });
  });

  it('applies only newer versions (duplicates and out-of-order events are no-ops)', async () => {
    const w = await project({ version: 3, name: 'Third' });
    await deliver(app, 'warehouse.upserted.v1', { ...w, version: 2, name: 'Second (late)' });
    await deliver(app, 'warehouse.upserted.v1', { ...w, version: 3, name: 'Third (duplicate)' });
    expect((await row(w.warehouseId))?.name).toBe('Third');
    await deliver(app, 'warehouse.upserted.v1', { ...w, version: 4, name: 'Fourth' });
    expect((await row(w.warehouseId))?.name).toBe('Fourth');
  });

  it('replaces coverage by coverage version and serves candidates in priority order', async () => {
    const pin = randomPin();
    const a = await project({ priority: 50 });
    const b = await project({ priority: 10 });
    await cover(a.warehouseId, 1, [{ pinCode: pin, priority: 1 }]);
    await cover(b.warehouseId, 1, [{ pinCode: pin, priority: 1 }]);
    expect((await candidates(pin)).map((c) => c.warehouseId)).toEqual([
      b.warehouseId,
      a.warehouseId,
    ]);
    // A stale coverage event changes nothing; a newer one replaces the whole list.
    await cover(b.warehouseId, 1, []);
    expect(await candidates(pin)).toHaveLength(2);
    await cover(b.warehouseId, 2, [{ pinCode: randomPin(), priority: 1 }]);
    expect((await candidates(pin)).map((c) => c.warehouseId)).toEqual([a.warehouseId]);
  });

  it('a limited warehouse leaves allocation at once (cache invalidated)', async () => {
    const pin = randomPin();
    const w = await project();
    await cover(w.warehouseId, 1, [{ pinCode: pin, priority: 1 }]);
    expect(await candidates(pin)).toHaveLength(1);
    await deliver(app, 'warehouse.upserted.v1', { ...w, version: 2, status: 'LIMITED' });
    expect(await candidates(pin)).toHaveLength(0);
  });

  it('coverage for a warehouse not projected yet fails so the consumer retries it', async () => {
    await expect(
      cover('0193a5f2-7c1e-7b2a-9f00-00000000dead', 1, [{ pinCode: randomPin(), priority: 1 }]),
    ).rejects.toThrow(/not projected yet/);
  });

  it('removes a discarded draft', async () => {
    const draft = await project({ status: 'SETUP' });
    await deliver(app, 'warehouse.upserted.v1', { ...draft, version: 2, deleted: true });
    expect(await row(draft.warehouseId)).toBeNull();
  });

  it('no longer exposes warehouse admin routes (warehouse-service owns them)', async () => {
    const res = await call(app, 'GET', '/admin/inventory/warehouses', { user: configurer });
    expect(res.statusCode).toBe(404);
  });

  it('reads settings and refuses an out-of-range TTL', async () => {
    const res = await call(app, 'GET', '/admin/inventory/settings', { user: viewer });
    expect(res.statusCode).toBe(200);
    expect(data(res)).toMatchObject({ reservationTtlSeconds: expect.any(Number) as number });
    const bad = await call(app, 'PATCH', '/admin/inventory/settings', {
      user: configurer,
      payload: { reservationTtlSeconds: 5, reason: 'IT too short a hold' },
    });
    expect(bad.statusCode).toBe(422);
  });
});
