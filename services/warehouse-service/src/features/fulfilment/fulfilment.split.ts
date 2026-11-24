import {
  AppError,
  ConflictError,
  ErrorCode,
  ForbiddenError,
  NotFoundError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import { WAREHOUSE_EVENTS } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitWarehouseEvent } from '../../adapters/events.js';
import type { Caller } from '../../middleware/guards.js';
import { type Paging, offsetOf, toPageResult } from '../../middleware/paging.js';
import { SYSTEM_ACTOR } from './fulfilment.flow.js';
import type { BackorderRow, BackorderStatus } from './fulfilment.backorders.repository.js';
import type { OrderRow, ShipmentRow } from './fulfilment.repository.js';
import {
  IN_WAREHOUSE,
  PRE_PICK,
  addDays,
  distanceKm,
  isoDayOf,
  istAt,
  istDay,
} from './fulfilment.rules.js';

const actorOf = (c: Caller) => ({ userId: c.userId, ip: c.ip, requestId: c.requestId });
const flowActor = (c: Caller) => ({
  type: 'STAFF' as const,
  id: c.userId,
  requestId: c.requestId,
  access: c.access,
});
const num = (d: { toString(): string } | null | undefined) =>
  d === null || d === undefined ? null : Number(d.toString());
const invalid = (message: string, reason: string, extra: object = {}) =>
  new AppError(ErrorCode.VALIDATION_ERROR, message, 422, { details: { reason, ...extra } });

export type SplitStrategy = 'LEAST_COST' | 'NEAREST' | 'FEWEST_SPLITS';
interface Qty {
  variantId: string;
  qty: number;
}
export interface LegInput {
  warehouseId: string;
  lines: Qty[];
  plannedAt?: string | null;
}
export interface BackorderInput extends Qty {
  promiseDate?: string | null;
}

/** Vehicle class suggestion by leg weight (dispatch fleet classes). */
const fleetFor = (kg: number) =>
  kg <= 1_000 ? 'MINI_TRUCK' : kg <= 7_000 ? 'TRUCK' : ('HEAVY_TRUCK' as const);

/**
 * Split, partial & backorder (D-57b W3.14). A split moves units to other nodes through the
 * reallocation saga (§2a.4, one leg at a time); units nobody can ship become backorders — they
 * keep their inventory reservation (first claim on incoming stock) and the backorder job ships
 * them when stock arrives (same shipment while it is still on the floor, else a follow-up
 * shipment). A partial ship cancels the short units through order-service (refund + release).
 */
export class FulfilmentSplit {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'backordersRepository'
      | 'fulfilmentOrders'
      | 'fulfilmentSync'
      | 'shipmentFlow'
      | 'fulfilmentSettings'
      | 'stockService'
      | 'warehousesService'
      | 'serviceAreasService'
      | 'calendarService'
      | 'docksService'
      | 'orderClient'
      | 'runInTransaction'
      | 'auditService'
      | 'logger'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  // ── context + proposal ──

  /** Order header, shortage banner, per-node fit, open backorders. */
  async context(caller: Caller, orderId: string) {
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    const need = this.openNeed(shipments);
    const nodes = await this.nodes(order, [...need.keys()]);
    const current = shipments.filter((s) => IN_WAREHOUSE.includes(s.status));
    const lines = [...need].map(([variantId, n]) => {
      const ol = order.lines.find((l) => l.variantId === variantId);
      const at = current.find((s) => s.lines.some((l) => l.variantId === variantId));
      const here = nodes.find((x) => x.warehouseId === at?.warehouseId);
      const availableHere = here?.available.get(variantId) ?? 0;
      return {
        variantId,
        sku: ol?.sku ?? null,
        name: ol?.name ?? null,
        need: n,
        warehouseId: at?.warehouseId ?? null,
        availableHere,
        networkAvailable: nodes.reduce((s, x) => s + (x.available.get(variantId) ?? 0), 0),
        shortHere: Math.max(0, n - availableHere),
      };
    });
    const short = lines.filter((l) => l.shortHere > 0);
    const backorders = await this.deps.backordersRepository.ofOrder(orderId);
    return {
      order: {
        orderId,
        orderNo: order.orderNo,
        customerName: order.customerName,
        customerPoRef: order.customerPoRef,
        pinCode: order.pinCode,
        district: order.district,
        grandTotal: order.grandTotal.toFixed(2),
        placedAt: order.placedAt,
      },
      shipments: shipments.map((s) => ({
        id: s.id,
        shipmentNo: s.shipmentNo,
        warehouseId: s.warehouseId,
        status: s.status,
        editable: PRE_PICK.includes(s.status),
      })),
      banner: {
        short: short.length > 0,
        shortLines: short.length,
        shortUnits: short.reduce((n, l) => n + l.shortHere, 0),
        message:
          short.length === 0
            ? null
            : `${String(short.length)} item(s) short at the assigned warehouse; split, ship partly or backorder.`,
      },
      lines,
      fit: nodes.map((x) => {
        const units = lines.reduce(
          (s, l) => s + Math.min(l.need, x.available.get(l.variantId) ?? 0),
          0,
        );
        const total = lines.reduce((s, l) => s + l.need, 0);
        return {
          warehouseId: x.warehouseId,
          code: x.code,
          name: x.name,
          distanceKm: x.distanceKm,
          routable: x.routable,
          units,
          fit: units >= total && total > 0 ? 'ALL' : units > 0 ? 'PARTIAL' : 'NONE',
        };
      }),
      backorders: backorders.map((b) => this.backorderView(b)),
    };
  }

