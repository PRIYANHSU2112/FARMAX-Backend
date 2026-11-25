import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PUBLIC_KEYS } from '../../src/features/certificates/index.js';
import {
  DB_URL,
  buildTestApp,
  call,
  customer,
  data,
  deliver,
  errorOf,
  outbox,
  staff,
  traces,
} from './harness.js';

/**
 * D-60 quality-service against Postgres: the 5 must-haves.
 *  1. transaction safety (receipt → one AUTO sample, results + audit together)
 *  2. recall cascade (buyers notified once, late buyers too) + per-warehouse progress / retry
 *  3. concurrency (two people on the same version → one wins)
 *  4. security (own data only, public allow-list, warehouse scope)
 *  5. auditability (who entered, who approved, who released; append-only)
 */
let app: FastifyInstance;
const TAG = randomUUID().slice(0, 6).toUpperCase();
const V = randomUUID();
const W1 = randomUUID();
const W2 = randomUUID();
const B1 = randomUUID(); // fails the independent test → recall
const B2 = randomUUID(); // released on the manufacturer COA
const R1 = randomUUID();
const CN = `CN-26-${TAG}`;
const ALL = [
  'quality.view',
  'quality.hold_create',
  'quality.hold_release',
  'quality.recall_initiate',
  'quality.spec_manage',
  'quality.lab_manage',
  'traceability.coa_publish',
  'traceability.coa_verify',
];
const head = staff(ALL);
const approver = staff(['quality.view', 'traceability.coa_verify', 'quality.hold_release']);
const releaser = staff(['quality.view', 'quality.hold_release']);
const qaA = staff([], {
  [W1]: ['quality.view', 'quality.hold_create', 'traceability.coa_publish'],
});
const outsider = staff([], { [randomUUID()]: ['quality.view'] });
const custA = customer();
const custB = customer();
const custC = customer();
const idem = () => ({ 'idempotency-key': `it-${randomUUID()}` });

const variant = {
  variantId: V,
  productId: randomUUID(),
  sku: `ND-${TAG}`,
  productName: 'IBD intermediate-plus',
  variantName: '2,500 doses',
  brandName: 'Godavari Biologicals',
  packLabel: '1 VIAL',
  imageUrl: null,
  temperatureClass: 'CC_REF',
};
const receipt = {
  receiptId: R1,
  cnNo: CN,
  warehouseId: W1,
  warehouseName: 'Mother WH',
  sourceType: 'VENDOR',
  vendorId: randomUUID(),
  vendorName: 'Godavari Biologicals',
  receivedAt: new Date().toISOString(),
  receivedBy: null,
  lines: [
    {
      lineNo: 1,
      variant,
      batchId: B1,
      batchNo: `B1-${TAG}`,
      mfgDate: '2026-06-01',
      expiryDate: '2027-03-31',
      serialized: true,
      qty: 8,
      initialStatus: 'QC_HOLD',
    },
    {
      lineNo: 2,
      variant,
      batchId: B2,
      batchNo: `B2-${TAG}`,
      mfgDate: '2026-06-01',
      expiryDate: '2027-03-31',
      serialized: false,
      qty: 30,
      initialStatus: 'QC_HOLD',
    },
  ],
};
const shipment = (userId: string, orderNo: string) => ({
  shipmentId: randomUUID(),
  shipmentNo: `SHP-${TAG}`,
  orderId: randomUUID(),
  orderNo,
  customerUserId: userId,
  warehouseId: W1,
  dispatchedAt: new Date().toISOString(),
  lines: [{ variantId: V, batchId: B1, qty: 2 }],
});

const samplesOf = (batchId: string) =>
  app.diContainer
    .resolve('db')
    .qaSample.findMany({ where: { batchId, receiptId: R1, source: 'AUTO' } });

let labId: string;
let s1: { id: string; version: number };
let indCoaId: string;
let mfrCoaId: string;
let releaseId: string;

