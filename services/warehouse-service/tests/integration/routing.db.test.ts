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
  randomPinBase,
  staff,
} from './harness.js';

/** D-57b Phase 5 W3.12: routing rules, simulation on real node facts, snapshot publishing. */
let app: FastifyInstance;
const admin = staff([
  'warehouse.view',
  'warehouse.configure',
  'warehouse.create',
  'inventory.view',
  'inventory.receive',
  'quality.hold_release',
  'fulfilment.view',
  'routing.manage',
]);
const viewer = staff(['fulfilment.view']);
const A = randomUUID();
const PIN = String(randomPinBase() + 7);
/** Delivery point near NEAR; FAR is ~60 km away. */
const POINT = { lat: 16.83, lng: 80.85 };
let NEAR = '';
let FAR = '';
const made: string[] = [];

interface Sim {
  decision: {
    ruleId: string | null;
    fallbackUsed: boolean;
    hold: boolean;
    winner: { id: string } | null;
    ordered: { id: string }[];
  };
  tree: {
    ruleId: string;
    outcome: string;
    candidates: { warehouseId: string; gate: string | null }[];
  }[];
  nodes: { warehouseId: string; fullStock: boolean; stockUnits: number; distanceKm: number }[];
}
interface Rule {
  id: string;
  priority: number | null;
  status: string;
  version: number;
  conditionsText: string[];
  primaryWarehouse: { id: string; code: string } | null;
}

const order = (extra: object = {}) => ({
  pinCode: PIN,
  stateCode: '37',
  district: 'Eluru',
  orderValue: 4200,
  ...POINT,
  lines: [{ variantId: A, qty: 5 }],
  ...extra,
});
const simulate = async (body: object = order()) => {
  const res = await call(app, 'POST', '/admin/wms/routing/simulate', admin, body);
  expect(res.statusCode, res.body).toBe(200);
  return data<Sim>(res);
};
const snapshots = async () => {
  const rows = await app.diContainer.resolve('db').outboxEvent.findMany({
    where: { type: 'warehouse.routing_rules_replaced.v1' },
    orderBy: { createdAt: 'asc' },
    select: { payload: true },
  });
  return rows.map(
    (r) =>
      (
        r.payload as {
          data: {
            version: number;
            rules: { id: string; priority: number; isEnabled: boolean }[];
            fallback: { strategy: string };
            throttles: { warehouseId: string; paused: boolean }[];
          };
        }
      ).data,
  );
};

const depot = async (name: string, lat: number, lng: number) => {
  const id = data<{ id: string }>(
    await call(app, 'POST', '/admin/warehouses', admin, {
      code: randomCode('rt'),
      name,
      type: 'DEPOT',
      addressLine: 'NH-16',
      city: 'Eluru',
      district: 'Eluru',
      stateCode: '37',
      pinCode: PIN,
      temperatureClasses: ['AMB'],
    }),
  ).id;
  made.push(id);
  const area = await call(app, 'POST', `/admin/warehouses/${id}/service-areas`, admin, {
    expectedVersion: 0,
    stateCode: '37',
    district: 'Eluru',
    priority: 'HIGH',
    pins: [PIN],
  });
  expect(area.statusCode, area.body).toBe(201);
  // Activation needs the full setup checklist (covered by the D-56 suite): set it directly here.
  await app.diContainer.resolve('db').wmsWarehouse.update({
    where: { id },
    data: { status: 'ACTIVE', isAllocatable: true, latitude: lat, longitude: lng },
  });
  return id;
};