  /** Proposed legs for a strategy (+ what nobody can ship → backorder). */
  async proposal(caller: Caller, orderId: string, strategy: SplitStrategy) {
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    const need = this.openNeed(shipments);
    const nodes = (await this.nodes(order, [...need.keys()])).filter((n) => n.routable);
    const currentIds = new Set(
      shipments.filter((s) => IN_WAREHOUSE.includes(s.status)).map((s) => s.warehouseId),
    );
    const far = Number.MAX_SAFE_INTEGER;
    const left = new Map(need);
    const legs: { warehouseId: string; lines: Qty[] }[] = [];
    const take = (n: (typeof nodes)[number]) => {
      const lines: Qty[] = [];
      for (const [variantId, q] of left) {
        const can = Math.min(q, n.available.get(variantId) ?? 0);
        if (can <= 0) continue;
        lines.push({ variantId, qty: can });
        left.set(variantId, q - can);
      }
      if (lines.length > 0) legs.push({ warehouseId: n.warehouseId, lines });
    };
    if (strategy === 'FEWEST_SPLITS') {
      const pool = [...nodes];
      while (pool.length > 0 && [...left.values()].some((q) => q > 0)) {
        pool.sort(
          (a, b) =>
            cover(b, left) - cover(a, left) || (a.distanceKm ?? far) - (b.distanceKm ?? far),
        );
        const best = pool.shift();
        if (best === undefined || cover(best, left) === 0) break;
        take(best);
      }
    } else {
      // LEAST_COST: no transfer first (current node), then the least tonne-km (nearest).
      const ordered = [...nodes].sort(
        (a, b) =>
          (strategy === 'LEAST_COST'
            ? Number(!currentIds.has(a.warehouseId)) - Number(!currentIds.has(b.warehouseId))
            : 0) || (a.distanceKm ?? far) - (b.distanceKm ?? far),
      );
      for (const n of ordered) take(n);
    }
    const weights = await this.weights([...need.keys()]);
    const slots = new Map(
      await Promise.all(
        legs.map(
          async (l) =>
            [l.warehouseId, (await this.slots(caller, l.warehouseId, 3))[0] ?? null] as const,
        ),
      ),
    );
    return {
      orderId,
      strategy,
      costBasis: strategy === 'LEAST_COST' ? 'TONNE_KM' : null,
      legs: legs.map((l) => {
        const n = nodes.find((x) => x.warehouseId === l.warehouseId);
        const kg = l.lines.reduce((s, x) => s + (weights.get(x.variantId) ?? 0) * x.qty, 0);
        return {
          warehouseId: l.warehouseId,
          code: n?.code ?? null,
          name: n?.name ?? null,
          isCurrent: currentIds.has(l.warehouseId),
          lines: l.lines,
          units: l.lines.reduce((s, x) => s + x.qty, 0),
          weightKg: Math.round(kg * 10) / 10,
          distanceKm: n?.distanceKm ?? null,
          tonneKm: n?.distanceKm == null ? null : Math.round((kg / 1000) * n.distanceKm * 10) / 10,
          dispatchSlot: slots.get(l.warehouseId) ?? null,
          fleetSuggestion: { vehicleClass: fleetFor(kg) },
        };
      }),
      backorder: [...left].filter(([, q]) => q > 0).map(([variantId, qty]) => ({ variantId, qty })),
    };
  }

