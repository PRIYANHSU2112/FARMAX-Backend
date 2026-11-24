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
  outbox,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-57a Phase 1: stock core + cutover against the real local Postgres. */
let app: FastifyInstance;
let w: string;
let bins: string[] = [];
const ALL = [
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.configure',
  'inventory.receive',
  'inventory.adjust',
  'inventory.write_off',
  'inventory.transfer',
  'inventory.lifecycle_approve',
  'quality.hold_create',
  'quality.hold_release',
  'vendors.manage',
  'fulfilment.manage',
];
const admin = staff(ALL);
const admin2 = staff(ALL);
const viewer = staff(['warehouse.view', 'inventory.view']);
const A = randomUUID();
const B = randomUUID();
const MMB = `MM-${B.slice(0, 4).toUpperCase()}`;
const idem = () => ({ 'idempotency-key': randomUUID() });

const facts = (variantId: string, sku: string, name: string) => ({
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
});

const summary = async (variantId: string) =>
  app.diContainer.resolve('db').wmsStockSummary.findUnique({
    where: { warehouseId_variantId: { warehouseId: w, variantId } },
  });

const stockEvents = async () =>
  (await outbox(app, 'warehouse.stock_changed.v1', w)) as {
    kind: string;
    lines: { variantId: string; sellableDelta: number; damagedDelta: number }[];
  }[];

/** Inventory snapshot = what inventory would hold if it matched the WMS (+ extra rows). */
const snapshotFromWms = async (extra: Record<string, unknown>[] = []) => {
  const rows = await app.diContainer.resolve('stockRepository').summaryTotals();
  const seen = new Set(extra.map((e) => `${String(e.warehouseId)}|${String(e.variantId)}`));
  return [
    ...rows
      .filter((r) => !seen.has(`${r.warehouseId}|${r.variantId}`))
      .map((r, i) => ({
        id: `wms-${String(i)}`,
        warehouseId: r.warehouseId,
        variantId: r.variantId,
        onHand: r.sellable,
        damaged: r.damaged,
        reserved: 0,
        safetyStock: 0,
        reorderLevel: 0,
      })),
    ...extra,
  ];
};