describe.skipIf(DB_URL === undefined)('D-57b routing rules against Postgres', () => {
  beforeAll(async () => {
    app = await buildTestApp();
    const db = app.diContainer.resolve('db');
    await db.wmsSetting.upsert({
      where: { key_scope: { key: 'stock.writesMode', scope: 'GLOBAL' } },
      create: { key: 'stock.writesMode', scope: 'GLOBAL', value: 'WMS' },
      update: { value: 'WMS' },
    });
    await db.wmsRoutingRule.updateMany({
      where: { deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await db.wmsSetting.deleteMany({ where: { key: 'fulfilment.allocationFallback' } });
    inventoryCutover.mode = 'WMS';
    productFacts.set(A, {
      variantId: A,
      productId: randomUUID(),
      sku: `RT-${A.slice(0, 4)}`,
      barcode: null,
      productName: 'Layer Mash 50 kg',
      variantName: 'Layer Mash 50 kg',
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
    NEAR = await depot('IT Nuzvid Depot', 16.79, 80.85);
    FAR = await depot('IT Tanuku Depot', 16.75, 81.68);
    // Stock only at FAR (20 units, released from QC).
    const zone = data<{ id: string }>(
      await call(app, 'POST', `/admin/warehouses/${FAR}/zones`, admin, {
        code: 'A',
        name: 'Feed',
        temperatureClass: 'AMB',
      }),
    );
    await call(app, 'POST', `/admin/warehouses/${FAR}/zones/${zone.id}/racks`, admin, {
      maxWeightKg: 9000,
      volumeM3: 30,
      generateBins: { count: 1, maxWeightKg: 3000, volumeM3: 10 },
    });
    const [bin] = data<{ id: string }[]>(
      await call(app, 'GET', `/admin/warehouses/${FAR}/bins?limit=5`, admin),
    );
    const r = await call(
      app,
      'POST',
      '/wms/stock/receipts',
      admin,
      {
        warehouseId: FAR,
        lines: [
          { variantId: A, batchNo: `RT-${PIN}`, expiryDate: '2027-09-01', qty: 20, binId: bin?.id },
        ],
      },
      { 'idempotency-key': randomUUID() },
    );
    expect(r.statusCode, r.body).toBe(201);
    for (const l of data<{ lines: { batchId: string }[] }>(r).lines)
      await call(app, 'POST', '/wms/stock/quality/release', admin, {
        warehouseId: FAR,
        batchId: l.batchId,
      });
  });

  afterAll(async () => {
    const db = app.diContainer.resolve('db');
    await db.wmsRoutingRule.updateMany({
      where: { deletedAt: null },
      data: { deletedAt: new Date() },
    });
    await db.wmsRoutingThrottle.deleteMany({ where: { warehouseId: { in: made } } });
    await db.wmsSetting.deleteMany({ where: { key: 'fulfilment.allocationFallback' } });
    await db.wmsWarehouse.updateMany({
      where: { id: { in: made } },
      data: { deletedAt: new Date(), status: 'INACTIVE' },
    });
    await app.close();
  });

  it('no rules → the fallback (next nearest) decides on real node facts', async () => {
    const s = await simulate();
    expect(s.decision).toMatchObject({ ruleId: null, fallbackUsed: true, hold: false });
    expect(s.decision.winner?.id).toBe(NEAR);
    const far = s.nodes.find((n) => n.warehouseId === FAR);
    expect(far).toMatchObject({ fullStock: true, stockUnits: 20 });
    expect(s.nodes.find((n) => n.warehouseId === NEAR)?.fullStock).toBe(false);
  });

  let rule: Rule;
  it('rule CRUD: create publishes a snapshot; gates pick the stocked node; LOWEST_COST is refused', async () => {
    const before = (await snapshots()).length;
    const res = await call(app, 'POST', '/admin/wms/routing/rules', admin, {
      name: `Eluru belt ${PIN}`,
      tag: 'standard',
      conditions: [
        { type: 'PIN_LIST', pins: [PIN] },
        { type: 'ORDER_VALUE', op: 'gte', amount: 1000 },
      ],
      primaryWarehouseId: NEAR,
      fallbackWarehouseIds: [FAR],
      rankBy: 'PRIORITY',
      gates: { stockFull: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    rule = data<Rule>(res);
    expect(rule).toMatchObject({ priority: 1, status: 'ACTIVE' });
    expect(rule.conditionsText).toContain('value gte 1000');
    const snaps = await snapshots();
    expect(snaps.length).toBe(before + 1);
    const last = snaps.at(-1);
    expect(last?.rules.map((r) => r.id)).toEqual([rule.id]);
    expect(last?.version).toBeGreaterThan(snaps.at(-2)?.version ?? 0);

    const s = await simulate();
    expect(s.decision.ruleId).toBe(rule.id);
    expect(s.decision.winner?.id).toBe(FAR);
    const step = s.tree.find((t) => t.ruleId === rule.id);
    expect(step?.outcome).toBe('SELECTED');
    expect(step?.candidates.find((c) => c.warehouseId === NEAR)?.gate).toBe('STOCK_NOT_FULL');

    // Value below the condition → the rule does not match.
    const low = await simulate(order({ orderValue: 500 }));
    expect(low.tree[0]?.outcome).toBe('NOT_MATCHED');
    expect(low.decision.fallbackUsed).toBe(true);

    const cost = await call(app, 'POST', '/admin/wms/routing/rules', admin, {
      name: 'Cheapest',
      conditions: [],
      primaryWarehouseId: NEAR,
      rankBy: 'LOWEST_COST',
    });
    expect(cost.statusCode).toBe(422);
    expect(errorOf(cost).details?.reason).toBe('NOT_AVAILABLE');

    // Writes are admin-panel only; panel reads work.
    expect((await call(app, 'POST', '/wms/routing/rules', admin, { name: 'x' })).statusCode).toBe(
      404,
    );
    const list = await call(app, 'GET', '/wms/routing/rules', viewer);
    expect(list.statusCode, list.body).toBe(200);
    expect(data<Rule[]>(list).some((r) => r.id === rule.id)).toBe(true);
    // Simulation needs routing.manage.
    expect((await call(app, 'POST', '/wms/routing/simulate', viewer, order())).statusCode).toBe(
      403,
    );
  });

  it('insert at priority 1, reorder, disable / enable, history + audit', async () => {
    const top = data<Rule>(
      await call(app, 'POST', '/admin/wms/routing/rules', admin, {
        name: `Express ${PIN}`,
        conditions: [{ type: 'ORDER_WEIGHT_KG', op: 'gte', kg: 10_000 }],
        primaryWarehouseId: FAR,
        priority: 1,
      }),
    );
    expect(top.priority).toBe(1);
    expect(
      data<Rule>(await call(app, 'GET', `/admin/wms/routing/rules/${rule.id}`, admin)).priority,
    ).toBe(2);

    const reordered = await call(app, 'PUT', '/admin/wms/routing/rules/order', admin, {
      ruleIds: [rule.id, top.id],
    });
    expect(reordered.statusCode, reordered.body).toBe(200);
    expect(
      data<Rule[]>(reordered)
        .filter((r) => r.status === 'ACTIVE')
        .map((r) => r.id),
    ).toEqual([rule.id, top.id]);
    const bad = await call(app, 'PUT', '/admin/wms/routing/rules/order', admin, {
      ruleIds: [rule.id],
    });
    expect(errorOf(bad).details?.reason).toBe('ORDER_MISMATCH');

    rule = data<Rule>(await call(app, 'GET', `/admin/wms/routing/rules/${rule.id}`, admin));
    const off = await call(app, 'POST', `/admin/wms/routing/rules/${rule.id}/disable`, admin, {
      expectedVersion: rule.version,
    });
    expect(data<Rule>(off).status).toBe('INACTIVE');
    expect((await simulate()).decision.ruleId).toBeNull();
    const stale = await call(app, 'POST', `/admin/wms/routing/rules/${rule.id}/enable`, admin, {
      expectedVersion: rule.version,
    });
    expect(errorOf(stale).details?.reason).toBe('VERSION_CONFLICT');
    rule = data<Rule>(
      await call(app, 'POST', `/admin/wms/routing/rules/${rule.id}/enable`, admin, {
        expectedVersion: data<Rule>(off).version,
      }),
    );
    expect(rule.status).toBe('ACTIVE');

    const hist = await call(
      app,
      'GET',
      `/admin/wms/routing/rules/${rule.id}/history?limit=20`,
      admin,
    );
    expect(data<{ action: string }[]>(hist).map((h) => h.action)).toEqual(
      expect.arrayContaining(['CREATE', 'REORDER', 'DISABLE', 'ENABLE']),
    );
    const audit = await call(app, 'GET', '/admin/wms/routing/audit?limit=50', admin);
    expect(data<{ action: string }[]>(audit).map((a) => a.action)).toEqual(
      expect.arrayContaining(['routing.reorder', 'routing.rule_create', 'routing.rule_disable']),
    );
  });

  it('throttle pause → gate THROTTLED, fallback skips the node; snapshot carries the throttle', async () => {
    const t = await call(app, 'PUT', `/admin/wms/routing/throttles/${FAR}`, admin, {
      paused: true,
      maxOrdersPerDay: null,
      note: 'Dock repair',
    });
    expect(t.statusCode, t.body).toBe(200);
    expect(data(t)).toMatchObject({ paused: true });
    const s = await simulate();
    const step = s.tree.find((x) => x.ruleId === rule.id);
    expect(step?.outcome).toBe('NO_ELIGIBLE_NODE');
    expect(step?.candidates.find((c) => c.warehouseId === FAR)?.gate).toBe('THROTTLED');
    expect(s.decision.ordered.map((o) => o.id)).not.toContain(FAR);
    expect((await snapshots()).at(-1)?.throttles).toEqual(
      expect.arrayContaining([expect.objectContaining({ warehouseId: FAR, paused: true })]),
    );
    const load = data<{ nodes: { warehouseId: string; paused: boolean }[] }>(
      await call(app, 'GET', '/wms/routing/node-load', viewer),
    );
    expect(load.nodes.find((n) => n.warehouseId === FAR)?.paused).toBe(true);
    await call(app, 'PUT', `/admin/wms/routing/throttles/${FAR}`, admin, {
      paused: false,
      maxOrdersPerDay: 500,
    });
  });

  it('fallback policy: HOLD_ORDER holds unmatched orders; CENTRAL needs a node', async () => {
    const bad = await call(app, 'PUT', '/admin/wms/routing/fallback', admin, {
      strategy: 'CENTRAL',
      allowPartial: true,
    });
    expect(bad.statusCode).toBe(422);
    const ok = await call(app, 'PUT', '/admin/wms/routing/fallback', admin, {
      strategy: 'HOLD_ORDER',
      allowPartial: false,
      reason: 'Quarantine unmatched orders',
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(data<{ pipeline: unknown[] }>(ok).pipeline.length).toBeGreaterThan(3);
    expect((await snapshots()).at(-1)?.fallback.strategy).toBe('HOLD_ORDER');
    const s = await simulate(order({ orderValue: 10 }));
    expect(s.decision).toMatchObject({ fallbackUsed: true, hold: true, winner: null });
    await call(app, 'PUT', '/admin/wms/routing/fallback', admin, {
      strategy: 'NEXT_NEAREST',
      allowPartial: true,
    });
  });

  it('test matrix, duplicate (draft), catalog, summary, export, delete', async () => {
    const m = await call(app, 'POST', '/admin/wms/routing/simulate-matrix', admin, {
      cases: [
        { label: 'stocked', order: order(), expect: { warehouseId: FAR, ruleId: rule.id } },
        { label: 'low value', order: order({ orderValue: 50 }), expect: { warehouseId: FAR } },
      ],
    });
    expect(m.statusCode, m.body).toBe(200);
    expect(data<{ totals: object }>(m).totals).toMatchObject({ cases: 2, passed: 1, failed: 1 });

    const dup = await call(app, 'POST', `/admin/wms/routing/rules/${rule.id}/duplicate`, admin);
    expect(dup.statusCode, dup.body).toBe(201);
    expect(data<Rule>(dup)).toMatchObject({ status: 'DRAFT', priority: null });
    // Drafts are not published and join a simulation only when asked.
    expect((await snapshots()).at(-1)?.rules.map((r) => r.id)).not.toContain(data<Rule>(dup).id);

    const cat = data<{
      rankBy: { value: string; available: boolean }[];
      warehouses: { id: string }[];
    }>(await call(app, 'GET', '/wms/routing/condition-catalog', viewer));
    expect(cat.rankBy.find((r) => r.value === 'LOWEST_COST')?.available).toBe(false);
    expect(cat.warehouses.map((w) => w.id)).toEqual(expect.arrayContaining([NEAR, FAR]));

    const sum = data<{ active: number; draft: number; loadStatus: string }>(
      await call(app, 'GET', '/wms/routing/summary', viewer),
    );
    expect(sum.active).toBeGreaterThanOrEqual(2);
    expect(sum.draft).toBeGreaterThanOrEqual(1);
    expect(['BALANCED', 'STRAINED', 'SATURATED']).toContain(sum.loadStatus);

    const csv = await call(app, 'GET', '/admin/wms/routing/rules/export.csv', admin);
    expect(csv.statusCode).toBe(200);
    expect(csv.body).toContain(`Eluru belt ${PIN}`);

    const del = await call(app, 'DELETE', `/admin/wms/routing/rules/${rule.id}`, admin, {
      expectedVersion: rule.version,
      reason: 'Replaced by the express rule',
    });
    expect(del.statusCode, del.body).toBe(200);
    expect((await call(app, 'GET', `/admin/wms/routing/rules/${rule.id}`, admin)).statusCode).toBe(
      404,
    );
    // History of a deleted rule stays readable.
    const hist = await call(app, 'GET', `/admin/wms/routing/rules/${rule.id}/history`, admin);
    expect(data<{ action: string }[]>(hist)[0]?.action).toBe('DELETE');
  });
});
