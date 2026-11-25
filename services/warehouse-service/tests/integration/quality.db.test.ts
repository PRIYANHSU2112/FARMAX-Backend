import { randomUUID } from 'node:crypto';

import type { EventEnvelope } from '@farmx/infra/events';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  DB_URL,
  buildTestApp,
  call,
  data,
  errorOf,
  inventoryCutover,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/**
 * D-60 warehouse side of quality decisions: SKU policy → QC_HOLD on receipt, receipt event,
 * release guard, one task per warehouse (own transaction each), retry after failure, never a
 * double move, late receipts of a blocked batch, superseded older decisions.
 */
let app: FastifyInstance;
const admin = staff([
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'quality.hold_create',
  'quality.hold_release',
]);
const V = randomUUID();
const TAG = randomUUID().slice(0, 4).toUpperCase();
const BATCH_NO = `QB-${TAG}`;
let W1: { id: string; bins: string[] };
let W2: { id: string; bins: string[] };
let batchId: string;

const facts = {
  variantId: V,
  productId: randomUUID(),
  sku: `ND-${TAG}`,
  barcode: null,
  productName: 'ND LaSota vaccine',
  variantName: '1000 doses',
  manufacturerName: null,
  packSize: '1.000',
  packUnit: 'VIAL',
  isPrescriptionRequired: false,
  temperatureClass: 'AMB',
  shelfLifeMonths: 12,
  isActive: true,
  categoryId: randomUUID(),
  categoryPath: [randomUUID()],
  brandId: randomUUID(),
  brandName: 'Godavari Biologicals',
  hsnCode: '3002',
  gstRate: '5.00',
  weightGrams: 50,
  minOrderQty: 1,
  maxOrderQty: null,
  version: 1,
};

const makeWarehouse = async (name: string, pin: string) => {
  const id = data<{ id: string }>(
    await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('qa'),
      name,
      type: 'DEPOT',
      addressLine: 'Plot 9, Industrial Estate',
      city: 'Eluru',
      district: 'Eluru',
      stateCode: '37',
      pinCode: pin,
      temperatureClasses: ['AMB'],
    }),
  ).id;
  const zone = data<{ id: string }>(
    await call(app, 'POST', `/admin/warehouses/${id}/zones`, admin, {
      code: 'Q',
      name: 'Vaccines',
      temperatureClass: 'AMB',
    }),
  );
  await call(app, 'POST', `/admin/warehouses/${id}/zones/${zone.id}/racks`, admin, {
    maxWeightKg: 900,
    volumeM3: 3,
    generateBins: { count: 2, maxWeightKg: 300, volumeM3: 1 },
  });
  const bins = data<{ id: string }[]>(
    await call(app, 'GET', `/admin/warehouses/${id}/bins?limit=10`, admin),
  ).map((b) => b.id);
  return { id, bins };
};

const receive = (warehouseId: string, binId: string, qty: number) =>
  call(
    app,
    'POST',
    '/wms/stock/receipts',
    admin,
    {
      warehouseId,
      lines: [{ variantId: V, batchNo: BATCH_NO, expiryDate: '2027-03-31', qty, binId }],
    },
    { 'idempotency-key': randomUUID() },
  );

/** Delivers one quality event to the stock feature's handler, inside a transaction (= inbox). */
const deliver = async (type: string, payload: unknown) => {
  const handler = app.diContainer.resolve('stockEventHandlers')[type];
  if (handler === undefined) throw new Error(`no handler for ${type}`);
  const env: EventEnvelope = {
    id: randomUUID(),
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    source: 'quality-service',
    correlationId: randomUUID(),
    data: payload,
  };
  await app.diContainer.resolve('runInTransaction')((tx) => handler(env, tx));
};

const positions = (warehouseId: string) =>
  app.diContainer.resolve('db').wmsStockPosition.findMany({ where: { warehouseId, batchId } });

const task = (decisionId: string, warehouseId: string) =>
  app.diContainer.resolve('db').wmsQualityTask.findUnique({
    where: { decisionId_warehouseId: { decisionId, warehouseId } },
  });

const outboxOf = async (type: string, key: string, value: string) => {
  const rows = await app.diContainer
    .resolve('db')
    .outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'desc' }, take: 200 });
  return rows.filter(
    (r) => (r.payload as { data?: Record<string, unknown> }).data?.[key] === value,
  );
};