describe.skipIf(DB_URL === undefined)('D-57a stock core against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    // Each run starts before the cutover (the writes mode is global).
    await app.diContainer
      .resolve('db')
      .wmsSetting.deleteMany({ where: { key: { in: ['stock.writesMode', 'stock.cutover'] } } });
    inventoryCutover.mode = 'INVENTORY';
    productFacts.set(A, facts(A, `LF-${A.slice(0, 4)}`, 'Layer Feed 50 kg'));
    productFacts.set(B, facts(B, `MM-${B.slice(0, 4)}`, 'Mineral Mix 25 kg'));
    const res = await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('st'),
      name: 'IT Stock Depot',
      type: 'DEPOT',
      addressLine: 'Plot 9, Industrial Estate',
      city: 'Eluru',
      district: 'Eluru',
      stateCode: '37',
      pinCode: '534001',
      temperatureClasses: ['AMB'],
    });
    w = data<{ id: string }>(res).id;
    const zone = data<{ id: string }>(
      await call(app, 'POST', `/admin/warehouses/${w}/zones`, admin, {
        code: 'A',
        name: 'Feed',
        temperatureClass: 'AMB',
      }),
    );
    const rack = await call(app, 'POST', `/admin/warehouses/${w}/zones/${zone.id}/racks`, admin, {
      maxWeightKg: 9000,
      volumeM3: 30,
      generateBins: { count: 3, maxWeightKg: 3000, volumeM3: 10 },
    });
    expect(rack.statusCode, rack.body).toBe(201);
    const list = data<{ id: string }[]>(
      await call(app, 'GET', `/admin/warehouses/${w}/bins?limit=10`, admin),
    );
    bins = list.map((b) => b.id);
  });

  afterAll(async () => {
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.update({ where: { id: w }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('refuses stock writes before the cutover (423 STOCK_NOT_CUTOVER)', async () => {
    const res = await call(
      app,
      'POST',
      '/wms/stock/receipts',
      admin,
      {
        warehouseId: w,
        lines: [{ variantId: A, batchNo: 'LF-2608', qty: 5 }],
      },
      idem(),
    );
    expect(res.statusCode).toBe(423);
    expect(errorOf(res).details?.reason).toBe('STOCK_NOT_CUTOVER');
  });

  it('cutover: freeze → run (opening balance, verify) → active; panel cannot run it', async () => {
    const panel = await call(app, 'POST', '/wms/stock/cutover/freeze', admin, {
      reason: 'go live',
    });
    expect(panel.statusCode).toBe(404);
    inventoryCutover.pending = [{ id: randomUUID() }];
    const frozen = await call(app, 'POST', '/admin/wms/stock/cutover/freeze', admin, {
      reason: 'Go live D-57a',
    });
    expect(frozen.statusCode, frozen.body).toBe(200);
    expect(inventoryCutover.mode).toBe('FROZEN');
    const banner = data<{ active: boolean }>(
      await call(app, 'GET', '/wms/ops/maintenance', viewer),
    );
    expect(banner.active).toBe(true);

    inventoryCutover.levels = await snapshotFromWms([
      {
        id: 'lvl-a',
        warehouseId: w,
        variantId: A,
        onHand: 10,
        damaged: 1,
        reserved: 0,
        safetyStock: 2,
        reorderLevel: 5,
      },
    ]);
    const run = await call(app, 'POST', '/admin/wms/stock/cutover/run', admin);
    expect(run.statusCode, run.body).toBe(200);
    const report = data<{
      report: { imported: number; mismatchCount: number; rejectedOperations: string[] };
    }>(run).report;
    expect(report.mismatchCount).toBe(0);
    expect(report.rejectedOperations).toHaveLength(1);
    expect(inventoryCutover.mode).toBe('WMS');
    const s = await summary(A);
    expect(s).toMatchObject({ available: 10, damaged: 1, expiryUnknown: 11 });
    // The opening import is silent (inventory already holds these totals).
    expect((await stockEvents()).filter((e) => e.kind === 'OPENING')).toHaveLength(0);
  });

  it('receive → QC hold (no inventory event) → release sends +sellable; idempotent replay', async () => {
    const key = idem();
    const body = {
      warehouseId: w,
      lines: [
        {
          variantId: A,
          batchNo: 'lf-2608',
          mfgDate: '2026-08-12',
          expiryDate: '2027-01-15',
          qty: 40,
          binId: bins[0],
        },
        { variantId: B, batchNo: MMB, expiryDate: '2027-06-30', qty: 20, binId: bins[1] },
      ],
    };
    const first = await call(app, 'POST', '/wms/stock/receipts', admin, body, key);
    expect(first.statusCode, first.body).toBe(201);
    const r = data<{ id: string; cnNo: string; lines: { batchNo: string; status: string }[] }>(
      first,
    );
    expect(r.cnNo).toMatch(/^CN-\d{4}-\d{4}$/);
    expect(r.lines[0]).toMatchObject({ batchNo: 'LF-2608', status: 'QC_HOLD' });
    const again = await call(app, 'POST', '/wms/stock/receipts', admin, body, key);
    expect(data<{ id: string }>(again).id).toBe(r.id);
    expect(await summary(A)).toMatchObject({ qcHold: 40, available: 10 });

    const batchId = await app.diContainer
      .resolve('db')
      .wmsBatch.findFirstOrThrow({ where: { variantId: A, batchNo: 'LF-2608' } });
    const rel = await call(app, 'POST', '/wms/stock/quality/release', admin, {
      warehouseId: w,
      batchId: batchId.id,
      qty: 30,
    });
    expect(rel.statusCode, rel.body).toBe(200);
    expect(await summary(A)).toMatchObject({ qcHold: 10, available: 40 });
    const ev = (await stockEvents()).filter((e) => e.kind === 'QC_RELEASE');
    expect(ev.at(-1)?.lines).toEqual([{ variantId: A, sellableDelta: 30, damagedDelta: 0 }]);
  });

  it('lifecycle guards: unknown move 409, flow-only move 409, missing permission 403', async () => {
    const pos = await app.diContainer.resolve('db').wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, variantId: A, binId: bins[0] ?? null },
    });
    const notListed = await call(app, 'POST', '/wms/stock/status-changes', admin, {
      positionId: pos.id,
      from: 'AVAILABLE',
      to: 'RETURNED',
      qty: 1,
      reason: 'test move',
    });
    expect(errorOf(notListed).details?.reason).toBe('TRANSITION_NOT_ALLOWED');
    const flow = await call(app, 'POST', '/wms/stock/status-changes', admin, {
      positionId: pos.id,
      from: 'AVAILABLE',
      to: 'RESERVED',
      qty: 1,
      reason: 'test move',
    });
    expect(flow.statusCode).toBe(409);
    const holder = staff(['warehouse.view', 'quality.hold_create']);
    const denied = await call(app, 'POST', '/wms/stock/status-changes', holder, {
      positionId: pos.id,
      from: 'AVAILABLE',
      to: 'DAMAGED',
      qty: 1,
      reason: 'torn bags',
    });
    expect(denied.statusCode).toBe(403);
    const damaged = await call(app, 'POST', '/wms/stock/status-changes', admin, {
      positionId: pos.id,
      from: 'AVAILABLE',
      to: 'DAMAGED',
      qty: 2,
      reason: 'torn bags',
    });
    expect(damaged.statusCode, damaged.body).toBe(200);
    const ev = (await stockEvents()).filter((e) => e.kind === 'DAMAGE').at(-1);
    expect(ev?.lines[0]).toMatchObject({ sellableDelta: -2, damagedDelta: 2 });
  });

  it('20 parallel 1-unit damages on 5 available units: exactly 5 succeed, never negative', async () => {
    const pos = await app.diContainer.resolve('db').wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, variantId: B, binId: bins[1] ?? null },
    });
    await call(app, 'POST', '/wms/stock/quality/release', admin, {
      warehouseId: w,
      batchId: pos.batchId,
      qty: 5,
    });
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        call(app, 'POST', '/wms/stock/status-changes', admin, {
          positionId: pos.id,
          from: 'AVAILABLE',
          to: 'DAMAGED',
          qty: 1,
          reason: 'parallel test',
        }),
      ),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(5);
    expect(results.filter((r) => r.statusCode === 409)).toHaveLength(15);
    expect(await summary(B)).toMatchObject({ available: 0, damaged: 5 });
  });

  it('bin move, owner fix and opening relabel clear review fields', async () => {
    const db = app.diContainer.resolve('db');
    const opening = await db.wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, variantId: A, binId: null },
    });
    expect(opening.reviewFields).toEqual(['ownerType', 'bin', 'batch']);
    const vendor = data<{ id: string }>(
      await call(app, 'POST', '/admin/wms/vendors', admin, {
        code: randomCode('V').slice(0, 20),
        name: 'ABC Feeds',
        defaultOwnership: 'SOR',
      }),
    );
    const owner = await call(app, 'POST', `/wms/stock/positions/${opening.id}/owner`, admin, {
      ownerType: 'SOR',
      vendorId: vendor.id,
      reason: 'Consignment stock from ABC Feeds',
    });
    expect(owner.statusCode, owner.body).toBe(200);
    const sor = await db.wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, variantId: A, binId: null, ownerType: 'SOR' },
    });
    expect(sor.reviewFields).toEqual(['bin', 'batch']);
    const relabel = await call(app, 'POST', `/wms/stock/opening/${sor.id}/relabel`, admin, {
      reason: 'Physical count of opening stock',
      splits: [{ batchNo: 'LF-2501', expiryDate: '2026-12-31', binId: bins[2], qty: 6 }],
    });
    expect(relabel.statusCode, relabel.body).toBe(200);
    const moved = await db.wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, variantId: A, binId: bins[2] ?? null },
    });
    expect(moved).toMatchObject({ available: 6, reviewFields: [] });
    expect(await summary(A)).toMatchObject({ expiryUnknown: 5 });
  });

  it('adjustments: small applies, large waits for a second person', async () => {
    const pos = await app.diContainer.resolve('db').wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, variantId: A, binId: bins[0] ?? null },
    });
    const small = await call(
      app,
      'POST',
      '/wms/stock/adjustments',
      admin,
      {
        warehouseId: w,
        reasonCode: 'CYCLE_COUNT',
        lines: [{ positionId: pos.id, status: 'AVAILABLE', delta: -1 }],
      },
      idem(),
    );
    expect(data<{ status: string; adjNo: string }>(small)).toMatchObject({ status: 'APPLIED' });
    const big = data<{ id: string; status: string; version: number }>(
      await call(
        app,
        'POST',
        '/wms/stock/adjustments',
        admin,
        {
          warehouseId: w,
          reasonCode: 'FOUND_STOCK',
          lines: [{ positionId: pos.id, status: 'AVAILABLE', delta: 60 }],
        },
        idem(),
      ),
    );
    expect(big.status).toBe('PENDING_APPROVAL');
    const self = await call(app, 'POST', `/wms/stock/adjustments/${big.id}/approve`, admin, {
      expectedVersion: big.version,
    });
    expect(self.statusCode).toBe(403);
    const before = (await summary(A))?.available ?? 0;
    const ok = await call(app, 'POST', `/wms/stock/adjustments/${big.id}/approve`, admin2, {
      expectedVersion: big.version,
      note: 'Verified by count',
    });
    expect(data<{ status: string }>(ok).status).toBe('APPLIED');
    expect((await summary(A))?.available).toBe(before + 60);
  });

  it('unit QR follows the batch (FX-<batch>-<seq>) and stays in step with the columns', async () => {
    const db = app.diContainer.resolve('db');
    const batch = await db.wmsBatch.findFirstOrThrow({ where: { variantId: B, batchNo: MMB } });
    const gen = await call(app, 'POST', `/wms/stock/batches/${batch.id}/units/generate`, admin, {
      warehouseId: w,
    });
    expect(gen.statusCode, gen.body).toBe(201);
    expect(data<{ generated: number }>(gen).generated).toBe(20);
    const first = await db.wmsStockUnit.findFirstOrThrow({ where: { batchId: batch.id, seq: 1 } });
    expect(first.qrCode).toBe(`FX-${MMB}-0001`);
    const twice = await call(app, 'POST', `/wms/stock/batches/${batch.id}/units/generate`, admin, {
      warehouseId: w,
    });
    expect(errorOf(twice).details?.reason).toBe('QR_ALREADY_GENERATED');
    const pos = await db.wmsStockPosition.findFirstOrThrow({
      where: { warehouseId: w, batchId: batch.id, binId: bins[1] ?? null },
    });
    const move = await call(app, 'POST', '/wms/stock/moves', admin, {
      positionId: pos.id,
      toBinId: bins[2],
      qty: 3,
      status: 'DAMAGED',
    });
    expect(move.statusCode, move.body).toBe(200);
    const mismatches = await app.diContainer.resolve('stockRepository').unitMismatches(50);
    expect(mismatches.filter((m) => m.batchId === batch.id)).toEqual([]);
  });

  it('thresholds are WMS-owned and published one way', async () => {
    const res = await call(app, 'PUT', `/wms/stock/thresholds/${w}/${A}`, admin, {
      safetyStock: 5,
      reorderLevel: 50,
      targetStock: 150,
    });
    expect(res.statusCode, res.body).toBe(200);
    const bad = await call(app, 'PUT', `/wms/stock/thresholds/${w}/${A}`, admin, {
      safetyStock: 5,
      reorderLevel: 50,
      targetStock: 10,
    });
    expect(bad.statusCode).toBe(422);
    const ev = await outbox(app, 'warehouse.thresholds_changed.v1', w);
    expect(ev.at(-1)).toMatchObject({ variantId: A, reorderLevel: 50, targetStock: 150 });
  });

  it('lifecycle proposals: proposer cannot approve; admin panel only', async () => {
    const p = data<{ id: string }>(
      await call(app, 'POST', '/wms/stock/lifecycle/proposals', admin, {
        from: 'QUARANTINED',
        to: 'DAMAGED',
        reasonEvent: 'Investigation found physical damage',
      }),
    );
    expect(
      (await call(app, 'POST', `/wms/stock/lifecycle/proposals/${p.id}/approve`, admin2, {}))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call(app, 'POST', `/admin/wms/stock/lifecycle/proposals/${p.id}/approve`, admin, {
          permissionKey: 'quality.hold_create',
        })
      ).statusCode,
    ).toBe(403);
    const ok = await call(
      app,
      'POST',
      `/admin/wms/stock/lifecycle/proposals/${p.id}/approve`,
      admin2,
      {
        permissionKey: 'quality.hold_create',
        roleLabel: 'Quality team',
      },
    );
    expect(data<{ status: string }>(ok).status).toBe('APPROVED');
    const rows = data<{ from: string; to: string }[]>(
      await call(app, 'GET', '/wms/stock/lifecycle/transitions', viewer),
    );
    expect(rows.some((r) => r.from === 'QUARANTINED' && r.to === 'DAMAGED')).toBe(true);
    // Remove it again so other runs start from the seed.
    await app.diContainer.resolve('db').wmsStatusTransition.deleteMany({
      where: { fromStatus: 'QUARANTINED', toStatus: 'DAMAGED' },
    });
  });

  it('product events fill the projection (version-guarded)', async () => {
    const v = randomUUID();
    await deliver(app, 'product.variant_created.v1', {
      ...facts(v, 'CF-050', 'Cattle Feed'),
      version: 3,
    });
    await deliver(app, 'product.variant_updated.v1', {
      ...facts(v, 'CF-050', 'Old name'),
      version: 2,
    });
    const row = await app.diContainer
      .resolve('db')
      .wmsVariantProjection.findUniqueOrThrow({ where: { variantId: v } });
    expect(row).toMatchObject({ name: 'Cattle Feed', packLabel: '50 KG' });
  });

  it('rollback within the window keeps WMS data; re-cutover replays inventory changes', async () => {
    const before = await summary(A);
    const rb = await call(app, 'POST', '/admin/wms/stock/cutover/rollback', admin, {
      reason: 'Practice rollback',
    });
    expect(rb.statusCode, rb.body).toBe(200);
    expect(inventoryCutover.mode).toBe('INVENTORY');
    const blocked = await call(app, 'POST', '/wms/stock/moves', admin, {
      positionId: randomUUID(),
      toBinId: bins[0],
      qty: 1,
    });
    expect([404, 423]).toContain(blocked.statusCode);
    // While inventory owned stock again, it received 7 units of A.
    inventoryCutover.ledger = [
      {
        id: 'l1',
        warehouseId: w,
        variantId: A,
        type: 'RECEIVE',
        onHandDelta: 7,
        damagedDelta: 0,
        createdAt: new Date().toISOString(),
      },
    ];
    await call(app, 'POST', '/admin/wms/stock/cutover/freeze', admin, {
      reason: 'Re-cutover after drill',
    });
    const sellable =
      (before?.available ?? 0) +
      (before?.reserved ?? 0) +
      (before?.picked ?? 0) +
      (before?.packed ?? 0);
    inventoryCutover.levels = await snapshotFromWms([
      {
        id: 'lvl-a2',
        warehouseId: w,
        variantId: A,
        onHand: sellable + 7,
        damaged: before?.damaged ?? 0,
        reserved: 0,
        safetyStock: 0,
        reorderLevel: 0,
      },
    ]);
    const run = await call(app, 'POST', '/admin/wms/stock/cutover/run', admin);
    expect(run.statusCode, run.body).toBe(200);
    expect(data<{ report: { replayed: number } }>(run).report.replayed).toBe(1);
    expect((await summary(A))?.available).toBe((before?.available ?? 0) + 7);
  });
});
