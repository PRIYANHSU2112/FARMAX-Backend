import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DB_URL,
  buildTestApp,
  call,
  data,
  errorOf,
  inventoryCutover,
  outbox,
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-57a Phase 2: W4 screen reads, restock (procurement / transfer), returns, search. */
let app: FastifyInstance;
const ALL = [
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'inventory.adjust',
  'inventory.transfer',
  'inventory.restock_request',
  'inventory.restock_approve',
  'quality.hold_create',
  'quality.hold_release',
  'vendors.manage',
];
const admin = staff(ALL);
const admin2 = staff(ALL);
const A = randomUUID();
const B = randomUUID();
const TAG = randomUUID().slice(0, 4).toUpperCase();
const idem = () => ({ 'idempotency-key': randomUUID() });
let S: { id: string; bins: string[] };
let D: { id: string; bins: string[] };
let vendorId: string;

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

const makeWarehouse = async (name: string, pin: string) => {
  const id = data<{ id: string }>(
    await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('w4'),
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
      code: 'A',
      name: 'Feed',
      temperatureClass: 'AMB',
    }),
  );
  await call(app, 'POST', `/admin/warehouses/${id}/zones/${zone.id}/racks`, admin, {
    maxWeightKg: 9000,
    volumeM3: 30,
    generateBins: { count: 3, maxWeightKg: 3000, volumeM3: 10 },
  });
  const bins = data<{ id: string }[]>(
    await call(app, 'GET', `/admin/warehouses/${id}/bins?limit=10`, admin),
  ).map((b) => b.id);
  return { id, bins };
};

const summary = (warehouseId: string, variantId: string) =>
  app.diContainer.resolve('db').wmsStockSummary.findUnique({
    where: { warehouseId_variantId: { warehouseId, variantId } },
  });

const receive = async (
  warehouseId: string,
  lines: { variantId: string; batchNo: string; expiryDate?: string; qty: number; binId?: string }[],
  extra: Record<string, unknown> = {},
) => {
  const res = await call(
    app,
    'POST',
    '/wms/stock/receipts',
    admin,
    { warehouseId, lines, ...extra },
    idem(),
  );
  return res;
};

interface Req {
  id: string;
  requestNo: string;
  status: string;
  version: number;
  requestedPacks: number;
  lines: {
    variantId: string;
    requestedQty: number;
    approvedQty: number | null;
    receivedQty: number;
  }[];
}