describe.skipIf(DB_URL === undefined)('D-60 quality decisions in warehouse-service', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const db = app.diContainer.resolve('db');
    await db.wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    inventoryCutover.mode = 'WMS';
    productFacts.set(V, facts);
    W1 = await makeWarehouse('IT QA One', '534101');
    W2 = await makeWarehouse('IT QA Two', '534102');
  });

  afterAll(async () => {
    await app.close();
  });

  it('spec policy → receipts land in QC_HOLD, publish receipt_created, panel release refused', async () => {
    await deliver('quality.spec_changed.v1', {
      variantId: V,
      holdOnReceipt: true,
      releaseMode: 'MANUFACTURER_COA',
      isActive: true,
      version: 1,
    });
    // An older policy version is ignored (highest version wins).
    await deliver('quality.spec_changed.v1', {
      variantId: V,
      holdOnReceipt: false,
      releaseMode: 'MANUFACTURER_COA',
      isActive: false,
      version: 0,
    });
    const r1 = await receive(W1.id, W1.bins[0] ?? '', 30);
    expect(r1.statusCode, r1.body).toBe(201);
    const r2 = await receive(W2.id, W2.bins[0] ?? '', 20);
    expect(r2.statusCode, r2.body).toBe(201);
    const line = data<{ cnNo: string; lines: { batchId: string; status: string }[] }>(r1);
    batchId = line.lines[0]?.batchId ?? '';
    expect(line.lines[0]?.status).toBe('QC_HOLD');
    const events = await outboxOf('warehouse.receipt_created.v1', 'cnNo', line.cnNo);
    expect(events).toHaveLength(1);
    const ev = (
      events[0]?.payload as { data: { lines: { batchNo: string; initialStatus: string }[] } }
    ).data;
    expect(ev.lines[0]).toMatchObject({ batchNo: BATCH_NO, initialStatus: 'QC_HOLD' });

    const rel = await call(app, 'POST', '/wms/stock/quality/release', admin, {
      warehouseId: W1.id,
      batchId,
    });
    expect(rel.statusCode).toBe(409);
    expect(errorOf(rel).details).toMatchObject({ reason: 'RELEASE_VIA_QUALITY' });
  });

  it('recall: one task per warehouse; a failure retries without undoing the other; no double move', async () => {
    const stockQuality = app.diContainer.resolve('stockQuality');
    const engine = app.diContainer.resolve('stockEngine');
    const decisionId = randomUUID();
    await deliver('quality.decision_requested.v1', {
      decisionId,
      decisionNo: 'QD-2026-9001',
      batchId,
      kind: 'RECALL',
      stateVersion: 1,
      actorUserId: admin,
      reason: 'Independent COA failed: potency',
    });
    const planned = await outboxOf('warehouse.quality_tasks_planned.v1', 'decisionId', decisionId);
    expect(
      (planned[0]?.payload as { data: { warehouseIds: string[] } }).data.warehouseIds.sort(),
    ).toEqual([W1.id, W2.id].sort());

    // W2 fails once → stays PENDING with a later retry time; W1 succeeds in its own transaction.
    const spy = vi.spyOn(engine, 'apply').mockRejectedValueOnce(new Error('bin locked'));
    await stockQuality.runOne(decisionId, W2.id);
    spy.mockRestore();
    const t2 = await task(decisionId, W2.id);
    expect(t2).toMatchObject({ status: 'PENDING', attempts: 1, lastError: 'bin locked' });
    expect(t2?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await stockQuality.runOne(decisionId, W1.id);
    expect(await task(decisionId, W1.id)).toMatchObject({ status: 'DONE', qtyMoved: 30 });
    expect((await positions(W1.id)).reduce((s, p) => s + p.quarantined, 0)).toBe(30);

    // W2 fails for the last time → FAILED (+ event); W1 is untouched.
    await app.diContainer.resolve('db').wmsQualityTask.update({
      where: { decisionId_warehouseId: { decisionId, warehouseId: W2.id } },
      data: { attempts: 5, nextAttemptAt: new Date() },
    });
    const spy2 = vi.spyOn(engine, 'apply').mockRejectedValueOnce(new Error('bin locked'));
    await stockQuality.runOne(decisionId, W2.id);
    spy2.mockRestore();
    expect(await task(decisionId, W2.id)).toMatchObject({ status: 'FAILED', attempts: 6 });
    const failed = (
      await outboxOf('warehouse.quality_task_updated.v1', 'decisionId', decisionId)
    ).map((r) => (r.payload as { data: { warehouseId: string; status: string } }).data);
    expect(failed).toContainEqual(
      expect.objectContaining({ warehouseId: W2.id, status: 'FAILED' }),
    );
    expect((await positions(W1.id)).reduce((s, p) => s + p.quarantined, 0)).toBe(30);

    // Retry re-queues only the failed warehouse; running again never moves W1 twice.
    await deliver('quality.decision_retry_requested.v1', {
      decisionId,
      batchId,
      warehouseIds: [W2.id],
      actorUserId: admin,
    });
    expect(await task(decisionId, W2.id)).toMatchObject({ status: 'PENDING' });
    await stockQuality.runOne(decisionId, W2.id);
    await stockQuality.runOne(decisionId, W1.id);
    await stockQuality.runOne(decisionId, W2.id);
    expect(await task(decisionId, W2.id)).toMatchObject({ status: 'DONE', qtyMoved: 20 });
    expect((await positions(W1.id)).reduce((s, p) => s + p.quarantined, 0)).toBe(30);
    expect((await positions(W2.id)).reduce((s, p) => s + p.quarantined, 0)).toBe(20);
    expect((await positions(W2.id)).reduce((s, p) => s + p.qcHold + p.available, 0)).toBe(0);
  });

  it('a later receipt of the recalled batch lands straight in QUARANTINED', async () => {
    const r = await receive(W1.id, W1.bins[1] ?? '', 5);
    expect(r.statusCode, r.body).toBe(201);
    expect(data<{ lines: { status: string }[] }>(r).lines[0]?.status).toBe('QUARANTINED');
  });

  it('an older decision arriving late is SUPERSEDED (never releases a recalled batch)', async () => {
    const old = randomUUID();
    await deliver('quality.decision_requested.v1', {
      decisionId: old,
      decisionNo: 'QD-2026-9000',
      batchId,
      kind: 'RELEASE',
      stateVersion: 1,
      actorUserId: admin,
      reason: 'late release',
    });
    const rows = await app.diContainer
      .resolve('db')
      .wmsQualityTask.findMany({ where: { decisionId: old } });
    expect(rows.every((t) => t.status === 'SUPERSEDED')).toBe(true);
    await app.diContainer.resolve('stockQuality').runDue();
    expect((await positions(W1.id)).reduce((s, p) => s + p.available, 0)).toBe(0);
  });
});