  /** Summary, freight policy, customer notice and SOP checks of a plan (no change). */
  async preview(
    caller: Caller,
    orderId: string,
    input: { legs: LegInput[]; backorders: BackorderInput[]; consentLogged?: boolean },
  ) {
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    const need = this.openNeed(shipments);
    const nodes = await this.nodes(order, [...need.keys()]);
    const current = new Set(
      shipments.filter((s) => IN_WAREHOUSE.includes(s.status)).map((s) => s.warehouseId),
    );
    const planned = new Map<string, number>();
    for (const l of [...input.legs.flatMap((x) => x.lines), ...input.backorders])
      planned.set(l.variantId, (planned.get(l.variantId) ?? 0) + l.qty);
    const overStock = input.legs.flatMap((leg) =>
      leg.lines
        .filter((l) => {
          const n = nodes.find((x) => x.warehouseId === leg.warehouseId);
          return (n?.available.get(l.variantId) ?? 0) < l.qty && !current.has(leg.warehouseId);
        })
        .map((l) => `${leg.warehouseId}:${l.variantId}`),
    );
    const notCovered = input.legs
      .filter((l) => !nodes.some((n) => n.warehouseId === l.warehouseId && n.routable))
      .map((l) => l.warehouseId);
    const cold = order.lines.filter((l) => l.temperatureClass?.startsWith('CC') === true);
    const coldBad = input.legs.filter(
      (leg) =>
        leg.lines.some((l) => cold.some((c) => c.variantId === l.variantId)) &&
        !(nodes.find((n) => n.warehouseId === leg.warehouseId)?.coldChain ?? false),
    );
    const maxLegs = 3;
    const checks = [
      {
        key: 'QTY_MATCH',
        label: 'Legs + backorders equal the open quantity of every item',
        pass:
          [...need].every(([v, q]) => (planned.get(v) ?? 0) === q) &&
          [...planned.keys()].every((v) => need.has(v)),
      },
      {
        key: 'COVERAGE',
        label: 'Every leg node serves the delivery PIN and is routable',
        pass: notCovered.length === 0,
        detail: notCovered,
      },
      {
        key: 'STOCK',
        label: 'Moved legs fit the stock at their node',
        pass: overStock.length === 0,
        detail: overStock,
      },
      {
        key: 'COLD_CHAIN',
        label: 'Cold-chain items ship only from a cold-chain node',
        pass: coldBad.length === 0,
      },
      {
        key: 'MAX_LEGS',
        label: `At most ${String(maxLegs)} delivery legs`,
        pass: input.legs.length <= maxLegs,
      },
      {
        key: 'CONSENT',
        label: 'Customer consent logged for backordered units',
        pass: input.backorders.length === 0 || input.consentLogged === true,
      },
    ];
    const units = (ls: Qty[]) => ls.reduce((n, l) => n + l.qty, 0);
    const legsText = input.legs
      .map((l, i) => {
        const n = nodes.find((x) => x.warehouseId === l.warehouseId);
        return `delivery ${String(i + 1)}: ${String(units(l.lines))} unit(s) from ${n?.name ?? 'a FarmX warehouse'}${l.plannedAt == null ? '' : ` (planned ${l.plannedAt.slice(0, 10)})`}`;
      })
      .join('; ');
    const bo = units(input.backorders);
    const promise = input.backorders
      .map((b) => b.promiseDate ?? null)
      .filter((d): d is string => d !== null)
      .sort()
      .at(-1);
    return {
      orderId,
      summary: {
        legs: input.legs.length,
        units: units(input.legs.flatMap((l) => l.lines)),
        backorderUnits: bo,
        moved: input.legs.filter((l) => !current.has(l.warehouseId)).length,
      },
      freightPolicy:
        'Prepaid order: FarmX absorbs the extra freight of split deliveries; the customer pays nothing more.',
      customerNotice: `Your order ${order.orderNo} will arrive in ${String(input.legs.length)} deliver${input.legs.length === 1 ? 'y' : 'ies'} — ${legsText}.${bo > 0 ? ` ${String(bo)} unit(s) are backordered${promise === undefined ? '' : ` and expected by ${promise}`}.` : ''}`,
      checks,
      ok: checks.every((c) => c.pass),
    };
  }

