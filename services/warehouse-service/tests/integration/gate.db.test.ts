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

/**
 * D-62 W5 Gate & Weighbridge against Postgres: the full inbound flow, block / unblock, turn-away
 * with exit check + security hold + re-delivery, CN link rules, holds (no declared weight, debit
 * note), manual override maker-checker, PO quantity locks, ASN match / partial convert, visitors.
 */
let app: FastifyInstance;
const KEYS = [
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'warehouse.operate',
  'inventory.view',
  'inventory.receive',
  'inventory.restock_request',
  'inventory.restock_approve',
  'vendors.manage',
  'gate.view',
  'gate.operate',
  'gate.approve',
  'gate.security',
  'gate.configure',
];
const gate = staff(KEYS);
const sup = staff(KEYS);
const A = randomUUID();
const N = randomUUID();
const TAG = randomUUID().slice(0, 4).toUpperCase();
const idem = () => ({ 'idempotency-key': randomUUID() });
let W = '';
const doors: string[] = [];
let vendorId = '';
let poId = '';
let scaleId = '';

const facts = (variantId: string, sku: string, name: string, weightGrams: number | null) => ({
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
  weightGrams,
  minOrderQty: 1,
  maxOrderQty: null,
  version: 1,
});

const plate = () => `AP37${TAG.slice(0, 2)}${String(1000 + Math.floor(Math.random() * 8999))}`;
const eta = (mins = 60) => new Date(Date.now() + mins * 60_000).toISOString();
const DOCS = [
  { docType: 'PURCHASE_ORDER', refNo: 'PO-2026-1234' },
  { docType: 'DELIVERY_CHALLAN', refNo: 'DC-88912' },
  { docType: 'EWAY_BILL', refNo: 'EWB-2026-9921', validUntil: '2099-12-31' },
];

interface Ship {
  id: string;
  shipmentNo: string;
  stage: string;
  version: number;
  rebookingRequired: boolean;
  bay: { dockDoorId: string | null; code: string | null };
}
interface Entry {
  id: string;
  entryNo: string;
  status: string;
  pausedFromStatus: string | null;
  outcome: string | null;
  version: number;
  weights: Record<string, unknown>;
  receiving: { rcvNo: string | null; noReceipt: boolean };
  stepBar: { current: number; pause: { kind: string } | null };
  debitNoteRequired: boolean;
}
interface Pass {
  passNo: string;
  type: string;
  status: string;
  qrToken: string | null;
}

const newShipment = async (o: Record<string, unknown> = {}) => {
  const res = await call(
    app,
    'POST',
    '/wms/gate/shipments',
    gate,
    {
      warehouseId: W,
      vendorId,
      transportType: 'HEAVY_TRUCK',
      etaAt: eta(),
      plannedVehicleRegNo: plate(),
      plannedDriverName: 'Ramesh Kumar',
      plannedDriverMobile: '9876543210',
      lines: [{ variantId: A, expectedQty: 100 }],
      documents: DOCS,
      ...o,
    },
    idem(),
  );
  expect(res.statusCode, res.body).toBe(201);
  return data<Ship & { plannedVehicleRegNo: string }>(res);
};

const gateIn = async (
  s: Ship & { plannedVehicleRegNo?: string | null },
  gross?: number,
  reg?: string,
) => {
  const res = await call(
    app,
    'POST',
    '/wms/gate/entries',
    gate,
    {
      shipmentId: s.id,
      vehicleRegNo: reg ?? s.plannedVehicleRegNo ?? plate(),
      vehicleType: 'MULTI_AXLE',
      driverName: 'Rajesh Kumar',
      driverMobile: '+91 98765 43210',
      driverLicenceNo: 'AP0920230012345',
      ...(gross === undefined ? {} : { gross: { weightKg: gross, scaleId } }),
    },
    idem(),
  );
  return res;
};

const entry = async (id: string) =>
  data<Entry>(await call(app, 'GET', `/wms/gate/entries/${id}`, gate));

const verifyAll = async (entryId: string) => {
  const docs = data<{ items: { id: string; docType: string; status: string }[] }>(
    await call(app, 'GET', `/wms/gate/entries/${entryId}/documents`, gate),
  );
  for (const d of docs.items.filter((x) => x.status === 'PENDING')) {
    const r = await call(app, 'POST', `/wms/gate/documents/${d.id}/verify`, gate, {
      decision: 'VERIFIED',
      ...(d.docType === 'EWAY_BILL' ? { validUntil: '2099-12-31' } : {}),
    });
    expect(r.statusCode, r.body).toBe(200);
  }
};

const cn = (entryId: string, qty: number, finalForGate: boolean) =>
  call(
    app,
    'POST',
    '/wms/stock/receipts',
    gate,
    {
      warehouseId: W,
      vendorId,
      gateEntryId: entryId,
      finalForGate,
      lines: [
        {
          variantId: A,
          batchNo: `G-${TAG}-${String(qty)}-${randomUUID().slice(0, 4)}`,
          expiryDate: '2027-12-31',
          qty,
        },
      ],
    },
    idem(),
  );