describe.skipIf(DB_URL === undefined)('D-57a W4 screens + restock against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const db = app.diContainer.resolve('db');
    await db.wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, facts(A, `LF-${A.slice(0, 4)}`, 'Layer Feed 50 kg'));
    productFacts.set(B, facts(B, `MM-${B.slice(0, 4)}`, 'Mineral Mix 25 kg'));
    S = await makeWarehouse('IT W4 Source', '534001');
    D = await makeWarehouse('IT W4 Dest', '534002');
    vendorId = data<{ id: string }>(
      await call(app, 'POST', '/admin/wms/vendors', admin, {
        code: randomCode('V').slice(0, 20),
        name: 'ABC Feeds',
        defaultOwnership: 'FARMX',
      }),
    ).id;
    // Source stock: A in two lots (E2 expires first), B in one lot; all released from QC.
    const r = await receive(S.id, [
      { variantId: A, batchNo: `E1-${TAG}`, expiryDate: '2027-03-01', qty: 30, binId: S.bins[0] },
      { variantId: A, batchNo: `E2-${TAG}`, expiryDate: '2027-01-15', qty: 20, binId: S.bins[1] },
      { variantId: B, batchNo: `B1-${TAG}`, expiryDate: '2027-06-01', qty: 10, binId: S.bins[0] },
    ]);
    expect(r.statusCode, r.body).toBe(201);
    for (const l of data<{ lines: { batchId: string }[] }>(r).lines) {
      const rel = await call(app, 'POST', '/wms/stock/quality/release', admin, {
        warehouseId: S.id,
        batchId: l.batchId,
      });
      expect(rel.statusCode, rel.body).toBe(200);
    }
    await call(app, 'PUT', `/wms/stock/thresholds/${S.id}/${B}`, admin, {
      safetyStock: 2,
      reorderLevel: 15,
      targetStock: 40,
    });
    await call(app, 'PUT', `/wms/stock/thresholds/${D.id}/${A}`, admin, {
      safetyStock: 5,
      reorderLevel: 20,
      targetStock: 60,
    });
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.wmsWarehouse.updateMany({
      where: { id: { in: [S.id, D.id] } },
      data: { deletedAt: new Date() },
    });
    await app.close();
  });

  it('every W4 read widget answers (both panels) and stays scoped', async () => {
    const s = S.id;
    const kpis = data<{ totalStock: number; available: number }>(
      await call(app, 'GET', `/wms/stock/landing/kpis?warehouseId=${s}&fresh=1`, admin),
    );
    expect(kpis).toMatchObject({ totalStock: 60, available: 60 });

    const records = await call(app, 'GET', `/wms/stock/records?warehouseId=${s}&page=1`, admin);
    expect(records.statusCode, records.body).toBe(200);
    const rec = records.json<{ data: { batch: { batchNo: string } }[]; meta: { total: number } }>();
    expect(rec.meta.total).toBe(3);
    expect(rec.data[0]?.batch.batchNo).toBe(`E2-${TAG}`); // earliest expiry first

    const batchId = (
      await app.diContainer
        .resolve('db')
        .wmsBatch.findFirstOrThrow({ where: { variantId: A, batchNo: `E1-${TAG}` } })
    ).id;
    const paths = [
      `/stock/landing/by-category?warehouseId=${s}`,
      `/stock/landing/status-mix?warehouseId=${s}`,
      '/stock/category-matrix',
      `/stock/products?warehouseId=${s}`,
      '/stock/products/search?q=layer',
      `/stock/overview/kpis?warehouseId=${s}`,
      '/stock/overview/warehouses',
      `/stock/overview/status-mix?warehouseId=${s}`,
      `/stock/filter-options?field=batch&q=E1&warehouseId=${s}`,
      `/stock/products/${A}`,
      `/stock/products/${A}/kpis?warehouseId=${s}`,
      `/stock/products/${A}/warehouses`,
      `/stock/products/${A}/batches?warehouseId=${s}`,
      `/stock/products/${A}/availability?warehouseId=${s}`,
      `/stock/products/${A}/movements`,
      `/stock/products/${A}/units`,
      `/stock/batches/${batchId}?warehouseId=${s}`,
      `/stock/batches/${batchId}/kpis?warehouseId=${s}`,
      `/stock/batches/${batchId}/traceability?warehouseId=${s}`,
      `/stock/batches/${batchId}/units?warehouseId=${s}`,
      `/stock/batches/${batchId}/quality`,
      `/stock/batches/${batchId}/movements`,
      `/stock/movements?warehouseId=${s}`,
      `/stock/ownership/kpis?warehouseId=${s}`,
      `/stock/ownership?warehouseId=${s}`,
      `/stock/alerts/kpis?warehouseId=${s}`,
      `/stock/alerts/count?warehouseId=${s}`,
      `/stock/restock-plan/item?variantId=${B}&warehouseId=${s}`,
      '/stock/lifecycle',
      '/stock/lifecycle/proposals',
      '/stock/receipts',
    ];
    for (const p of paths) {
      const res = await call(app, 'GET', `/wms${p}`, admin);
      expect(res.statusCode, `${p} ${res.body}`).toBe(200);
      const adm = await call(app, 'GET', `/admin/wms${p}`, admin);
      expect(adm.statusCode, `admin ${p} ${adm.body}`).toBe(200);
    }

    const alerts = await call(app, 'GET', `/wms/stock/alerts?type=low&warehouseId=${s}`, admin);
    expect(alerts.body).toContain(B);
    const plan = await call(app, 'GET', `/wms/stock/restock-plan?warehouseId=${s}`, admin);
    expect(plan.statusCode, plan.body).toBe(200);
    expect(plan.body).toContain(B);

    const moves = data<{ id: string }[]>(
      await call(app, 'GET', `/wms/stock/movements?warehouseId=${s}&limit=1`, admin),
    );
    const move = await call(app, 'GET', `/wms/stock/movements/${String(moves[0]?.id)}`, admin);
    expect(move.statusCode, move.body).toBe(200);

    for (const csv of ['/stock/records/export.csv', '/stock/movements/export.csv']) {
      const res = await call(app, 'GET', `/wms${csv}?warehouseId=${s}`, admin);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/csv');
      expect(res.body).toContain(`E1-${TAG}`);
    }

    // Scoped user at the destination only: the source is invisible.
    const local = staff([], { [D.id]: ['warehouse.view', 'inventory.view'] });
    const hidden = await call(app, 'GET', `/wms/stock/records?warehouseId=${s}`, local);
    expect([403, 404]).toContain(hidden.statusCode);
    const own = data<{ totalStock: number }>(
      await call(app, 'GET', '/wms/stock/landing/kpis?fresh=1', local),
    );
    expect(own.totalStock).toBe(0);
    const adminOnly = await call(app, 'GET', '/admin/wms/stock/overview/kpis', local);
    expect(adminOnly.statusCode).toBe(403);
  });

  it('procurement restock: draft → edit → submit → segregation of duties → approve → receipts', async () => {
    const pre = data<{ suggestedQty: number; target: number }[]>(
      await call(
        app,
        'GET',
        `/wms/stock/restock-requests/prefill?warehouseId=${D.id}&variantIds=${A}`,
        admin,
      ),
    );
    expect(pre[0]).toMatchObject({ target: 60, suggestedQty: 60 });

    const created = await call(app, 'POST', '/wms/stock/restock-requests', admin, {
      type: 'PROCUREMENT',
      destWarehouseId: D.id,
      vendorId,
      requiredBy: '2026-12-15',
      lines: [{ variantId: A, requestedQty: 50 }],
    });
    expect(created.statusCode, created.body).toBe(201);
    let req = data<Req>(created);
    expect(req.requestNo).toMatch(/^RST-\d{4}-\d{4}$/);
    expect(req.status).toBe('DRAFT');

    const edited = await call(app, 'PATCH', `/wms/stock/restock-requests/${req.id}`, admin, {
      lines: [{ variantId: A, requestedQty: 40 }],
      expectedVersion: req.version,
    });
    expect(edited.statusCode, edited.body).toBe(200);
    req = data<Req>(edited);
    expect(req.requestedPacks).toBe(40);

    const sub = await call(app, 'POST', `/wms/stock/restock-requests/${req.id}/submit`, admin);
    expect(data<Req>(sub).status).toBe('PENDING_APPROVAL');
    const late = await call(app, 'PATCH', `/wms/stock/restock-requests/${req.id}`, admin, {
      notes: 'more',
      expectedVersion: data<Req>(sub).version,
    });
    expect(late.statusCode).toBe(409);

    const panel = await call(app, 'POST', `/wms/stock/restock-requests/${req.id}/approve`, admin2);
    expect(panel.statusCode).toBe(404);
    const self = await call(
      app,
      'POST',
      `/admin/wms/stock/restock-requests/${req.id}/approve`,
      admin,
    );
    expect(self.statusCode).toBe(403);
    const ok = await call(
      app,
      'POST',
      `/admin/wms/stock/restock-requests/${req.id}/approve`,
      admin2,
      {
        lines: [{ variantId: A, approvedQty: 30 }],
      },
    );
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<Req>(ok).lines[0]?.approvedQty).toBe(30);

    const inbound = data<{ inbound: number; suggestedQty: number }[]>(
      await call(
        app,
        'GET',
        `/wms/stock/restock-requests/prefill?warehouseId=${D.id}&variantIds=${A}`,
        admin,
      ),
    );
    expect(inbound[0]).toMatchObject({ inbound: 30, suggestedQty: 30 });

    const wrong = await receive(
      S.id,
      [{ variantId: A, batchNo: `P0-${TAG}`, qty: 1, binId: S.bins[2] }],
      { restockRequestId: req.id },
    );
    expect(wrong.statusCode).toBe(422);

    const r1 = await receive(
      D.id,
      [{ variantId: A, batchNo: `P1-${TAG}`, expiryDate: '2027-05-01', qty: 20, binId: D.bins[0] }],
      { vendorId, restockRequestId: req.id },
    );
    expect(r1.statusCode, r1.body).toBe(201);
    let view = data<Req>(await call(app, 'GET', `/wms/stock/restock-requests/${req.id}`, admin));
    expect(view.status).toBe('PARTIALLY_RECEIVED');
    expect(view.lines[0]?.receivedQty).toBe(20);
    await receive(
      D.id,
      [{ variantId: A, batchNo: `P1-${TAG}`, expiryDate: '2027-05-01', qty: 10, binId: D.bins[0] }],
      { vendorId, restockRequestId: req.id },
    );
    view = data<Req>(await call(app, 'GET', `/wms/stock/restock-requests/${req.id}`, admin));
    expect(view.status).toBe('RECEIVED');

    const list = await call(
      app,
      'GET',
      `/wms/stock/restock-requests?warehouseId=${D.id}&type=PROCUREMENT&page=1`,
      admin,
    );
    expect(list.json<{ meta: { total: number } }>().meta.total).toBe(1);
  });

  it('transfer: FEFO dispatch → in transit → partial receive (QC hold) → close short', async () => {
    const draft = data<Req>(
      await call(app, 'POST', '/wms/stock/restock-requests', admin, {
        type: 'TRANSFER',
        destWarehouseId: D.id,
        sourceWarehouseId: S.id,
        requiredBy: '2026-12-10',
        lines: [
          { variantId: A, requestedQty: 25 },
          { variantId: B, requestedQty: 5 },
        ],
      }),
    );
    const early = await call(
      app,
      'POST',
      `/wms/stock/restock-requests/${draft.id}/dispatch`,
      admin,
    );
    expect(early.statusCode).toBe(409);
    await call(app, 'POST', `/wms/stock/restock-requests/${draft.id}/submit`, admin);
    await call(app, 'POST', `/admin/wms/stock/restock-requests/${draft.id}/approve`, admin2);

    const sent = await call(
      app,
      'POST',
      `/wms/stock/restock-requests/${draft.id}/dispatch`,
      admin,
      {
        etaAt: '2026-12-09T10:00:00.000Z',
      },
    );
    expect(sent.statusCode, sent.body).toBe(201);
    const tr = data<{
      id: string;
      trNo: string;
      status: string;
      units: number;
      lines: { lineNo: number; variantId: string; batchNo: string; qty: number }[];
    }>(sent);
    expect(tr.trNo).toMatch(/^TR-\d{4}-\d{4}$/);
    expect(tr.status).toBe('IN_TRANSIT');
    expect(tr.units).toBe(30);
    const aLines = tr.lines.filter((l) => l.variantId === A);
    expect(aLines.map((l) => [l.batchNo, l.qty])).toEqual([
      [`E2-${TAG}`, 20],
      [`E1-${TAG}`, 5],
    ]);
    expect(await summary(S.id, A)).toMatchObject({ available: 25 });
    const ev = (await outbox(app, 'warehouse.stock_changed.v1', S.id)) as {
      kind: string;
      lines: { variantId: string; sellableDelta: number }[];
    }[];
    const out = ev.filter((e) => e.kind === 'TRANSFER_OUT').at(-1);
    expect(out?.lines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ variantId: A, sellableDelta: -25 }),
        expect.objectContaining({ variantId: B, sellableDelta: -5 }),
      ]),
    );
    expect(
      data<Req>(await call(app, 'GET', `/wms/stock/restock-requests/${draft.id}`, admin)).status,
    ).toBe('IN_TRANSIT');
    const outList = await call(
      app,
      'GET',
      `/wms/stock/transfers?warehouseId=${S.id}&direction=out`,
      admin,
    );
    expect(outList.body).toContain(tr.trNo);

    const first = aLines[0];
    const over = await call(app, 'POST', `/wms/stock/transfers/${tr.id}/receive`, admin, {
      lines: [{ lineNo: first?.lineNo, receivedQty: 21 }],
    });
    expect(over.statusCode).toBe(422);
    const part = await call(app, 'POST', `/wms/stock/transfers/${tr.id}/receive`, admin, {
      lines: [{ lineNo: first?.lineNo, receivedQty: 20, binId: D.bins[1] }],
    });
    expect(part.statusCode, part.body).toBe(200);
    expect(data<{ status: string }>(part).status).toBe('PARTIALLY_RECEIVED');
    expect(await summary(D.id, A)).toMatchObject({ qcHold: 50 });
    const cn = await app.diContainer
      .resolve('db')
      .wmsReceipt.findFirstOrThrow({ where: { transferId: tr.id } });
    expect(cn.sourceType).toBe('TRANSFER');

    const closed = await call(app, 'POST', `/wms/stock/transfers/${tr.id}/receive`, admin, {
      lines: [],
      close: true,
    });
    expect(data<{ status: string }>(closed).status).toBe('RECEIVED');
    expect(
      data<Req>(await call(app, 'GET', `/wms/stock/restock-requests/${draft.id}`, admin)).status,
    ).toBe('RECEIVED');
    const again = await call(app, 'POST', `/wms/stock/transfers/${tr.id}/receive`, admin, {
      lines: [],
      close: true,
    });
    expect(again.statusCode).toBe(409);

    // Not enough binned stock at the source → 409 INSUFFICIENT_STOCK.
    const big = data<Req>(
      await call(app, 'POST', '/wms/stock/restock-requests', admin, {
        type: 'TRANSFER',
        destWarehouseId: D.id,
        sourceWarehouseId: S.id,
        requiredBy: '2026-12-10',
        lines: [{ variantId: B, requestedQty: 500 }],
      }),
    );
    await call(app, 'POST', `/wms/stock/restock-requests/${big.id}/submit`, admin);
    await call(app, 'POST', `/admin/wms/stock/restock-requests/${big.id}/approve`, admin2);
    const short = await call(app, 'POST', `/wms/stock/restock-requests/${big.id}/dispatch`, admin);
    expect(short.statusCode).toBe(409);
    expect(errorOf(short).details?.reason).toBe('INSUFFICIENT_STOCK');
  });

  it('customer return receipt gets an RT number and lands in RETURNED', async () => {
    const rt = await receive(
      D.id,
      [{ variantId: A, batchNo: `R1-${TAG}`, expiryDate: '2027-04-01', qty: 2, binId: D.bins[2] }],
      { sourceType: 'RETURN' },
    );
    expect(rt.statusCode, rt.body).toBe(201);
    expect(data<{ cnNo: string }>(rt).cnNo).toMatch(/^RT-\d{4}-\d{4}$/);
    expect(await summary(D.id, A)).toMatchObject({ returned: 2 });
    const bad = await receive(D.id, [{ variantId: A, batchNo: `R2-${TAG}`, qty: 1 }], {
      sourceType: 'RETURN',
      restockRequestId: randomUUID(),
    });
    expect(bad.statusCode).toBe(422);
  });

  it('header search finds batches and restock numbers; lifecycle text updated', async () => {
    const hits = data<{ type: string; title: string }[]>(
      await call(app, 'GET', `/wms/search?q=E1-${TAG}`, admin),
    );
    expect(hits.some((h) => h.type === 'batch' && h.title === `E1-${TAG}`)).toBe(true);
    const req = await app.diContainer
      .resolve('db')
      .wmsRestockRequest.findFirstOrThrow({ where: { destWarehouseId: D.id } });
    const rst = data<{ type: string; title: string }[]>(
      await call(app, 'GET', `/admin/wms/search?q=${req.requestNo}`, admin),
    );
    expect(rst.some((h) => h.type === 'restock')).toBe(true);
    const tr = data<{ from: string; to: string; requiredEvent: string }[]>(
      await call(app, 'GET', '/wms/stock/lifecycle/transitions', admin),
    );
    expect(tr.find((t) => t.from === 'PACKED' && t.to === 'DISPATCHED')).toMatchObject({
      requiredEvent: 'Dispatch checks passed',
    });
  });
});