  /** Save & Execute: backorders now, then one reallocation saga per moved leg. */
  async execute(
    caller: Caller,
    orderId: string,
    input: {
      legs: LegInput[];
      backorders: BackorderInput[];
      consentLogged?: boolean;
      notifyCustomer: boolean;
      reason: string;
    },
  ) {
    requireReallocate(caller);
    const p = await this.preview(caller, orderId, input);
    if (!p.ok)
      throw invalid('The split plan fails its checks', 'SPLIT_CHECKS_FAILED', {
        failed: p.checks.filter((c) => !c.pass).map((c) => c.key),
      });
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    if (input.backorders.length > 0)
      await this.deps.runInTransaction(async (tx) => {
        await this.backorderInTx(tx, caller, order, input.backorders, true, input.reason);
      });
    const current = new Set(
      shipments.filter((s) => IN_WAREHOUSE.includes(s.status)).map((s) => s.warehouseId),
    );
    const legs: { index: number; warehouseId: string; status: string; reallocation: unknown }[] =
      [];
    let blocked = false;
    for (const [i, leg] of input.legs.entries()) {
      if (current.has(leg.warehouseId)) {
        legs.push({ index: i, warehouseId: leg.warehouseId, status: 'KEPT', reallocation: null });
        continue;
      }
      if (blocked) {
        legs.push({
          index: i,
          warehouseId: leg.warehouseId,
          status: 'NOT_STARTED',
          reallocation: null,
        });
        continue;
      }
      const r = await this.deps.fulfilmentOrders.allocate(caller, orderId, {
        warehouseId: leg.warehouseId,
        lines: leg.lines,
        reason: `Split: ${input.reason}`,
      });
      const status = (r as { status?: string }).status ?? 'PENDING';
      legs.push({ index: i, warehouseId: leg.warehouseId, status, reallocation: r });
      if (status !== 'COMPLETED') blocked = true;
    }
    await this.deps.runInTransaction(async (tx) => {
      if (input.notifyCustomer)
        await emitWarehouseEvent(
          tx,
          WAREHOUSE_EVENTS.shipmentSplitPlanned,
          {
            orderId,
            orderNo: order.orderNo,
            legs: input.legs.map((l) => ({
              warehouseId: l.warehouseId,
              qty: l.lines.reduce((n, x) => n + x.qty, 0),
              plannedAt: l.plannedAt ?? null,
            })),
            backorders: input.backorders.map((b) => ({
              variantId: b.variantId,
              qty: b.qty,
              promiseDate: b.promiseDate ?? null,
            })),
          },
          caller.requestId,
        );
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'order.split',
        targetType: 'order',
        targetId: orderId,
        after: {
          legs: input.legs,
          backorders: input.backorders,
          result: legs.map((l) => l.status),
        },
        reason: input.reason,
      });
    });
    return {
      orderId,
      legs,
      backorders: (await this.deps.backordersRepository.ofOrder(orderId)).map((b) =>
        this.backorderView(b),
      ),
      customerNotified: input.notifyCustomer,
      customerNotice: p.customerNotice,
      next: blocked
        ? 'A leg is still moving (reallocation pending): re-run the remaining legs once it completes.'
        : null,
    };
  }

  /** Cancel & re-route: the whole open order to another node (one saga). */
  async reroute(caller: Caller, orderId: string, input: { warehouseId: string; reason: string }) {
    requireReallocate(caller);
    return this.deps.fulfilmentOrders.allocate(caller, orderId, {
      warehouseId: input.warehouseId,
      reason: `Re-route: ${input.reason}`,
    });
  }

  /**
   * Partial fulfilment: ship `shipQty` now; the rest is backordered (keeps its reservation) or
   * cancelled through order-service (refund + reservation release). Before picking only.
   */
  async partial(
    caller: Caller,
    orderId: string,
    input: {
      shipmentId: string;
      lines: { variantId: string; shipQty: number }[];
      remainder: 'BACKORDER' | 'CANCEL';
      promiseDate?: string | null;
      consentLogged?: boolean;
      reason: string;
    },
  ) {
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    const s = shipments.find((x) => x.id === input.shipmentId);
    if (s === undefined) throw new NotFoundError('Shipment');
    caller.access.require('fulfilment.manage', s.warehouseId);
    if (!PRE_PICK.includes(s.status))
      throw new ConflictError('Only a shipment that is not being picked can be shipped partly', {
        details: { reason: 'NOT_EDITABLE_AFTER_PICK' },
      });
    const short: Qty[] = [];
    for (const l of input.lines) {
      const line = s.lines.find((x) => x.variantId === l.variantId);
      if (line === undefined)
        throw invalid(`${l.variantId} is not on the shipment`, 'INVALID_LINES');
      const active = line.qty - line.cancelledQty;
      if (l.shipQty > active)
        throw invalid(`Cannot ship more than ${String(active)} of an item`, 'INVALID_LINES');
      if (active - l.shipQty > 0) short.push({ variantId: l.variantId, qty: active - l.shipQty });
    }
    if (short.length === 0) throw invalid('Nothing is short', 'NOTHING_SHORT');
    if (input.remainder === 'BACKORDER') {
      if (input.consentLogged !== true)
        throw invalid('Log the customer consent before backordering', 'CONSENT_REQUIRED');
      await this.deps.runInTransaction(async (tx) => {
        await this.backorderInTx(
          tx,
          caller,
          order,
          short.map((x) => ({ ...x, promiseDate: input.promiseDate ?? null })),
          true,
          input.reason,
          s.id,
        );
      });
    } else {
      // order.cancelled.v1 (partial) comes back and shrinks the shipment line.
      await this.deps.orderClient.cancelLines(orderId, {
        lines: short,
        note: `Partial fulfilment (warehouse short): ${input.reason}`.slice(0, 500),
        by: caller.userId,
      });
      await this.deps.runInTransaction(async (tx) => {
        await this.deps.auditService.record(tx, actorOf(caller), {
          action: 'order.partial_cancel',
          targetType: 'shipment',
          targetId: s.id,
          after: { cancelled: short },
          reason: input.reason,
        });
      });
    }
    return this.context(caller, orderId);
  }

  // ── backorder queue ──

  async backorders(
    caller: Caller,
    f: { status?: BackorderStatus; warehouseId?: string; orderId?: string; variantId?: string },
    p: Paging,
  ) {
    if (f.warehouseId !== undefined) caller.access.require('fulfilment.view', f.warehouseId);
    const scope = caller.access.scope('fulfilment.view');
    const offset = offsetOf(p);
    const rows = await this.deps.backordersRepository.list(scope, f, {
      limit: p.limit,
      offset,
      afterId: offset === null && p.cursor !== undefined ? cursorId(p.cursor) : null,
    });
    const page = toPageResult(rows, p, (r) => [r.id]);
    const [orders, names, variants] = await Promise.all([
      Promise.all([...new Set(page.items.map((b) => b.orderId))].map((id) => this.repo.order(id))),
      this.deps.warehousesService.findMany(
        page.items.flatMap((b) => (b.warehouseId === null ? [] : [b.warehouseId])),
      ),
      this.deps.stockService.variantRows(page.items.map((b) => b.variantId)),
    ]);
    const counts = await this.deps.backordersRepository.counts(scope, f.warehouseId);
    return {
      ...page,
      counts,
      items: page.items.map((b) => {
        const o = orders.find((x) => x?.orderId === b.orderId);
        const w = names.find((x) => x.id === b.warehouseId);
        const v = variants.find((x) => x.variantId === b.variantId);
        return {
          ...this.backorderView(b),
          orderNo: o?.orderNo ?? null,
          customerName: o?.customerName ?? null,
          warehouse: w === undefined ? null : { id: w.id, code: w.code, name: w.name },
          sku: v?.sku ?? null,
          name: v?.name ?? null,
          overdue:
            b.status === 'OPEN' &&
            b.promiseDate !== null &&
            b.promiseDate < new Date(istDay(new Date())),
        };
      }),
    };
  }

  async patchBackorder(
    caller: Caller,
    id: string,
    input: { promiseDate?: string | null; note?: string | null; expectedVersion: number },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const b = await this.deps.backordersRepository.lock(tx, id);
      if (b === null) throw new NotFoundError('Backorder');
      if (b.warehouseId !== null) caller.access.require('fulfilment.manage', b.warehouseId);
      if (b.version !== input.expectedVersion)
        throw new ConflictError('The backorder changed', {
          details: { reason: 'VERSION_CONFLICT' },
        });
      if (b.status !== 'OPEN')
        throw new ConflictError('Only an open backorder can change', {
          details: { reason: 'NOT_OPEN' },
        });
      await this.deps.backordersRepository.update(tx, id, {
        ...(input.promiseDate === undefined
          ? {}
          : { promiseDate: input.promiseDate === null ? null : new Date(input.promiseDate) }),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'backorder.update',
        targetType: 'backorder',
        targetId: id,
        before: { promiseDate: b.promiseDate, note: b.note },
        after: { promiseDate: input.promiseDate, note: input.note },
      });
    });
    const b = await this.deps.backordersRepository.get(id);
    return b === null ? null : this.backorderView(b);
  }

  /** Cancel a backorder: its units are cancelled + refunded through order-service. */
  async cancelBackorder(caller: Caller, id: string, input: { reason: string }) {
    const b = await this.deps.backordersRepository.get(id);
    if (b === null) throw new NotFoundError('Backorder');
    if (b.warehouseId !== null) caller.access.require('fulfilment.manage', b.warehouseId);
    if (b.status !== 'OPEN')
      throw new ConflictError('Only an open backorder can be cancelled', {
        details: { reason: 'NOT_OPEN' },
      });
    await this.deps.runInTransaction(async (tx) => {
      const locked = await this.deps.backordersRepository.lock(tx, id);
      if (locked?.status !== 'OPEN')
        throw new ConflictError('The backorder changed', { details: { reason: 'NOT_OPEN' } });
      await this.deps.backordersRepository.update(tx, id, {
        status: 'CANCELLED',
        cancelledAt: new Date(),
        note: input.reason.slice(0, 300),
      });
      if (locked.shipmentId !== null)
        await this.shiftBackordered(tx, locked.shipmentId, b.variantId, -b.qty);
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'backorder.cancel',
        targetType: 'backorder',
        targetId: id,
        after: { qty: b.qty },
        reason: input.reason,
      });
    });
    // The units were never shipped: the order cancels them (refund + reservation release).
    await this.deps.orderClient.cancelLines(b.orderId, {
      lines: [{ variantId: b.variantId, qty: b.qty }],
      note: `Backorder cancelled: ${input.reason}`.slice(0, 500),
      by: caller.userId,
    });
    const after = await this.deps.backordersRepository.get(id);
    return after === null ? null : this.backorderView(after);
  }

  /**
   * Backorder allocator (job, every 5 min): OPEN rows by promise date. When the node holds the
   * units, they go back onto its open shipment (before picking) or a follow-up shipment.
   */
  async allocateBackorders(limit = 100) {
    const due = await this.deps.backordersRepository.due(limit);
    const budget = new Map<string, number>();
    let allocated = 0;
    for (const b of due) {
      const wid = b.warehouseId ?? '';
      const key = `${wid}|${b.variantId}`;
      if (!budget.has(key)) {
        const lv = await this.deps.stockService.levelsFor(wid, [b.variantId]);
        budget.set(key, lv.get(b.variantId)?.available ?? 0);
      }
      if ((budget.get(key) ?? 0) < b.qty) continue;
      try {
        const ok = await this.deps.runInTransaction(async (tx) => {
          const locked = await this.deps.backordersRepository.lock(tx, b.id);
          if (locked?.status !== 'OPEN') return false;
          const order = await this.repo.lockOrder(tx, b.orderId);
          if (order === null || ['CANCELLED', 'REJECTED', 'FAILED'].includes(order.orderStatus))
            return false;
          const shipments = await this.repo.lockOrderShipments(tx, b.orderId);
          const open = shipments.find(
            (s) => s.warehouseId === wid && IN_WAREHOUSE.includes(s.status),
          );
          if (open !== undefined && !PRE_PICK.includes(open.status)) return false; // wait: on the floor
          let target: ShipmentRow;
          if (open === undefined) {
            target = await this.deps.fulfilmentSync.createShipment(tx, order, wid, [
              { variantId: b.variantId, qty: b.qty },
            ]);
            if (order.orderStatus !== 'PENDING_ADMIN_CONFIRMATION')
              await this.deps.fulfilmentSync.release(tx, target, new Date());
          } else {
            target = open;
            const l = open.lines.find((x) => x.variantId === b.variantId);
            if (l === undefined)
              await this.repo.addLine(tx, {
                shipmentId: open.id,
                lineNo: Math.max(0, ...open.lines.map((x) => x.lineNo)) + 1,
                variantId: b.variantId,
                qty: b.qty,
                orderLineNo: order.lines.find((x) => x.variantId === b.variantId)?.lineNo ?? null,
              });
            else await this.repo.updateLine(tx, open.id, l.lineNo, { qty: l.qty + b.qty });
            if (open.status === 'ALLOCATED' || open.status === 'ASSIGNED') {
              await this.repo.cancelTasks(tx, open.id);
              await this.deps.shipmentFlow.move(
                tx,
                open,
                'RELEASED',
                SYSTEM_ACTOR,
                'BACKORDER_ALLOCATED',
                {
                  force: true,
                },
              );
            } else
              await this.deps.shipmentFlow.note(
                tx,
                open,
                'BACKORDER_ALLOCATED',
                SYSTEM_ACTOR,
                null,
              );
          }
          if (locked.shipmentId !== null)
            await this.shiftBackordered(tx, locked.shipmentId, b.variantId, -b.qty);
          await this.deps.backordersRepository.update(tx, b.id, {
            status: 'ALLOCATED',
            allocatedAt: new Date(),
            shipmentId: target.id,
          });
          await this.deps.auditService.record(
            tx,
            { userId: null, ip: null, requestId: null },
            {
              action: 'backorder.allocate',
              targetType: 'backorder',
              targetId: b.id,
              after: { shipmentId: target.id, qty: b.qty },
            },
          );
          return true;
        });
        if (ok) {
          allocated += 1;
          budget.set(key, (budget.get(key) ?? 0) - b.qty);
        }
      } catch (err) {
        this.deps.logger.warn({ err, backorderId: b.id }, 'backorder allocation failed');
      }
    }
    return { checked: due.length, allocated };
  }

  /** Dispatch slots of a node (W3.14 legs, W3.17 slot schedule) from its calendar + dock bookings. */
  async slots(caller: Caller, warehouseId: string, days = 3) {
    const [cal, doors] = await Promise.all([
      this.deps.calendarService.slaCalendar(warehouseId),
      this.deps.docksService.doorsFacts(warehouseId),
    ]);
    const loading = doors.filter((d) => d.status === 'ACTIVE').length;
    const now = new Date();
    const today = istDay(now);
    const out = [];
    for (let i = 0; i < 14 && out.length < days; i += 1) {
      const day = addDays(today, i);
      if (cal.closed.has(day)) continue;
      const h = cal.hours.find((x) => x.isoDay === isoDayOf(day));
      if (h?.isOpen !== true || h.closesAt === null || h.opensAt === null) continue;
      const cutoff = istAt(day, cal.cutoff ?? h.closesAt);
      if (i === 0 && now >= cutoff) continue;
      const booked = (await this.deps.docksService.bookings(caller, warehouseId, day)).filter(
        (b) => b.status !== 'CANCELLED',
      ).length;
      out.push({
        at: i === 0 ? cutoff : istAt(day, h.opensAt),
        day,
        label:
          i === 0
            ? 'Immediate Same-Day'
            : out.length === 0 || i === 1
              ? 'Next-Day Scheduled'
              : `Scheduled ${day}`,
        cutoffAt: cutoff,
        docks: loading,
        bookings: booked,
        confirmed: booked > 0,
      });
    }
    return out;
  }

  /** Corridors map: delivery point, nodes serving it, current legs. */
  async splitMap(caller: Caller, orderId: string) {
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    const nodes = await this.nodes(order, [...this.openNeed(shipments).keys()]);
    return {
      delivery: { lat: num(order.latitude), lng: num(order.longitude), pinCode: order.pinCode },
      corridors: nodes.map((n) => ({
        warehouseId: n.warehouseId,
        code: n.code,
        name: n.name,
        lat: n.lat,
        lng: n.lng,
        distanceKm: n.distanceKm,
        active: shipments.some((s) => s.warehouseId === n.warehouseId && s.status !== 'CANCELLED'),
      })),
    };
  }

  // ── internals ──

  /** Open (not yet dispatched) quantity per SKU across the order's shipments. */
  private openNeed(shipments: readonly ShipmentRow[]) {
    const need = new Map<string, number>();
    for (const s of shipments.filter((x) => IN_WAREHOUSE.includes(x.status)))
      for (const l of s.lines) {
        const q = l.qty - l.cancelledQty - l.dispatchedQty;
        if (q > 0) need.set(l.variantId, (need.get(l.variantId) ?? 0) + q);
      }
    return need;
  }

  /** Nodes serving the order's PIN with their stock of some SKUs. */
  private async nodes(order: OrderRow, variantIds: readonly string[]) {
    if (order.pinCode === null) return [];
    const cover = await this.deps.serviceAreasService.networkCoverage(order.pinCode);
    const whs = await this.deps.warehousesService.findMany(cover.map((c) => c.warehouseId));
    const point = { lat: num(order.latitude), lng: num(order.longitude) };
    return Promise.all(
      cover.map(async (c) => {
        const w = whs.find((x) => x.id === c.warehouseId);
        const lv =
          variantIds.length === 0
            ? new Map()
            : await this.deps.stockService.levelsFor(c.warehouseId, variantIds);
        const lat = num(w?.latitude);
        const lng = num(w?.longitude);
        return {
          warehouseId: c.warehouseId,
          code: c.code,
          name: c.name,
          routable: c.routable,
          coldChain: w?.temperatureClasses.some((t) => t.startsWith('CC')) === true,
          lat,
          lng,
          distanceKm: distanceKm(point, { lat, lng }),
          available: new Map(
            variantIds.map((v) => [
              v,
              (lv.get(v) as { available?: number } | undefined)?.available ?? 0,
            ]),
          ),
        };
      }),
    );
  }

  private async weights(variantIds: readonly string[]) {
    const rows = await this.deps.stockService.variantRows(variantIds);
    return new Map(rows.map((r) => [r.variantId, (r.weightGrams ?? 0) / 1000]));
  }

  /**
   * Takes backordered units off the open shipment line (they keep the inventory reservation) and
   * queues them. `fromShipmentId` limits it to one shipment (partial ship).
   */
  private async backorderInTx(
    tx: Tx,
    caller: Caller,
    order: OrderRow,
    lines: readonly BackorderInput[],
    consent: boolean,
    reason: string,
    fromShipmentId?: string,
  ) {
    const shipments = await this.repo.lockOrderShipments(tx, order.orderId);
    for (const b of lines) {
      const s = shipments.find(
        (x) =>
          (fromShipmentId === undefined || x.id === fromShipmentId) &&
          IN_WAREHOUSE.includes(x.status) &&
          x.lines.some((l) => l.variantId === b.variantId && l.qty - l.cancelledQty >= b.qty),
      );
      if (s === undefined)
        throw invalid(`No open shipment holds ${String(b.qty)} of ${b.variantId}`, 'INVALID_LINES');
      if (!PRE_PICK.includes(s.status))
        throw new ConflictError(`${s.shipmentNo} is being picked`, {
          details: { reason: 'NOT_EDITABLE_AFTER_PICK' },
        });
      const line = s.lines.find((l) => l.variantId === b.variantId);
      if (line === undefined) continue;
      const allocs = (await this.repo.allocations(s.id, tx)).filter(
        (a) => a.lineNo === line.lineNo && a.status === 'ALLOCATED',
      );
      const newQty = line.qty - b.qty;
      if (line.allocatedQty > newQty - line.cancelledQty && allocs.length > 0) {
        await this.deps.shipmentFlow.releaseLots(
          tx,
          s,
          allocs,
          `Backordered (${reason})`,
          flowActor(caller),
        );
        await this.repo.updateLine(tx, s.id, line.lineNo, { allocatedQty: 0 });
        if (s.status === 'ALLOCATED' || s.status === 'ASSIGNED') {
          await this.repo.cancelTasks(tx, s.id);
          await this.deps.shipmentFlow.move(tx, s, 'RELEASED', flowActor(caller), 'BACKORDERED', {
            force: true,
            note: reason,
          });
        }
      }
      await this.repo.updateLine(tx, s.id, line.lineNo, {
        qty: newQty,
        backorderedQty: line.backorderedQty + b.qty,
      });
      if (
        newQty - line.cancelledQty <= 0 &&
        s.lines.every((l) => l.lineNo === line.lineNo || l.qty - l.cancelledQty <= 0)
      )
        await this.deps.shipmentFlow.move(
          tx,
          s,
          'CANCELLED',
          flowActor(caller),
          'FULLY_BACKORDERED',
          {
            force: true,
            note: reason,
          },
        );
      const row = await this.deps.backordersRepository.create(tx, {
        orderId: order.orderId,
        shipmentId: s.id,
        orderLineNo: line.orderLineNo,
        variantId: b.variantId,
        qty: b.qty,
        promiseDate: b.promiseDate == null ? null : new Date(b.promiseDate),
        warehouseId: s.warehouseId,
        consentLogged: consent,
        createdBy: caller.userId,
      });
      await this.deps.auditService.record(tx, actorOf(caller), {
        action: 'backorder.create',
        targetType: 'backorder',
        targetId: row.id,
        after: { orderId: order.orderId, shipmentId: s.id, variantId: b.variantId, qty: b.qty },
        reason,
      });
    }
  }

  private async shiftBackordered(tx: Tx, shipmentId: string, variantId: string, delta: number) {
    const s = await this.repo.lockShipment(tx, shipmentId);
    const l = s?.lines.find((x) => x.variantId === variantId);
    if (s === null || l === undefined) return;
    await this.repo.updateLine(tx, s.id, l.lineNo, {
      backorderedQty: Math.max(0, l.backorderedQty + delta),
    });
  }

  private backorderView(b: BackorderRow) {
    return {
      id: b.id,
      orderId: b.orderId,
      shipmentId: b.shipmentId,
      variantId: b.variantId,
      qty: b.qty,
      promiseDate: b.promiseDate?.toISOString().slice(0, 10) ?? null,
      status: b.status,
      warehouseId: b.warehouseId,
      consentLogged: b.consentLogged,
      note: b.note,
      allocatedAt: b.allocatedAt,
      cancelledAt: b.cancelledAt,
      version: b.version,
      createdAt: b.createdAt,
    };
  }
}

const cover = (n: { available: Map<string, number> }, left: Map<string, number>): number =>
  [...left].reduce((s, [v, q]) => s + Math.min(q, n.available.get(v) ?? 0), 0);

const requireReallocate = (c: Caller) => {
  if (!c.access.isGlobal('fulfilment.reallocate'))
    throw new ForbiddenError('Needs GLOBAL fulfilment.reallocate');
};

const cursorId = (cursor: string): string | null => {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    return Array.isArray(v) ? String(v[0]) : null;
  } catch {
    return null;
  }
};
