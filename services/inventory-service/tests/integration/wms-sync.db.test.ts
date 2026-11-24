import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DB_URL,
  buildTestApp,
  call,
  deliver,
  errorOf,
  ledgerOnHand,
  levelOf,
  newVariant,
  newWarehouse,
  randomPin,
  receive,
  staff,
} from './harness.js';

/** D-57a: inventory fed by warehouse-service + the cutover handshake. */
let app: FastifyInstance;
const admin = staff(
  'inventory.view',
  'inventory.receive',
  'inventory.adjust',
  'inventory.configure',
  'inventory.exception_raise',
);
let w: string;
let v: string;

const internal = (method: 'GET' | 'POST', url: string, payload?: object) =>
  call(app, method, url, { internal: true, ...(payload === undefined ? {} : { payload }) });

describe.skipIf(DB_URL === undefined)('WMS sync against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    w = await newWarehouse(app, admin, randomPin());
    v = await newVariant(app);
    await receive(app, admin, w, [{ variantId: v, qty: 20 }]);
  });

  afterAll(async () => {
    // The writes mode is global: leave inventory owning stock for the other test files.
    await app.diContainer
      .resolve('db')
      .inventorySetting.deleteMany({ where: { key: 'stock.writesMode' } });
    await app.close();
  });

  it('applies WMS deltas once per event with a ledger row; negative result throws', async () => {
    await deliver(app, 'warehouse.stock_changed.v1', {
      movementId: randomUUID(),
      warehouseId: w,
      kind: 'QC_HOLD',
      refNo: null,
      lines: [{ variantId: v, sellableDelta: -5, damagedDelta: 0 }],
      actorUserId: null,
    });
    await deliver(app, 'warehouse.stock_changed.v1', {
      movementId: randomUUID(),
      warehouseId: w,
      kind: 'DAMAGE',
      refNo: null,
      lines: [{ variantId: v, sellableDelta: -2, damagedDelta: 2 }],
      actorUserId: null,
    });
    expect(await levelOf(app, w, v)).toMatchObject({ onHand: 13, damaged: 2 });
    expect(await ledgerOnHand(app, w, v)).toBe(13);
    const ledger = await app.diContainer
      .resolve('db')
      .stockLedgerEntry.findMany({
        where: { warehouseId: w, variantId: v, refType: 'wms_movement' },
      });
    expect(ledger.map((l) => l.type).sort()).toEqual(['DAMAGE', 'QUALITY_HOLD']);
    await expect(
      deliver(app, 'warehouse.stock_changed.v1', {
        movementId: randomUUID(),
        warehouseId: w,
        kind: 'ADJUSTMENT',
        refNo: null,
        lines: [{ variantId: v, sellableDelta: -500, damagedDelta: 0 }],
        actorUserId: null,
      }),
    ).rejects.toThrow(/negative/);
    expect((await levelOf(app, w, v)).onHand).toBe(13);
  });

  it('thresholds copy is version-guarded', async () => {
    const t = { warehouseId: w, variantId: v, safetyStock: 4, reorderLevel: 9, targetStock: 30 };
    await deliver(app, 'warehouse.thresholds_changed.v1', { ...t, version: 2 });
    await deliver(app, 'warehouse.thresholds_changed.v1', { ...t, safetyStock: 99, version: 1 });
    expect((await levelOf(app, w, v)).safetyStock).toBe(4);
  });

  it('cutover: freeze (423 on writes) → reject pending → activate (410) → rollback', async () => {
    const pending = await call(app, 'POST', '/admin/inventory/adjustments', {
      user: admin,
      idem: `it-${randomUUID()}`,
      payload: { warehouseId: w, reason: 'Count correction', lines: [{ variantId: v, qty: 1 }] },
    });
    expect(pending.statusCode, pending.body).toBe(201);
    expect(
      (await internal('POST', '/internal/inventory/cutover/freeze', { by: null })).statusCode,
    ).toBe(200);
    const frozen = await call(app, 'POST', '/admin/inventory/receipts', {
      user: admin,
      idem: `it-${randomUUID()}`,
      payload: { warehouseId: w, lines: [{ variantId: v, qty: 1 }] },
    });
    expect(frozen.statusCode).toBe(423);
    expect(errorOf(frozen).details?.reason).toBe('STOCK_WRITES_FROZEN');
    const state = (await internal('GET', '/internal/inventory/cutover/state')).json<{
      data: { mode: string; pendingOperations: unknown[] };
    }>().data;
    expect(state.mode).toBe('FROZEN');
    expect(state.pendingOperations.length).toBeGreaterThan(0);
    const rejected = await internal('POST', '/internal/inventory/cutover/reject-pending', {
      reason: 'CUTOVER_MOVED_TO_WMS',
    });
    expect(rejected.json<{ data: string[] }>().data.length).toBeGreaterThan(0);
    const snap = await internal('GET', '/internal/inventory/cutover/snapshot?limit=5000');
    expect(snap.json<{ data: { variantId: string }[] }>().data.some((l) => l.variantId === v)).toBe(
      true,
    );
    expect((await internal('POST', '/internal/inventory/cutover/activate', {})).statusCode).toBe(
      200,
    );
    const moved = await call(app, 'POST', '/admin/inventory/receipts', {
      user: admin,
      idem: `it-${randomUUID()}`,
      payload: { warehouseId: w, lines: [{ variantId: v, qty: 1 }] },
    });
    expect(moved.statusCode).toBe(410);
    expect(errorOf(moved).details?.reason).toBe('MOVED_TO_WAREHOUSE_SERVICE');
    const wrong = await internal('POST', '/internal/inventory/cutover/freeze', {});
    expect(wrong.statusCode).toBe(409);
    expect((await internal('POST', '/internal/inventory/cutover/rollback', {})).statusCode).toBe(
      200,
    );
    const since = await internal(
      'GET',
      `/internal/inventory/cutover/ledger-since?since=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`,
    );
    expect(since.statusCode).toBe(200);
  });
});