describe.skipIf(DB_URL === undefined)('D-60 quality-service against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    await app.diContainer.resolve('db').qaVariant.create({
      data: {
        variantId: V,
        productId: variant.productId,
        sku: variant.sku,
        name: variant.productName,
        variantName: variant.variantName,
        brandName: variant.brandName,
        packLabel: variant.packLabel,
        temperatureClass: variant.temperatureClass,
      },
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('lab + spec (versioned, publishes spec_changed)', async () => {
    const lab = await call(app, 'POST', '/admin/quality/labs', head, {
      code: `L${TAG}`,
      name: 'Interferon Labs',
      accreditation: 'NABL ISO 17025',
      type: 'EXTERNAL',
      tatDays: 6,
    });
    expect(lab.statusCode, lab.body).toBe(201);
    labId = data<{ id: string }>(lab).id;
    const body = {
      releaseMode: 'MANUFACTURER_COA',
      sampleOnReceipt: true,
      sampleQty: 3,
      sampleUnit: 'vials',
      defaultLabId: labId,
      isActive: true,
      params: [
        {
          code: 'POTENCY',
          name: 'Virus titre (log10)',
          unit: 'log10',
          rule: 'MIN',
          min: 6,
          critical: true,
        },
        {
          code: 'STERILITY',
          name: 'Sterility',
          rule: 'TEXT',
          expectedText: 'Pass',
          critical: true,
        },
        { code: 'MOISTURE', name: 'Moisture', unit: '%', rule: 'MAX', max: 12 },
      ],
      reason: 'Initial limits from QA head',
      expectedVersion: 0,
    };
    const put = await call(app, 'PUT', `/admin/quality/specs/${V}`, head, body);
    expect(put.statusCode, put.body).toBe(200);
    expect(data<{ version: number }>(put).version).toBe(1);
    const stale = await call(app, 'PUT', `/admin/quality/specs/${V}`, head, body);
    expect(stale.statusCode).toBe(409);
    expect(errorOf(stale).details).toMatchObject({ reason: 'VERSION_CONFLICT', currentVersion: 1 });
    expect(await outbox(app, 'quality.spec_changed.v1', 'variantId', V)).toHaveLength(1);
  });

  it('1 · receipt event → exactly one AUTO sample per batch, even when delivered again', async () => {
    const id = randomUUID();
    expect(await deliver(app, 'warehouse.receipt_created.v1', receipt, id)).toBe('processed');
    expect(await deliver(app, 'warehouse.receipt_created.v1', receipt, id)).toBe('duplicate');
    // A second publish of the same receipt (new event id) must not create another sample.
    expect(await deliver(app, 'warehouse.receipt_created.v1', receipt)).toBe('processed');
    expect(await samplesOf(B1)).toHaveLength(1);
    expect(await samplesOf(B2)).toHaveLength(1);
    const row = (await samplesOf(B1))[0];
    s1 = { id: row?.id ?? '', version: row?.version ?? 0 };
  });

  it('3 · two people moving the same sample version: one wins, one gets 409', async () => {
    const [a, b] = await Promise.all([
      call(app, 'POST', `/quality/samples/${s1.id}/collect`, qaA, { expectedVersion: 0 }),
      call(app, 'POST', `/quality/samples/${s1.id}/collect`, head, { expectedVersion: 0 }),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const send = await call(app, 'POST', `/quality/samples/${s1.id}/send`, qaA, {
      expectedVersion: 1,
      labRef: 'IFN-26-08455',
    });
    expect(send.statusCode, send.body).toBe(200);
  });

  it('4 · warehouse scope: another warehouse cannot see the sample', async () => {
    expect((await call(app, 'GET', `/quality/samples/${s1.id}`, outsider)).statusCode).toBe(404);
    const list = data<{ id: string }[]>(await call(app, 'GET', '/quality/samples?limit=100', qaA));
    expect(list.some((s) => s.id === s1.id)).toBe(true);
  });

  it('1 + 5 · results and audit commit together; four-eyes on the review', async () => {
    const res = await call(app, 'PUT', `/quality/samples/${s1.id}/results`, qaA, {
      results: [
        { paramCode: 'POTENCY', valueNum: 5.8 },
        { paramCode: 'STERILITY', valueText: 'Pass' },
        { paramCode: 'MOISTURE', valueNum: 9.4 },
      ],
      expectedVersion: 2,
      analystName: 'K. Divya',
      signatoryName: 'Dr. M. Harsha',
    });
    expect(res.statusCode, res.body).toBe(200);
    const coa = data<{
      id: string;
      verdict: string;
      version: number;
      results: { paramCode: string; verdict: string }[];
    }>(res);
    indCoaId = coa.id;
    expect(coa.verdict).toBe('FAIL');
    expect(coa.results.find((r) => r.paramCode === 'POTENCY')?.verdict).toBe('FAILS');

    // The person who entered the results cannot approve (needs GLOBAL coa_verify first).
    expect(
      (
        await call(app, 'POST', `/quality/coas/${indCoaId}/review`, qaA, {
          decision: 'APPROVE',
          note: 'self check',
          expectedVersion: coa.version,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('2 · failed independent COA → recall in the same tx; buyers told once; late buyers too', async () => {
    await deliver(app, 'warehouse.shipment_batches.v1', shipment(custA, `ORD-A-${TAG}`));
    const coa = data<{ version: number }>(
      await call(app, 'GET', `/quality/coas/${indCoaId}`, head),
    );
    const review = await call(app, 'POST', `/quality/coas/${indCoaId}/review`, approver, {
      decision: 'APPROVE',
      note: 'Potency below limit confirmed',
      expectedVersion: coa.version,
    });
    expect(review.statusCode, review.body).toBe(200);

    const recalls = await outbox(app, 'quality.batch_recalled.v1', 'batchId', B1);
    expect(recalls).toHaveLength(1);
    expect(recalls[0]?.buyers).toEqual([
      expect.objectContaining({ userId: custA, orderNo: `ORD-A-${TAG}` }),
    ]);
    expect(await outbox(app, 'quality.decision_requested.v1', 'batchId', B1)).toEqual([
      expect.objectContaining({ kind: 'RECALL' }),
    ]);
    expect(await outbox(app, 'quality.coa_published.v1', 'batchId', B1)).toEqual([
      expect.objectContaining({ verdict: 'FAIL' }),
    ]);

    // A shipment of the batch that left after the recall → that buyer is told (once).
    const late = shipment(custB, `ORD-B-${TAG}`);
    await deliver(app, 'warehouse.shipment_batches.v1', late);
    await deliver(app, 'warehouse.shipment_batches.v1', late);
    const after = await outbox(app, 'quality.batch_recalled.v1', 'batchId', B1);
    expect(after).toHaveLength(2);
    expect(
      after.filter((r) => (r.buyers as { userId: string }[]).some((b) => b.userId === custB)),
    ).toHaveLength(1);
  });

  it('3 · release: four-eyes on the manufacturer COA, then two releasers race on one version', async () => {
    const up = await call(app, 'POST', '/quality/coas', head, {
      receipt: 'mfr.receipt',
      batchNo: `b2-${TAG}`,
      cnNo: CN,
      issuerName: 'Godavari Biologicals QC',
      issuedAt: '2026-06-02',
    });
    expect(up.statusCode, up.body).toBe(201);
    const coa = data<{ id: string; status: string; version: number }>(up);
    mfrCoaId = coa.id;
    expect(coa.status).toBe('LINKED');
    const mapped = await call(app, 'POST', `/quality/coas/${mfrCoaId}/confirm-mapping`, head, {
      expectedVersion: 0,
    });
    expect(mapped.statusCode, mapped.body).toBe(200);
    const entered = await call(app, 'PUT', `/quality/coas/${mfrCoaId}/results`, head, {
      results: [
        { paramCode: 'POTENCY', valueNum: 6.4 },
        { paramCode: 'STERILITY', valueText: 'Pass' },
        { paramCode: 'MOISTURE', valueNum: 8 },
      ],
      expectedVersion: 1,
    });
    expect(entered.statusCode, entered.body).toBe(200);
    const v = data<{ version: number }>(entered).version;
    const self = await call(app, 'POST', `/quality/coas/${mfrCoaId}/review`, head, {
      decision: 'APPROVE',
      note: 'looks fine',
      expectedVersion: v,
    });
    expect(self.statusCode).toBe(409);
    expect(errorOf(self).details).toMatchObject({ reason: 'SAME_PERSON' });
    const ok = await call(app, 'POST', `/quality/coas/${mfrCoaId}/review`, approver, {
      decision: 'APPROVE',
      note: 'All within limits',
      expectedVersion: v,
    });
    expect(ok.statusCode, ok.body).toBe(200);

    const check = data<{ canRelease: boolean; version: number }>(
      await call(app, 'GET', `/quality/batches/${B2}/release-check`, head),
    );
    expect(check.canRelease).toBe(true);
    const body = {
      kind: 'RELEASE',
      remarks: 'COA verified; batch and QR matched',
      expectedVersion: check.version,
    };
    const keyC = idem();
    const [c, h] = await Promise.all([
      call(app, 'POST', `/quality/batches/${B2}/decisions`, releaser, body, keyC),
      call(app, 'POST', `/quality/batches/${B2}/decisions`, head, body, idem()),
    ]);
    expect([c.statusCode, h.statusCode].sort()).toEqual([201, 409]);
    const loser = c.statusCode === 409 ? c : h;
    expect(['VERSION_CONFLICT', 'RELEASE_IN_PROGRESS']).toContain(errorOf(loser).details?.reason);
    const winner = c.statusCode === 201 ? c : h;
    releaseId = data<{ id: string }>(winner).id;

    // Same Idempotency-Key replayed → the same decision, nothing new.
    if (winner === c) {
      const again = await call(
        app,
        'POST',
        `/quality/batches/${B2}/decisions`,
        releaser,
        body,
        keyC,
      );
      expect(data<{ id: string }>(again).id).toBe(releaseId);
    }
  });

  it('2 · per-warehouse progress: PARTIAL on a failure, retry, then APPLIED', async () => {
    await deliver(app, 'warehouse.quality_tasks_planned.v1', {
      decisionId: releaseId,
      batchId: B2,
      warehouseIds: [W1, W2],
    });
    await deliver(app, 'warehouse.quality_task_updated.v1', {
      decisionId: releaseId,
      batchId: B2,
      warehouseId: W1,
      status: 'DONE',
      qtyMoved: 30,
      attempts: 1,
      error: null,
    });
    await deliver(app, 'warehouse.quality_task_updated.v1', {
      decisionId: releaseId,
      batchId: B2,
      warehouseId: W2,
      status: 'FAILED',
      qtyMoved: 0,
      attempts: 6,
      error: 'bin locked',
    });
    expect(
      data<{ status: string; progress: { done: number; failed: number } }>(
        await call(app, 'GET', `/quality/decisions/${releaseId}`, head),
      ),
    ).toMatchObject({
      status: 'PARTIAL',
      progress: { done: 1, failed: 1 },
    });
    const retry = await call(app, 'POST', `/quality/decisions/${releaseId}/retry`, head);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(
      await outbox(app, 'quality.decision_retry_requested.v1', 'decisionId', releaseId),
    ).toEqual([expect.objectContaining({ warehouseIds: [W2] })]);
    await deliver(app, 'warehouse.quality_task_updated.v1', {
      decisionId: releaseId,
      batchId: B2,
      warehouseId: W2,
      status: 'DONE',
      qtyMoved: 12,
      attempts: 7,
      error: null,
    });
    expect(
      data<{ status: string }>(await call(app, 'GET', `/quality/decisions/${releaseId}`, head))
        .status,
    ).toBe('APPLIED');
  });

  it('4 · customers see only their own consignments; public verify is an allow-list', async () => {
    const mine = data<{ batchId: string; status: string }[]>(
      await call(app, 'GET', '/certificates', custA),
    );
    expect(mine.find((r) => r.batchId === B1)?.status).toBe('FAILED');
    expect(data<unknown[]>(await call(app, 'GET', '/certificates', custC))).toHaveLength(0);
    expect((await call(app, 'GET', `/certificates/consignments/${CN}`, custC)).statusCode).toBe(
      404,
    );
    const cn = await call(app, 'GET', `/certificates/consignments/${CN}`, custA);
    expect(cn.statusCode, cn.body).toBe(200);
    const view = data<{
      batches: { batchId: string; quarantine: unknown; whatFailed: { name: string }[] }[];
      yourOrders: { orderNo: string }[];
    }>(cn);
    expect(view.batches.map((b) => b.batchId)).toEqual([B1]);
    expect(view.batches[0]?.quarantine).not.toBeNull();
    expect(view.batches[0]?.whatFailed.map((w) => w.name)).toEqual(['Virus titre (log10)']);
    expect(view.yourOrders.map((o) => o.orderNo)).toEqual([`ORD-A-${TAG}`]);

    const pub = await call(app, 'GET', `/verify/${CN}`, null);
    expect(pub.statusCode, pub.body).toBe(200);
    const batches = data<{ batches: Record<string, unknown>[] }>(pub).batches;
    for (const b of batches) expect(Object.keys(b).sort()).toEqual([...PUBLIC_KEYS].sort());
    expect(pub.body).not.toContain(`ORD-A-${TAG}`);
    expect(pub.body).not.toContain(custA);

    traces.set(`QR-${TAG}-0007`, {
      qrCode: `QR-${TAG}-0007`,
      batchId: B1,
      variantId: V,
      seq: 7,
      unitCount: 8,
      status: 'DELIVERED',
      receipt: {
        cnNo: CN,
        warehouseId: W1,
        warehouseName: 'Mother WH',
        receivedAt: new Date().toISOString(),
      },
      shipment: {
        shipmentId: randomUUID(),
        shipmentNo: `SHP-${TAG}`,
        orderId: randomUUID(),
        orderNo: `ORD-A-${TAG}`,
        customerUserId: custA,
        warehouseId: W1,
        warehouseName: 'Mother WH',
        dispatchedAt: new Date().toISOString(),
        vehicleNo: null,
        deliveredAt: new Date().toISOString(),
        otpVerified: true,
        hasPhotoProof: true,
      },
    });
    const own = data<{ order: { orderNo: string } | null; journey: { key: string }[] }>(
      await call(app, 'GET', `/certificates/units/QR-${TAG}-0007`, custA),
    );
    expect(own.order?.orderNo).toBe(`ORD-A-${TAG}`);
    expect(own.journey.map((j) => j.key)).toContain('FARM');
    const other = data<{ order: unknown; journey: { key: string }[]; genuine: boolean }>(
      await call(app, 'GET', `/certificates/units/QR-${TAG}-0007`, custC),
    );
    expect(other.genuine).toBe(true);
    expect(other.order).toBeNull();
    expect(other.journey.map((j) => j.key)).not.toContain('FARM');
    const bad = await call(app, 'GET', '/certificates/units/QR-NOT-FARMX', custC);
    expect(bad.statusCode).toBe(404);
    expect(errorOf(bad).details).toMatchObject({ reason: 'UNVERIFIED_CODE' });
  });

  it('5 · audit: who entered, who approved, who released — and the log is append-only', async () => {
    const coaTrail = data<{ action: string; actorUserId: string | null }[]>(
      await call(app, 'GET', `/admin/quality/audit?targetId=${indCoaId}&limit=50`, head),
    );
    expect(coaTrail).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'coa.results_entered', actorUserId: qaA }),
        expect.objectContaining({ action: 'coa.approved', actorUserId: approver }),
      ]),
    );
    const batchTrail = data<{ action: string; actorUserId: string | null }[]>(
      await call(app, 'GET', `/admin/quality/audit?targetId=${B2}&limit=50`, head),
    );
    expect(batchTrail.find((r) => r.action === 'decision.release')?.actorUserId).toMatch(
      new RegExp(`${releaser}|${head}`),
    );
    const db = app.diContainer.resolve('db');
    await expect(
      db.$executeRaw`UPDATE quality_audit_logs SET reason = 'x' WHERE "targetId" = ${indCoaId}::uuid`,
    ).rejects.toThrow();
    await expect(
      db.$executeRaw`DELETE FROM quality_audit_logs WHERE "targetId" = ${indCoaId}::uuid`,
    ).rejects.toThrow();
  });
});
