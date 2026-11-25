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
  productFacts,
  randomCode,
  staff,
} from './harness.js';

/** D-62 §6: every race → its lock / unique key → exactly one winner (Promise.all × 10). */
let app: FastifyInstance;
const KEYS = [
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
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
const TAG = randomUUID().slice(0, 4).toUpperCase();
const X10 = Array.from({ length: 10 }, (_, i) => i);
const idem = () => ({ 'idempotency-key': randomUUID() });
let W = '';
let vendorId = '';
const doors: string[] = [];
let n = 0;

const plate = () => `TS08${TAG.slice(0, 2)}${String(1000 + (n++ % 8999))}`;
const eta = (mins = 60) => new Date(Date.now() + mins * 60_000).toISOString();
const DOCS = [
  { docType: 'PURCHASE_ORDER', refNo: 'PO-1' },
  { docType: 'DELIVERY_CHALLAN', refNo: 'DC-1' },
  { docType: 'EWAY_BILL', refNo: 'EWB-1', validUntil: '2099-12-31' },
];
const codes = (rs: { statusCode: number }[]) => rs.map((r) => r.statusCode).sort();
const wins = (rs: { statusCode: number }[], ok: number) =>
  rs.filter((r) => r.statusCode === ok).length;

const shipment = async (o: Record<string, unknown> = {}) => {
  const res = await call(app, 'POST', '/wms/gate/shipments', gate, {
    warehouseId: W,
    vendorId,
    transportType: 'TRUCK',
    etaAt: eta(),
    plannedVehicleRegNo: plate(),
    lines: [{ variantId: A, expectedQty: 10 }],
    documents: DOCS,
    ...o,
  });
  expect(res.statusCode, res.body).toBe(201);
  return data<{ id: string; plannedVehicleRegNo: string }>(res);
};

const gateIn = (shipmentId: string, reg: string, gross?: number) =>
  call(app, 'POST', '/wms/gate/entries', gate, {
    shipmentId,
    vehicleRegNo: reg,
    vehicleType: 'TRUCK',
    driverName: 'Surinder Singh',
    driverMobile: '9414088210',
    plateNote: 'Vehicle swapped by the transporter',
    ...(gross === undefined ? {} : { gross: { weightKg: gross } }),
  });

const entryStatus = async (id: string) =>
  data<{ status: string }>(await call(app, 'GET', `/wms/gate/entries/${id}`, gate)).status;

/** A truck at APPROVED (docs verified, inward pass issued). */
const approved = async () => {
  const s = await shipment({ dockDoorId: null });
  const e = data<{ entry: { id: string } }>(await gateIn(s.id, s.plannedVehicleRegNo, 8_500)).entry;
  const docs = data<{ items: { id: string; docType: string }[] }>(
    await call(app, 'GET', `/wms/gate/entries/${e.id}/documents`, gate),
  );
  for (const d of docs.items)
    await call(app, 'POST', `/wms/gate/documents/${d.id}/verify`, gate, {
      decision: 'VERIFIED',
      ...(d.docType === 'EWAY_BILL' ? { validUntil: '2099-12-31' } : {}),
    });
  const ap = await call(app, 'POST', `/wms/gate/entries/${e.id}/approve`, gate, {});
  expect(ap.statusCode, ap.body).toBe(200);
  return {
    s,
    e,
    passes: data<{ passes: { passNo: string; type: string; qrToken: string | null }[] }>(ap).passes,
  };
};

/** A truck at UNLOADED. */
const unloaded = async () => {
  const t = await approved();
  await call(app, 'POST', `/wms/gate/entries/${t.e.id}/handover`, gate, {});
  const u = await call(app, 'POST', `/wms/gate/entries/${t.e.id}/unloaded`, gate, {
    reason: 'Counted at the bay',
  });
  expect(u.statusCode, u.body).toBe(200);
  return t;
};

describe.skipIf(DB_URL === undefined)('D-62 gate races (Promise.all × 10)', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const db = app.diContainer.resolve('db');
    await db.wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, {
      variantId: A,
      productId: randomUUID(),
      sku: `RC-${A.slice(0, 4)}`,
      barcode: null,
      productName: 'Grower Feed 50kg',
      variantName: 'Grower Feed 50kg',
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
    W = data<{ id: string }>(
      await call(app, 'POST', '/admin/warehouses', gate, {
        code: randomCode('gr'),
        name: 'IT Gate Race',
        type: 'DEPOT',
        addressLine: 'Plot 1',
        city: 'Tanuku',
        district: 'West Godavari',
        stateCode: '37',
        pinCode: '534211',
        temperatureClasses: ['AMB'],
      }),
    ).id;
    for (const code of ['R1', 'R2'])
      doors.push(
        data<{ id: string }>(
          await call(app, 'POST', `/admin/warehouses/${W}/dock-doors`, gate, {
            code,
            name: `Bay ${code}`,
            type: 'UNLOADING',
            vehicleClass: 'ANY',
            capacityPerDay: 100,
            capacityUnit: 'TONNES',
          }),
        ).id,
      );
    vendorId = data<{ id: string }>(
      await call(app, 'POST', '/admin/wms/vendors', gate, {
        code: randomCode('VR').slice(0, 20),
        name: 'Race Feeds',
        defaultOwnership: 'FARMX',
      }),
    ).id;
  });

  afterAll(async () => {
    await app.diContainer
      .resolve('db')
      .wmsWarehouse.updateMany({ where: { id: W }, data: { deletedAt: new Date() } });
    await app.close();
  });

  it('two entries for one shipment → one', async () => {
    const s = await shipment();
    const rs = await Promise.all(X10.map(() => gateIn(s.id, plate())));
    expect(wins(rs, 201), JSON.stringify(codes(rs))).toBe(1);
    expect(rs.filter((r) => r.statusCode === 409)).toHaveLength(9);
  });

  it('the same truck inside twice (10 shipments, one plate) → one', async () => {
    const ships = await Promise.all(X10.map(() => shipment()));
    const reg = plate();
    const rs = await Promise.all(ships.map((s) => gateIn(s.id, reg)));
    expect(wins(rs, 201), JSON.stringify(codes(rs))).toBe(1);
    for (const r of rs.filter((x) => x.statusCode === 409))
      expect(errorOf(r).details?.reason).toBe('VEHICLE_INSIDE');
  });

  it('double approve → one inward pass', async () => {
    const s = await shipment();
    const e = data<{ entry: { id: string } }>(
      await gateIn(s.id, s.plannedVehicleRegNo, 8_000),
    ).entry;
    const docs = data<{ items: { id: string; docType: string }[] }>(
      await call(app, 'GET', `/wms/gate/entries/${e.id}/documents`, gate),
    );
    for (const d of docs.items)
      await call(app, 'POST', `/wms/gate/documents/${d.id}/verify`, gate, {
        decision: 'VERIFIED',
        ...(d.docType === 'EWAY_BILL' ? { validUntil: '2099-12-31' } : {}),
      });
    const rs = await Promise.all(
      X10.map(() => call(app, 'POST', `/wms/gate/entries/${e.id}/approve`, gate, {})),
    );
    expect(wins(rs, 200), JSON.stringify(codes(rs))).toBe(1);
    const live = await app.diContainer
      .resolve('db')
      .wmsGatePass.count({ where: { gateEntryId: e.id, status: { not: 'VOID' } } });
    expect(live).toBe(1);
  });

  it('pass QR double scan → one handover', async () => {
    const t = await approved();
    const token = t.passes.find((p) => p.type === 'INWARD')?.qrToken;
    const rs = await Promise.all(
      X10.map(() => call(app, 'POST', '/wms/gate/passes/scan', gate, { qrToken: token })),
    );
    expect(wins(rs, 200), JSON.stringify(codes(rs))).toBe(1);
    expect(await entryStatus(t.e.id)).toBe('UNLOADING');
  });

  it('scan vs reissue → exactly one wins', async () => {
    const t = await approved();
    const p = t.passes.find((x) => x.type === 'INWARD');
    const [scan, re] = await Promise.all([
      call(app, 'POST', '/wms/gate/passes/scan', gate, { qrToken: p?.qrToken }),
      call(app, 'POST', `/wms/gate/passes/${p?.passNo ?? ''}/reissue`, sup, {
        reason: 'QR smudged by rain',
      }),
    ]);
    expect([scan.statusCode === 200, re.statusCode === 201].filter(Boolean)).toHaveLength(1);
  });

  it('turn-away vs handover → exactly one', async () => {
    const t = await approved();
    const [ta, ho] = await Promise.all([
      call(app, 'POST', `/wms/gate/entries/${t.e.id}/turn-away`, sup, {
        reason: 'Load damaged in transit',
        shipmentAction: 'CANCEL',
      }),
      call(app, 'POST', `/wms/gate/entries/${t.e.id}/handover`, gate, {}),
    ]);
    expect([ta.statusCode, ho.statusCode].filter((c) => c === 200)).toHaveLength(1);
    expect(['REJECTED', 'UNLOADING']).toContain(await entryStatus(t.e.id));
  });

  it('two tare readings → one', async () => {
    const t = await unloaded();
    const rs = await Promise.all(
      X10.map((i) =>
        call(app, 'POST', `/wms/gate/entries/${t.e.id}/weighments`, gate, {
          kind: 'TARE',
          weightKg: 8_000 + i,
        }),
      ),
    );
    expect(wins(rs, 201), `${JSON.stringify(codes(rs))} ${rs[0]?.body ?? ''}`).toBe(1);
    const active = await app.diContainer
      .resolve('db')
      .wmsWeighment.count({ where: { gateEntryId: t.e.id, kind: 'TARE', status: 'ACTIVE' } });
    expect(active).toBe(1);
  });

  it('two pending overrides → one; override vs exit never both', async () => {
    const t = await unloaded();
    await call(app, 'POST', `/wms/gate/entries/${t.e.id}/weighments`, gate, {
      kind: 'TARE',
      weightKg: 8_000,
    });
    const st = await entryStatus(t.e.id);
    if (st === 'HELD')
      await call(app, 'POST', `/wms/gate/entries/${t.e.id}/hold/resolve`, sup, {
        resolution: 'ACCEPT_VARIANCE',
        note: 'Within the contract band',
      });
    const w = data<{ tare: { id: string } }>(
      await call(app, 'GET', `/wms/gate/entries/${t.e.id}/weighments`, gate),
    );
    const rs = await Promise.all(
      X10.map((i) =>
        call(app, 'POST', `/wms/gate/weighments/${w.tare.id}/override`, gate, {
          weightKg: 7_990 - i,
          reason: 'Sensor drift, manual read',
        }),
      ),
    );
    expect(wins(rs, 201), JSON.stringify(codes(rs))).toBe(1);
    const pending = data<{ id: string }>(rs.find((r) => r.statusCode === 201) ?? rs[0]!);
    await call(app, 'POST', `/wms/gate/weighments/${pending.id}/review`, sup, {
      decision: 'REJECT',
      note: 'Keep the scale reading',
    });

    const op = await call(app, 'POST', `/wms/gate/entries/${t.e.id}/outward-pass`, gate, {
      emptyTruckVerified: true,
    });
    expect(op.statusCode, op.body).toBe(200);
    const [ov, ex] = await Promise.all([
      call(app, 'POST', `/wms/gate/weighments/${w.tare.id}/override`, gate, {
        weightKg: 7_950,
        reason: 'Late correction from slip',
      }),
      call(app, 'POST', `/wms/gate/entries/${t.e.id}/exit`, gate, {}),
    ]);
    expect(ov.statusCode === 201 && ex.statusCode === 200).toBe(false);
    if (ex.statusCode === 200) expect(errorOf(ov).details?.reason).toBe('ENTRY_CLOSED');
    else expect(errorOf(ex).details?.reason).toBe('OVERRIDE_PENDING');
  });

  // Four CNs of one SKU at the same instant (the stock engine serialises them on the SKU row).
  it('several CNs + final flag + manual unloaded together: all CNs post, one transition', async () => {
    const t = await approved();
    await call(app, 'POST', `/wms/gate/entries/${t.e.id}/handover`, gate, {});
    const rs = await Promise.all([
      ...[0, 1, 2, 3].map((i) =>
        call(
          app,
          'POST',
          '/wms/stock/receipts',
          gate,
          {
            warehouseId: W,
            vendorId,
            gateEntryId: t.e.id,
            finalForGate: i % 3 === 0,
            lines: [
              {
                variantId: A,
                batchNo: `RC-${TAG}-${String(i)}-${randomUUID().slice(0, 4)}`,
                expiryDate: '2027-12-31',
                qty: 1,
              },
            ],
          },
          idem(),
        ),
      ),
      call(app, 'POST', `/wms/gate/entries/${t.e.id}/unloaded`, gate, {
        reason: 'Desk marked complete',
      }),
    ]);
    expect(
      rs.slice(0, 4).every((r) => r.statusCode === 201),
      rs.map((r) => `${String(r.statusCode)}:${r.body.slice(0, 200)}`).join(' | '),
    ).toBe(true);
    expect(await entryStatus(t.e.id)).toBe('UNLOADED');
    const links = await app.diContainer
      .resolve('db')
      .wmsGateEntryReceipt.count({ where: { gateEntryId: t.e.id } });
    const skipped = rs
      .slice(0, 4)
      .filter(
        (r) => r.json<{ data: { warnings?: unknown[] } }>().data.warnings !== undefined,
      ).length;
    expect(links + skipped).toBe(4);
    const unloadedEvents = await app.diContainer
      .resolve('db')
      .wmsGateEvent.count({ where: { gateEntryId: t.e.id, type: 'UNLOADED' } });
    expect(unloadedEvents).toBe(1);
  });

  it('wizard shipments on the same PO qty → one (PO row FOR UPDATE)', async () => {
    const po = data<{ id: string }>(
      await call(app, 'POST', '/wms/stock/restock-requests', gate, {
        type: 'PROCUREMENT',
        destWarehouseId: W,
        vendorId,
        requiredBy: '2026-12-31',
        lines: [{ variantId: A, requestedQty: 100 }],
      }),
    );
    await call(app, 'POST', `/wms/stock/restock-requests/${po.id}/submit`, gate);
    await call(app, 'POST', `/admin/wms/stock/restock-requests/${po.id}/approve`, sup, {});
    const rs = await Promise.all(
      X10.map(() =>
        call(app, 'POST', '/wms/gate/shipments', gate, {
          warehouseId: W,
          vendorId,
          restockRequestId: po.id,
          transportType: 'TRUCK',
          etaAt: eta(),
          lines: [{ variantId: A, expectedQty: 100 }],
        }),
      ),
    );
    expect(wins(rs, 201), JSON.stringify(codes(rs))).toBe(1);
    for (const r of rs.filter((x) => x.statusCode === 409))
      expect(errorOf(r).details?.reason).toBe('OVER_PO_QTY');
  });

  it('ASN converted twice / matched twice against the same PO qty → one each', async () => {
    const po = data<{ id: string }>(
      await call(app, 'POST', '/wms/stock/restock-requests', gate, {
        type: 'PROCUREMENT',
        destWarehouseId: W,
        vendorId,
        requiredBy: '2026-12-31',
        lines: [{ variantId: A, requestedQty: 50 }],
      }),
    );
    await call(app, 'POST', `/wms/stock/restock-requests/${po.id}/submit`, gate);
    await call(app, 'POST', `/admin/wms/stock/restock-requests/${po.id}/approve`, sup, {});
    const asns = await Promise.all(
      X10.map((i) =>
        call(app, 'POST', '/wms/gate/asns', gate, {
          warehouseId: W,
          vendorId,
          vendorAsnRef: `RA-${TAG}-${String(i)}`,
          etaAt: eta(),
          lines: [{ variantId: A, qty: 50 }],
        }),
      ),
    );
    const ids = asns.map((r) => data<{ id: string }>(r).id);
    const matched = await Promise.all(
      ids.map((id) =>
        call(app, 'POST', `/wms/gate/asns/${id}/match`, gate, { restockRequestId: po.id }),
      ),
    );
    const statuses = matched.map((r) => data<{ status: string }>(r).status);
    expect(statuses.filter((s) => s === 'MATCHED')).toHaveLength(1);
    const winner = ids[statuses.indexOf('MATCHED')] ?? '';
    const conv = await Promise.all(
      X10.map(() => call(app, 'POST', `/wms/gate/asns/${winner}/convert`, gate, {})),
    );
    expect(wins(conv, 201), JSON.stringify(codes(conv))).toBe(1);
  });

  it('the same dock slot booked ten times → one', async () => {
    const start = eta(48 * 60);
    const rs = await Promise.all(
      X10.map(() =>
        call(app, 'POST', '/wms/gate/appointments', gate, {
          warehouseId: W,
          vendorId,
          slotStart: start,
          dockDoorId: doors[0],
        }),
      ),
    );
    expect(wins(rs, 201), JSON.stringify(codes(rs))).toBe(1);
    for (const r of rs.filter((x) => x.statusCode === 409))
      expect(errorOf(r).details?.reason).toBe('DOCK_BUSY');
  });

  it('edit shipment during gate-in: never both on a stale version', async () => {
    const s = await shipment();
    const cur = data<{ version: number }>(
      await call(app, 'GET', `/wms/gate/shipments/${s.id}`, gate),
    );
    const [patch, gi] = await Promise.all([
      call(app, 'PATCH', `/wms/gate/shipments/${s.id}`, gate, {
        notes: 'Driver changed',
        expectedVersion: cur.version,
      }),
      gateIn(s.id, s.plannedVehicleRegNo),
    ]);
    expect(gi.statusCode, gi.body).toBe(201);
    if (patch.statusCode === 200) {
      // The edit committed first; the entry then moved the shipment on.
      expect(
        data<{ stage: string }>(await call(app, 'GET', `/wms/gate/shipments/${s.id}`, gate)).stage,
      ).toBe('ARRIVED');
    } else expect(patch.statusCode).toBe(409);
  });

  it('the same Idempotency-Key ten times → one row (replays / in-flight 409)', async () => {
    const key = { 'idempotency-key': randomUUID() };
    const body = { warehouseId: W, name: 'Parallel Visitor', purpose: 'Maintenance' };
    const rs = await Promise.all(
      X10.map(() => call(app, 'POST', '/wms/gate/visitors', gate, body, key)),
    );
    expect(rs.every((r) => r.statusCode === 201 || r.statusCode === 409)).toBe(true);
    const rows = await app.diContainer
      .resolve('db')
      .wmsGateVisitor.count({ where: { warehouseId: W, name: 'Parallel Visitor' } });
    expect(rows).toBe(1);
  });
});
