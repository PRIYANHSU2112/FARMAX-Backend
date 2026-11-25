import type { Cradle } from '@fastify/awilix';

import { SYSTEM_ACTOR } from './fulfilment.flow.js';
import { PRE_PICK, addDays, istDay } from './fulfilment.rules.js';

const REPORT_KEY = 'fulfilment.reconcileReport';
const PENDING_KEY = 'fulfilment.reconcilePending';

interface Mismatch {
  key: string;
  warehouseId: string;
  orderId: string;
  variantId: string;
  wms: number;
  inventory: number;
}

/**
 * Fulfilment background jobs (D-57b §9): SLA watch, allocation reconcile (§2a.3) and the nightly
 * rollup. Every job is idempotent and safe to run on any replica (BullMQ scheduler = one run).
 */
export class FulfilmentJobs {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'fulfilmentReadRepository'
      | 'fulfilmentSync'
      | 'fulfilmentExceptions'
      | 'fulfilmentSettings'
      | 'shipmentFlow'
      | 'stockSettings'
      | 'inventoryClient'
      | 'fulfilmentFloor'
      | 'runInTransaction'
      | 'logger'
    >,
  ) {}

  /** At-risk flag ≤ 60 min before the SLA; a CRITICAL exception once past SLA + grace. */
  async slaWatch() {
    const rows = await this.deps.fulfilmentReadRepository.slaCandidates(500);
    const now = Date.now();
    let flagged = 0;
    let breached = 0;
    for (const r of rows) {
      const grace = await this.deps.fulfilmentSettings.get('fulfilment.graceHours', r.warehouseId);
      await this.deps.runInTransaction(async (tx) => {
        const s = await this.deps.fulfilmentRepository.lockShipment(tx, r.id);
        if (s === null) return;
        if (!s.atRisk) {
          await this.deps.fulfilmentRepository.updateShipment(tx, s.id, { atRisk: true });
          await this.deps.shipmentFlow.note(
            tx,
            s,
            'SLA_AT_RISK',
            SYSTEM_ACTOR,
            `Due ${r.slaDueAt.toISOString()}`,
          );
          flagged += 1;
        }
        if (r.slaDueAt.getTime() + grace * 3_600_000 < now) {
          await this.deps.fulfilmentExceptions.raise(tx, {
            type: s.status === 'RELEASED' ? 'ALLOCATION_ISSUE' : 'DELIVERY',
            cause: 'OTHER',
            severity: 'CRITICAL',
            warehouseId: s.warehouseId,
            orderId: s.orderId,
            shipmentId: s.id,
            title: `Dispatch SLA breached (${s.status.toLowerCase().replaceAll('_', ' ')})`,
            diagnostic: { slaDueAt: r.slaDueAt, status: s.status, holdActive: s.holdActive },
            proposal: { action: s.status === 'RELEASED' ? 'RETRY_ALLOCATION' : 'EXPEDITE' },
            dedupeKey: `sla:${s.id}`,
          });
          breached += 1;
        }
      });
    }
    return { checked: rows.length, flagged, breached };
  }

  /**
   * Allocation reconcile (§2a.3): WMS open line quantity vs inventory held quantity per
   * (order, warehouse, SKU). Acts only on a mismatch seen in two runs in a row; never touches
   * picked / packed stock or a shipment on the floor (exception only).
   */
  async reconcileAllocations() {
    const whs = await this.deps.fulfilmentReadRepository.warehousesWithShipments();
    const seen: Mismatch[] = [];
    for (const { warehouseId } of whs) {
      const held = new Map<string, number>();
      let cursor: string | undefined;
      for (;;) {
        const page = await this.deps.inventoryClient.openLines(warehouseId, cursor, 500);
        if (page === null) return { skipped: 'INVENTORY_UNAVAILABLE' };
        for (const l of page.items)
          held.set(
            `${l.orderRef}|${l.variantId}`,
            (held.get(`${l.orderRef}|${l.variantId}`) ?? 0) + l.heldQty,
          );
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      const wms = new Map<string, number>();
      for (const l of await this.deps.fulfilmentReadRepository.openShipmentLines(warehouseId))
        wms.set(
          `${l.orderId}|${l.variantId}`,
          (wms.get(`${l.orderId}|${l.variantId}`) ?? 0) + l.active,
        );
      // Open backorders keep their claim on the reservation (W3.14): never "fixed" away.
      for (const b of await this.deps.fulfilmentReadRepository.openBackorders(warehouseId))
        wms.set(
          `${b.orderId}|${b.variantId}`,
          (wms.get(`${b.orderId}|${b.variantId}`) ?? 0) + b.qty,
        );
      // Dispatched but not issued yet: inventory still holds it. After 15 min → re-send the
      // dispatch with the SAME dispatchId (inventory issues once); before that it is in flight.
      const sent = new Map<string, { qty: number; shipments: Set<string>; oldest: number }>();
      for (const l of await this.deps.fulfilmentReadRepository.dispatchedLines(
        warehouseId,
        new Date(Date.now() - 7 * 86_400_000),
      )) {
        const k = `${l.orderId}|${l.variantId}`;
        const cur = sent.get(k) ?? { qty: 0, shipments: new Set<string>(), oldest: Date.now() };
        cur.qty += l.qty;
        cur.shipments.add(l.shipmentId);
        cur.oldest = Math.min(cur.oldest, l.dispatchedAt.getTime());
        sent.set(k, cur);
      }
      for (const key of new Set([...held.keys(), ...wms.keys()])) {
        const a = wms.get(key) ?? 0;
        const b = held.get(key) ?? 0;
        if (a === b) continue;
        const d = sent.get(key);
        if (b > a && d !== undefined && d.qty >= b - a) {
          if (Date.now() - d.oldest >= 15 * 60_000)
            await this.deps.runInTransaction(async (tx) => {
              for (const sid of d.shipments)
                await this.deps.fulfilmentFloor.republishDispatch(tx, sid);
            });
          continue;
        }
        const [orderId = '', variantId = ''] = key.split('|');
        seen.push({
          key: `${warehouseId}|${key}`,
          warehouseId,
          orderId,
          variantId,
          wms: a,
          inventory: b,
        });
      }
    }
    const before = new Set(
      ((await this.deps.stockSettings.raw([PENDING_KEY])).get(PENDING_KEY) as
        string[] | undefined) ?? [],
    );
    const actions: { key: string; action: string }[] = [];
    for (const m of seen.filter((x) => before.has(x.key)))
      actions.push({ key: m.key, action: await this.fix(m) });
    const report = {
      runAt: new Date().toISOString(),
      warehouses: whs.length,
      mismatches: seen.length,
      actedOn: actions.length,
      items: seen.slice(0, 200).map((m) => ({
        ...m,
        action: actions.find((a) => a.key === m.key)?.action ?? 'WAIT_SECOND_RUN',
      })),
    };
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.stockSettings.setRaw(
        tx,
        PENDING_KEY,
        seen.filter((m) => !actions.some((a) => a.key === m.key)).map((m) => m.key),
        null,
      );
      await this.deps.stockSettings.setRaw(tx, REPORT_KEY, report, null);
    });
    return { mismatches: seen.length, acted: actions.length };
  }

  async report() {
    return (await this.deps.stockSettings.raw([REPORT_KEY])).get(REPORT_KEY) ?? null;
  }

  private async fix(m: Mismatch): Promise<string> {
    return this.deps.runInTransaction(async (tx) => {
      const shipments = await this.deps.fulfilmentRepository.lockOrderShipments(tx, m.orderId);
      const s = shipments.find((x) => x.warehouseId === m.warehouseId && x.status !== 'CANCELLED');
      const raise = (title: string) =>
        this.deps.fulfilmentExceptions.raise(tx, {
          type: 'ALLOCATION_MISMATCH',
          cause: 'DRIFT',
          severity: 'HIGH',
          warehouseId: m.warehouseId,
          orderId: m.orderId,
          shipmentId: s?.id ?? null,
          variantId: m.variantId,
          requiredQty: m.inventory,
          availableQty: m.wms,
          impactedQty: Math.abs(m.wms - m.inventory),
          title,
          diagnostic: { wms: m.wms, inventory: m.inventory },
          proposal: { action: m.wms > m.inventory ? 'RESTOCK' : 'ADD_LINE' },
          dedupeKey: `recon:${m.key}`,
        });
      if (m.wms > m.inventory) {
        if (s === undefined) return 'NONE';
        if (!PRE_PICK.includes(s.status)) {
          await raise(
            'Shipment holds more than the reservation (on the floor: supervisor decides)',
          );
          return 'EXCEPTION_ONLY';
        }
        await this.deps.fulfilmentSync.shrink(
          tx,
          s,
          m.variantId,
          m.wms - m.inventory,
          SYSTEM_ACTOR,
          'Allocation reconcile',
        );
        await raise('Shipment line reduced to the reservation');
        return 'WMS_REDUCED';
      }
      const order = await this.deps.fulfilmentRepository.lockOrder(tx, m.orderId);
      if (order === null) return 'NO_ORDER';
      if (s === undefined) {
        const created = await this.deps.fulfilmentSync.createShipment(tx, order, m.warehouseId, [
          { variantId: m.variantId, qty: m.inventory - m.wms },
        ]);
        if (order.orderStatus !== 'PENDING_ADMIN_CONFIRMATION')
          await this.deps.fulfilmentSync.release(tx, created, new Date());
        return 'SHIPMENT_CREATED';
      }
      if (!PRE_PICK.includes(s.status)) {
        await raise('Reservation holds more than the shipment (on the floor)');
        return 'EXCEPTION_ONLY';
      }
      const line = s.lines.find((l) => l.variantId === m.variantId);
      if (line === undefined)
        await this.deps.fulfilmentRepository.addLine(tx, {
          shipmentId: s.id,
          lineNo: Math.max(0, ...s.lines.map((l) => l.lineNo)) + 1,
          variantId: m.variantId,
          qty: m.inventory - m.wms,
          orderLineNo: order.lines.find((l) => l.variantId === m.variantId)?.lineNo ?? null,
        });
      else
        await this.deps.fulfilmentRepository.updateLine(tx, s.id, line.lineNo, {
          qty: line.qty + (m.inventory - m.wms),
        });
      if (s.status === 'ALLOCATED' || s.status === 'ASSIGNED') {
        await this.deps.fulfilmentRepository.cancelTasks(tx, s.id);
        await this.deps.shipmentFlow.move(tx, s, 'RELEASED', SYSTEM_ACTOR, 'RECONCILE_LINE_ADDED', {
          force: true,
        });
      }
      return 'WMS_RAISED';
    });
  }

  /** Nightly: yesterday's counters rebuilt from the shipment timestamps. */
  async rollup() {
    const day = addDays(istDay(new Date()), -1);
    await this.deps.fulfilmentReadRepository.rebuildDay(day);
    return { day };
  }
}