describe.skipIf(DB_URL === undefined)('D-62 Gate & Weighbridge against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const db = app.diContainer.resolve('db');
    await db.wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, facts(A, `LF-${A.slice(0, 4)}`, 'Layer Feed 50kg', 50_000));
    productFacts.set(N, facts(N, `NW-${N.slice(0, 4)}`, 'Premix (no weight)', null));
    W = data<{ id: string }>(
      await call(app, 'POST', '/admin/warehouses', gate, {
        code: randomCode('gt'),
        name: 'IT Gate Hub',
        type: 'MOTHER',
        addressLine: 'NH-16',
        city: 'Eluru',
        district: 'Eluru',
        stateCode: '37',
        pinCode: '534006',
        temperatureClasses: ['AMB'],
      }),
    ).id;
    for (const code of ['D1', 'D2', 'D3']) {
      const d = await call(app, 'POST', `/admin/warehouses/${W}/dock-doors`, gate, {
        code,
        name: `Inbound Dock ${code}`,
        type: 'UNLOADING',
        vehicleClass: 'ANY',
        capacityPerDay: 200,
        capacityUnit: 'TONNES',
      });
      expect(d.statusCode, d.body).toBe(201);
      doors.push(data<{ id: string }>(d).id);
    }
    vendorId = data<{ id: string }>(
      await call(app, 'POST', '/admin/wms/vendors', gate, {
        code: randomCode('V').slice(0, 20),
        name: 'ABC Feeds Ltd.',
        defaultOwnership: 'FARMX',
      }),
    ).id;
    const po = data<{ id: string }>(
      await call(app, 'POST', '/wms/stock/restock-requests', gate, {
        type: 'PROCUREMENT',
        destWarehouseId: W,
        vendorId,
        requiredBy: '2026-12-31',
        lines: [{ variantId: A, requestedQty: 1000 }],
      }),
    );
    await call(app, 'POST', `/wms/stock/restock-requests/${po.id}/submit`, gate);
    const ok = await call(
      app,
      'POST',
      `/admin/wms/stock/restock-requests/${po.id}/approve`,
      sup,
      {},
    );
    expect(ok.statusCode, ok.body).toBe(200);
    poId = po.id;
    const sc = await call(app, 'POST', `/admin/warehouses/${W}/weigh-scales`, gate, {
      code: 'WB-01',
      name: 'Main weighbridge',
      maxCapacityKg: 60_000,
      calibratedAt: '2026-01-01',
      calibrationValidUntil: '2099-12-31',
    });
    expect(sc.statusCode, sc.body).toBe(201);
    scaleId = data<{ id: string }>(sc).id;
  });

  afterAll(async () => {
    await app.diContainer.resolve('db').wmsWarehouse.updateMany({
      where: { id: W },
      data: { deletedAt: new Date() },
    });
    await app.close();
  });

  it('lookups, bays, scales and the wizard preview answer', async () => {
    const lk = await call(app, 'GET', `/wms/gate/lookups?warehouseId=${W}`, gate);
    expect(lk.statusCode, lk.body).toBe(200);
    expect(
      data<{ requiredDocs: Record<string, string[]> }>(lk).requiredDocs.INBOUND_CONSIGNMENT,
    ).toEqual(['PURCHASE_ORDER', 'DELIVERY_CHALLAN', 'EWAY_BILL']);
    expect(
      data<unknown[]>(await call(app, 'GET', `/wms/gate/bays?warehouseId=${W}`, gate)),
    ).toHaveLength(3);
    expect(
      data<{ code: string; calibration: string }[]>(
        await call(app, 'GET', `/wms/gate/scales?warehouseId=${W}`, gate),
      )[0],
    ).toMatchObject({ code: 'WB-01', calibration: 'VALID' });
    const pos = data<{ id: string; lines: { remainingQty: number }[] }[]>(
      await call(
        app,
        'GET',
        `/wms/gate/purchase-orders?warehouseId=${W}&vendorId=${vendorId}`,
        gate,
      ),
    );
    expect(pos.find((p) => p.id === poId)?.lines[0]?.remainingQty).toBe(1000);
    const pv = await call(app, 'POST', '/wms/gate/shipments/preview', gate, {
      warehouseId: W,
      vendorId,
      restockRequestId: poId,
      etaAt: eta(),
      lines: [{ variantId: A, expectedQty: 100 }],
      documents: DOCS.slice(0, 2),
    });
    expect(pv.statusCode, pv.body).toBe(200);
    expect(data(pv)).toMatchObject({
      valid: true,
      totals: { totalUnits: 100, estimatedWeightKg: 5000, estimatedWeightMt: '5.00 MT' },
      expectedLoad: { basis: 'NET_PLUS_PACKAGING', expectedLoadKg: 5050 },
      documents: { attached: 2, requiredCount: 3, missing: ['EWAY_BILL'] },
    });
    expect(data<{ suggestedBay: { code: string } | null }>(pv).suggestedBay?.code).toBe('D1');
  });

  it('happy path: shipment → gate-in + gross → docs → approve (GPI) → scan handover → 2 CNs → tare → outward → exit', async () => {
    const s = await newShipment({ restockRequestId: poId, dockDoorId: doors[0] });
    expect(s.shipmentNo).toMatch(/^INB-\d{4}-\d{4}$/);
    expect(s).toMatchObject({ stage: 'EXPECTED', bay: { code: 'D1' } });

    const counts = data<{ expected: number }>(
      await call(app, 'GET', `/wms/gate/shipments/counts?warehouseId=${W}`, gate),
    );
    expect(counts.expected).toBeGreaterThanOrEqual(1);

    const gi = await gateIn(s, 14_250);
    expect(gi.statusCode, gi.body).toBe(201);
    const { entry: e0, confirmation } = data<{
      entry: Entry;
      confirmation: { destinationBay: string; next: string };
    }>(gi);
    expect(e0.entryNo).toMatch(/^GE-\d{4}-\d{4}$/);
    expect(e0.status).toBe('WEIGHED_IN');
    expect(confirmation).toMatchObject({ destinationBay: 'D1', next: 'DOCUMENTS' });
    expect(e0.stepBar.current).toBe(4);

    const early = await call(app, 'POST', `/wms/gate/entries/${e0.id}/approve`, gate, {});
    expect(early.statusCode).toBe(409);
    expect(errorOf(early).details?.reason).toBe('DOCS_INCOMPLETE');
    const docs = data<{ kpis: { requiredFiles: { value: number }; pending: { value: number } } }>(
      await call(app, 'GET', `/wms/gate/entries/${e0.id}/documents`, gate),
    );
    expect(docs.kpis).toMatchObject({ requiredFiles: { value: 3 }, pending: { value: 3 } });
    await verifyAll(e0.id);

    const ap = await call(app, 'POST', `/wms/gate/entries/${e0.id}/approve`, gate, {
      remarks: 'All applicable checks passed',
    });
    expect(ap.statusCode, ap.body).toBe(200);
    const inward = data<{ passes: Pass[] }>(ap).passes.find((p) => p.type === 'INWARD');
    expect(inward?.passNo).toMatch(/^GPI-\d{4}-\d{4}$/);
    expect(inward?.qrToken).toMatch(/^GP1\./);

    const pdf = await call(app, 'GET', `/wms/gate/passes/${inward?.passNo ?? ''}/pdf`, gate);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');

    const scan = await call(app, 'POST', '/wms/gate/passes/scan', gate, {
      qrToken: inward?.qrToken,
    });
    expect(scan.statusCode, scan.body).toBe(200);
    expect(data<{ action: string; entry: Entry }>(scan)).toMatchObject({
      action: 'HANDOVER',
      entry: { status: 'UNLOADING' },
    });
    const again = await call(app, 'POST', '/wms/gate/passes/scan', gate, {
      qrToken: inward?.qrToken,
    });
    expect(errorOf(again).details?.reason).toBe('PASS_ALREADY_USED');

    const cn1 = await cn(e0.id, 60, false);
    expect(cn1.statusCode, cn1.body).toBe(201);
    expect((await entry(e0.id)).status).toBe('UNLOADING');
    const cn2 = await cn(e0.id, 40, true);
    expect(cn2.statusCode, cn2.body).toBe(201);
    const unloaded = await entry(e0.id);
    expect(unloaded.status).toBe('UNLOADED');
    expect(
      data<unknown[]>(await call(app, 'GET', `/wms/gate/entries/${e0.id}/receipts`, gate)),
    ).toHaveLength(2);

    const tare = await call(
      app,
      'POST',
      `/wms/gate/entries/${e0.id}/weighments`,
      gate,
      { kind: 'TARE', weightKg: 9200, scaleId },
      idem(),
    );
    expect(tare.statusCode, tare.body).toBe(201);
    const rec = data<{ result: string; measuredNetKg: number; expectedLoadKg: number }>(
      await call(app, 'GET', `/wms/gate/entries/${e0.id}/reconciliation`, gate),
    );
    expect(rec).toMatchObject({ result: 'WITHIN', measuredNetKg: 5050, expectedLoadKg: 5050 });
    expect((await entry(e0.id)).status).toBe('WEIGHED_OUT');

    const noEmpty = await call(app, 'POST', `/wms/gate/entries/${e0.id}/outward-pass`, gate, {});
    expect(noEmpty.statusCode).toBe(422);
    const op = await call(app, 'POST', `/wms/gate/entries/${e0.id}/outward-pass`, gate, {
      emptyTruckVerified: true,
    });
    expect(op.statusCode, op.body).toBe(200);
    expect(data<{ passes: Pass[] }>(op).passes.find((p) => p.type === 'OUTWARD')?.passNo).toMatch(
      /^GPO-/,
    );
    const ex = await call(app, 'POST', `/wms/gate/entries/${e0.id}/exit`, gate, {});
    expect(ex.statusCode, ex.body).toBe(200);
    expect(data<{ entry: Entry; exit: { finalStatus: string } }>(ex)).toMatchObject({
      entry: { status: 'EXITED', outcome: 'COMPLETED' },
      exit: { finalStatus: 'Gate out · Completed' },
    });
    const shipment = data<Ship>(await call(app, 'GET', `/wms/gate/shipments/${s.id}`, gate));
    expect(shipment.stage).toBe('COMPLETED');

    const tl = data<{ items: { type: string }[] }>(
      await call(app, 'GET', `/wms/gate/entries/${e0.id}/timeline`, gate),
    );
    expect(tl.items.map((i) => i.type)).toEqual(
      expect.arrayContaining([
        'SHIPMENT_CREATED',
        'GATE_IN',
        'GROSS_CAPTURED',
        'ENTRY_APPROVED',
        'HANDOVER',
        'CN_LINKED',
        'UNLOADED',
        'TARE_CAPTURED',
        'PASS_OUT_ISSUED',
        'GATE_OUT',
      ]),
    );
    const events = await outbox(app, 'gate_entry.status_changed.v1', W);
    expect(events.map((x) => x.status)).toEqual(
      expect.arrayContaining([
        'ARRIVED',
        'WEIGHED_IN',
        'APPROVED',
        'UNLOADING',
        'UNLOADED',
        'WEIGHED_OUT',
        'PASS_OUT',
        'EXITED',
      ]),
    );
    expect(JSON.stringify(events)).not.toContain('98765');

    // Audit rows never hold the full mobile / licence number.
    const audit = await app.diContainer
      .resolve('db')
      .wmsAuditLog.findMany({ where: { targetId: e0.id } });
    expect(JSON.stringify(audit)).not.toContain('9876543210');
    expect(JSON.stringify(audit)).not.toContain('AP0920230012345');

    // Dashboard: cards + ETag 304 inside the same minute and version.
    const sum = await call(app, 'GET', `/wms/gate/summary?warehouseId=${W}`, gate);
    expect(sum.statusCode).toBe(200);
    expect(
      data<{ cards: { completed: { value: number } } }>(sum).cards.completed.value,
    ).toBeGreaterThanOrEqual(1);
    const etag = sum.headers.etag;
    expect(typeof etag).toBe('string');
    const again304 = await call(app, 'GET', `/wms/gate/summary?warehouseId=${W}`, gate, undefined, {
      'if-none-match': String(etag),
    });
    expect(again304.statusCode).toBe(304);
    const mix = data<{ segments: { key: string }[] }>(
      await call(app, 'GET', `/wms/gate/status-mix?warehouseId=${W}`, gate),
    );
    expect(mix.segments).toHaveLength(3);
    const act = await call(app, 'GET', `/wms/gate/activity?warehouseId=${W}&limit=3`, gate);
    expect(act.statusCode).toBe(200);
    const list = await call(app, 'GET', `/wms/gate/shipments?warehouseId=${W}&tab=completed`, gate);
    expect(data<{ id: string }[]>(list).some((x) => x.id === s.id)).toBe(true);
    const slip = await call(app, 'GET', `/wms/gate/entries/${e0.id}/weighment-slip.pdf`, gate);
    expect(slip.headers['content-type']).toBe('application/pdf');
  });

  it('block resumes where it paused; turn-away voids GP-IN, releases the dock, exit check → security hold; REEXPECT needs a new slot and re-checks documents', async () => {
    const s = await newShipment({
      dockDoorId: doors[1],
      lines: [{ variantId: A, expectedQty: 20 }],
    });
    const e = data<{ entry: Entry }>(await gateIn(s, 9_800)).entry;
    const bl = await call(app, 'POST', `/wms/gate/entries/${e.id}/block`, gate, {
      reason: 'INVALID_DOCUMENT',
      holdLocation: 'Security holding area',
      remarks: 'Request corrected document from vendor',
    });
    expect(bl.statusCode, bl.body).toBe(200);
    const blocked = await entry(e.id);
    expect(blocked).toMatchObject({
      status: 'BLOCKED',
      pausedFromStatus: 'WEIGHED_IN',
      stepBar: { current: 4, pause: { kind: 'BLOCKED' } },
    });
    const ub = await call(app, 'POST', `/wms/gate/entries/${e.id}/unblock`, sup, {
      remarks: 'Corrected challan received',
    });
    expect(ub.statusCode, ub.body).toBe(200);
    expect((await entry(e.id)).status).toBe('WEIGHED_IN');

    await verifyAll(e.id);
    const ap = await call(app, 'POST', `/wms/gate/entries/${e.id}/approve`, sup, {});
    expect(ap.statusCode, ap.body).toBe(200);

    const ta = await call(app, 'POST', `/wms/gate/entries/${e.id}/turn-away`, sup, {
      reason: 'Damaged load seen at gate',
      shipmentAction: 'REEXPECT',
    });
    expect(ta.statusCode, ta.body).toBe(200);
    expect(data<Entry>(ta)).toMatchObject({ status: 'REJECTED', outcome: 'REJECTED' });
    const passes = data<{ items: Pass[] }>(
      await call(app, 'GET', `/wms/gate/entries/${e.id}/passes`, gate),
    ).items;
    expect(passes.find((p) => p.type === 'INWARD')?.status).toBe('VOID');
    const booking = await app.diContainer
      .resolve('db')
      .wmsDockBooking.findFirst({ where: { inboundShipmentId: s.id } });
    expect(booking?.status).toBe('CANCELLED');
    expect(data<Ship>(await call(app, 'GET', `/wms/gate/shipments/${s.id}`, gate)).stage).toBe(
      'REJECTED',
    );

    const needCheck = await call(app, 'POST', `/wms/gate/entries/${e.id}/outward-pass`, gate, {});
    expect(errorOf(needCheck).details?.reason).toBe('EXIT_CHECK_REQUIRED');
    const bad = await call(
      app,
      'POST',
      `/wms/gate/entries/${e.id}/weighments`,
      gate,
      { kind: 'EXIT_CHECK', weightKg: 9000, scaleId },
      idem(),
    );
    expect(bad.statusCode, bad.body).toBe(201);
    const held = await call(app, 'POST', `/wms/gate/entries/${e.id}/outward-pass`, gate, {});
    expect(errorOf(held).details?.reason).toBe('SECURITY_HOLD');
    const checks = data<{ id: string; reason: string; status: string }[]>(
      await call(app, 'GET', `/wms/gate/security-checks?warehouseId=${W}&open=true`, gate),
    );
    const hold = checks.find((c) => c.reason === 'EXIT_WEIGHT_MISMATCH');
    expect(hold?.status).toBe('PENDING');
    const rs = await call(app, 'POST', `/wms/gate/security-checks/${hold?.id ?? ''}/resolve`, sup, {
      note: 'Re-weighed on the second bay',
    });
    expect(rs.statusCode, rs.body).toBe(200);
    const good = await call(
      app,
      'POST',
      `/wms/gate/entries/${e.id}/weighments`,
      gate,
      { kind: 'EXIT_CHECK', weightKg: 9790, scaleId },
      idem(),
    );
    expect(good.statusCode, good.body).toBe(201);
    const op = await call(app, 'POST', `/wms/gate/entries/${e.id}/outward-pass`, gate, {});
    expect(op.statusCode, op.body).toBe(200);
    expect((await call(app, 'POST', `/wms/gate/entries/${e.id}/exit`, gate, {})).statusCode).toBe(
      200,
    );

    const after = data<Ship & { rebookingRequired: boolean }>(
      await call(app, 'GET', `/wms/gate/shipments/${s.id}`, gate),
    );
    expect(after).toMatchObject({ stage: 'EXPECTED', rebookingRequired: true });
    const docs = await app.diContainer
      .resolve('db')
      .wmsGateDocument.findMany({ where: { shipmentId: s.id } });
    expect(docs.find((d) => d.docType === 'EWAY_BILL')?.status).toBe('PENDING');
    expect(docs.find((d) => d.docType === 'PURCHASE_ORDER')).toMatchObject({
      status: 'VERIFIED',
      carriedForward: true,
    });

    const blockedIn = await gateIn(s, undefined, s.plannedVehicleRegNo);
    expect(errorOf(blockedIn).details?.reason).toBe('REBOOKING_REQUIRED');
    const book = await call(app, 'POST', '/wms/gate/appointments', gate, {
      warehouseId: W,
      vendorId,
      inboundShipmentId: s.id,
      slotStart: eta(180),
      dockDoorId: doors[2],
    });
    expect(book.statusCode, book.body).toBe(201);
    const again = await gateIn(s, 9_810, s.plannedVehicleRegNo);
    expect(again.statusCode, again.body).toBe(201);
  });

  it('CN link rule: always posts, links only UNLOADING…PASS_OUT; manual unloaded needs a reason → noReceipt cleared by a late CN', async () => {
    const s = await newShipment({ lines: [{ variantId: A, expectedQty: 10 }] });
    const e = data<{ entry: Entry }>(await gateIn(s, 9_000)).entry;
    const early = await cn(e.id, 5, true);
    expect(early.statusCode, early.body).toBe(201);
    expect(early.json<{ data: { warnings?: { code: string }[] } }>().data.warnings?.[0]?.code).toBe(
      'GATE_LINK_SKIPPED',
    );

    await verifyAll(e.id);
    await call(app, 'POST', `/wms/gate/entries/${e.id}/approve`, gate, {});
    await call(app, 'POST', `/wms/gate/entries/${e.id}/handover`, gate, {});
    const noReason = await call(app, 'POST', `/wms/gate/entries/${e.id}/unloaded`, gate, {});
    expect(noReason.statusCode).toBe(422);
    const manual = await call(app, 'POST', `/wms/gate/entries/${e.id}/unloaded`, gate, {
      reason: 'Receiving desk offline, CN later',
    });
    expect(manual.statusCode, manual.body).toBe(200);
    expect((await entry(e.id)).receiving.noReceipt).toBe(true);
    const late = await cn(e.id, 10, false);
    expect(late.statusCode, late.body).toBe(201);
    expect(late.json<{ data: { warnings?: unknown[] } }>().data.warnings).toBeUndefined();
    expect((await entry(e.id)).receiving.noReceipt).toBe(false);
  });

  it('no declared weight → HELD; maker ≠ checker; debit note; manual override blocks the pass until reviewed', async () => {
    const s = await newShipment({ lines: [{ variantId: N, expectedQty: 10 }] });
    const e = data<{ entry: Entry }>(await gateIn(s, 7_000)).entry;
    await verifyAll(e.id);
    await call(app, 'POST', `/wms/gate/entries/${e.id}/approve`, gate, {});
    await call(app, 'POST', `/wms/gate/entries/${e.id}/handover`, gate, {});
    await call(app, 'POST', `/wms/gate/entries/${e.id}/unloaded`, gate, {
      reason: 'Premix sacks counted',
    });
    const tare = await call(
      app,
      'POST',
      `/wms/gate/entries/${e.id}/weighments`,
      gate,
      { kind: 'TARE', weightKg: 6_500, scaleId },
      idem(),
    );
    expect(tare.statusCode, tare.body).toBe(201);
    const held = await entry(e.id);
    expect(held).toMatchObject({ status: 'HELD', weights: { result: 'NO_DECLARED_WEIGHT' } });

    const own = await call(app, 'POST', `/wms/gate/entries/${e.id}/hold/resolve`, gate, {
      resolution: 'ACCEPT_VARIANCE',
      note: 'Looks fine to me',
    });
    expect(own.statusCode).toBe(403);
    expect(errorOf(own).details?.reason).toBe('SAME_USER');
    const ok = await call(app, 'POST', `/wms/gate/entries/${e.id}/hold/resolve`, sup, {
      resolution: 'ACCEPT_WITH_DEBIT_NOTE',
      note: 'Short by weight; debit vendor',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<Entry>(ok)).toMatchObject({ status: 'WEIGHED_OUT', debitNoteRequired: true });

    const w = data<{ tare: { id: string } }>(
      await call(app, 'GET', `/wms/gate/entries/${e.id}/weighments`, gate),
    );
    const ov = await call(app, 'POST', `/wms/gate/weighments/${w.tare.id}/override`, gate, {
      weightKg: 6_480,
      reason: 'Automatic sensor unavailable',
    });
    expect(ov.statusCode, ov.body).toBe(201);
    const blocked = await call(app, 'POST', `/wms/gate/entries/${e.id}/outward-pass`, gate, {
      emptyTruckVerified: true,
    });
    expect(errorOf(blocked).details?.reason).toBe('OVERRIDE_PENDING');
    const pendingId = data<{ id: string }>(ov).id;
    const self = await call(app, 'POST', `/wms/gate/weighments/${pendingId}/review`, gate, {
      decision: 'APPROVE',
    });
    expect(self.statusCode).toBe(403);
    const rv = await call(app, 'POST', `/wms/gate/weighments/${pendingId}/review`, sup, {
      decision: 'APPROVE',
      note: 'Slip checked',
    });
    expect(rv.statusCode, rv.body).toBe(200);
    expect((await entry(e.id)).weights.tareKg).toBe(6_480);
    const approvals = data<{ overrides: unknown[] }>(
      await call(app, 'GET', `/wms/gate/approvals?warehouseId=${W}`, sup),
    );
    expect(approvals.overrides).toHaveLength(0);
  });

  it('PO quantity is locked and checked; ASN matches, converts in parts, refuses a second full conversion', async () => {
    const po2 = data<{ id: string }>(
      await call(app, 'POST', '/wms/stock/restock-requests', gate, {
        type: 'PROCUREMENT',
        destWarehouseId: W,
        vendorId,
        requiredBy: '2026-12-31',
        lines: [{ variantId: A, requestedQty: 100 }],
      }),
    );
    await call(app, 'POST', `/wms/stock/restock-requests/${po2.id}/submit`, gate);
    await call(app, 'POST', `/admin/wms/stock/restock-requests/${po2.id}/approve`, sup, {});
    const over = await call(app, 'POST', '/wms/gate/shipments', gate, {
      warehouseId: W,
      vendorId,
      restockRequestId: po2.id,
      transportType: 'TRUCK',
      etaAt: eta(),
      lines: [{ variantId: A, expectedQty: 120 }],
    });
    expect(over.statusCode).toBe(409);
    expect(errorOf(over).details?.reason).toBe('OVER_PO_QTY');

    const asn = await call(app, 'POST', '/wms/gate/asns', gate, {
      warehouseId: W,
      vendorId,
      vendorAsnRef: `ASN-${TAG}-081`,
      restockRequestId: po2.id,
      etaAt: eta(90),
      lines: [{ variantId: A, qty: 100 }],
    });
    expect(asn.statusCode, asn.body).toBe(201);
    const a = data<{ id: string; status: string }>(asn);
    expect(a.status).toBe('MATCHED');
    const dup = await call(app, 'POST', '/wms/gate/asns', gate, {
      warehouseId: W,
      vendorId,
      vendorAsnRef: `ASN-${TAG}-081`,
      etaAt: eta(90),
      lines: [{ variantId: A, qty: 1 }],
    });
    expect(dup.statusCode, dup.body).toBe(409);
    expect(errorOf(dup).details?.reason).toBe('DUPLICATE_ASN');
    const second = data<{ id: string; status: string }>(
      await call(app, 'POST', '/wms/gate/asns', gate, {
        warehouseId: W,
        vendorId,
        vendorAsnRef: `ASN-${TAG}-082`,
        restockRequestId: po2.id,
        etaAt: eta(90),
        lines: [{ variantId: A, qty: 10 }],
      }),
    );
    expect(second.status).toBe('UNMATCHED');

    const part = await call(app, 'POST', `/wms/gate/asns/${a.id}/convert`, gate, {
      lines: [{ lineNo: 1, qty: 60 }],
      vehicleRegNo: plate(),
    });
    expect(part.statusCode, part.body).toBe(201);
    expect(data<{ asn: { status: string } }>(part).asn.status).toBe('PARTIALLY_CONVERTED');
    const rest = await call(app, 'POST', `/wms/gate/asns/${a.id}/convert`, gate, {
      vehicleRegNo: plate(),
    });
    expect(rest.statusCode, rest.body).toBe(201);
    expect(data<{ asn: { status: string; convertedUnits: number } }>(rest).asn).toMatchObject({
      status: 'CONVERTED',
      convertedUnits: 100,
    });
    const none = await call(app, 'POST', `/wms/gate/asns/${a.id}/convert`, gate, {});
    expect(none.statusCode).toBe(409);
    const summary = data<{ converted: { value: number } }>(
      await call(app, 'GET', `/wms/gate/asns/summary?warehouseId=${W}`, gate),
    );
    expect(summary.converted.value).toBeGreaterThanOrEqual(1);
  });

  it('dock appointments: grid, list, bays, reschedule, confirm, cancel', async () => {
    const book = await call(app, 'POST', '/wms/gate/appointments', gate, {
      warehouseId: W,
      vendorId,
      slotStart: eta(24 * 60),
      dockDoorId: doors[0],
    });
    expect(book.statusCode, book.body).toBe(201);
    const id = data<{ id: string }>(book).id;
    const clash = await call(app, 'POST', '/wms/gate/appointments', gate, {
      warehouseId: W,
      vendorId,
      slotStart: eta(24 * 60 + 30),
      dockDoorId: doors[0],
    });
    expect(errorOf(clash).details?.reason).toBe('DOCK_BUSY');
    const day = (await app.diContainer.resolve('db').wmsDockBooking.findUnique({ where: { id } }))
      ?.plannedStart;
    const date = new Date((day?.getTime() ?? 0) + 330 * 60_000).toISOString().slice(0, 10);
    expect(
      (await call(app, 'GET', `/wms/gate/appointments/summary?warehouseId=${W}&date=${date}`, gate))
        .statusCode,
    ).toBe(200);
    expect(
      (await call(app, 'GET', `/wms/gate/appointments/slots?warehouseId=${W}&date=${date}`, gate))
        .statusCode,
    ).toBe(200);
    expect(
      data<{ id: string }[]>(
        await call(app, 'GET', `/wms/gate/appointments?warehouseId=${W}&date=${date}`, gate),
      ).some((x) => x.id === id),
    ).toBe(true);
    expect(
      (await call(app, 'GET', `/wms/gate/appointments/bays?warehouseId=${W}&date=${date}`, gate))
        .statusCode,
    ).toBe(200);
    const cf = await call(app, 'POST', `/wms/gate/appointments/${id}/confirm`, gate, {
      warehouseId: W,
    });
    expect(data<{ status: string }>(cf).status).toBe('CONFIRMED');
    const rs = await call(app, 'PATCH', `/wms/gate/appointments/${id}`, gate, {
      warehouseId: W,
      slotStart: eta(26 * 60),
      dockDoorId: doors[1],
    });
    expect(rs.statusCode, rs.body).toBe(200);
    const cc = await call(app, 'POST', `/wms/gate/appointments/${id}/cancel`, gate, {
      warehouseId: W,
      reason: 'Vendor truck broke down',
    });
    expect(data<{ status: string }>(cc).status).toBe('CANCELLED');
  });

  it('visitors, outward material (maker ≠ checker) and security checks', async () => {
    const v = await call(app, 'POST', '/wms/gate/visitors', gate, {
      warehouseId: W,
      name: 'Ramesh Kumar',
      mobile: '9876543210',
      company: 'ABC Feeds',
      purpose: 'Vehicle delivery',
      hostLabel: 'Gate supervisor',
    });
    expect(v.statusCode, v.body).toBe(201);
    const visitor = data<{ id: string; status: string }>(v);
    expect(visitor.status).toBe('PENDING');
    const list = data<{ mobile: string }[]>(
      await call(app, 'GET', `/wms/gate/visitors?warehouseId=${W}`, gate),
    );
    expect(list[0]?.mobile).toBe('+91 98••• ••210');
    const ck = await call(app, 'POST', '/wms/gate/security-checks', gate, {
      warehouseId: W,
      subjectType: 'VISITOR',
      subjectId: visitor.id,
      identityCheck: 'PASS',
      remarks: 'No discrepancy found',
    });
    expect(ck.statusCode, ck.body).toBe(201);
    expect(
      data<{ status: string }>(await call(app, 'GET', `/wms/gate/visitors/${visitor.id}`, gate))
        .status,
    ).toBe('ON_SITE');
    const out = await call(app, 'POST', `/wms/gate/visitors/${visitor.id}/check-out`, gate, {});
    expect(data<{ status: string }>(out).status).toBe('CHECKED_OUT');

    const om = await call(app, 'POST', '/wms/gate/outward-materials', gate, {
      warehouseId: W,
      material: 'Returnable pallets',
      qty: 12,
      unit: 'units',
      vehicleRegNo: 'MH 12 AB 1234',
      receiver: 'ABC Feeds',
    });
    expect(om.statusCode, om.body).toBe(201);
    const m = data<{ id: string; omNo: string }>(om);
    expect(m.omNo).toMatch(/^OM-\d{4}-\d{4}$/);
    const self = await call(app, 'POST', `/wms/gate/outward-materials/${m.id}/authorize`, gate, {});
    expect(self.statusCode).toBe(403);
    expect(
      (await call(app, 'POST', `/wms/gate/outward-materials/${m.id}/authorize`, sup, {}))
        .statusCode,
    ).toBe(200);
    expect(
      data<{ status: string }>(
        await call(app, 'POST', `/wms/gate/outward-materials/${m.id}/exit`, gate, {}),
      ).status,
    ).toBe('EXITED');
    const sum = data<{ outwardMaterial: { value: number } }>(
      await call(app, 'GET', `/wms/gate/security/summary?warehouseId=${W}`, gate),
    );
    expect(sum.outwardMaterial.value).toBeGreaterThanOrEqual(1);
  });

  it('idempotency: replay, different body → 422; scoped access 404; gate settings + search', async () => {
    const key = { 'idempotency-key': randomUUID() };
    const body = { warehouseId: W, name: 'Replay Visitor', purpose: 'Interview' };
    const r1 = await call(app, 'POST', '/wms/gate/visitors', gate, body, key);
    const r2 = await call(app, 'POST', '/wms/gate/visitors', gate, body, key);
    expect(r2.statusCode).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(data<{ id: string }>(r2).id).toBe(data<{ id: string }>(r1).id);
    const r3 = await call(
      app,
      'POST',
      '/wms/gate/visitors',
      gate,
      { ...body, name: 'Someone Else' },
      key,
    );
    expect(r3.statusCode).toBe(422);
    expect(errorOf(r3).details?.reason).toBe('IDEMPOTENCY_KEY_REUSED');

    const outsider = staff(['gate.view'], { [randomUUID()]: ['gate.view', 'warehouse.view'] });
    expect(
      (await call(app, 'GET', `/wms/gate/summary?warehouseId=${W}`, outsider)).statusCode,
    ).toBe(404);

    const put = await call(app, 'PUT', `/admin/warehouses/${W}/gate-settings`, gate, {
      'gate.weightTolerance': { pct: 1, minKg: 30 },
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(
      data<{ values: { 'gate.weightTolerance': { pct: number } } }>(put).values[
        'gate.weightTolerance'
      ].pct,
    ).toBe(1);
    const search = await call(app, 'GET', `/wms/search?q=INB-`, gate);
    expect(search.statusCode, search.body).toBe(200);
  });
});
