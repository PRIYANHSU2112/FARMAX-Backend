import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { Caller } from '../../middleware/guards.js';
import { type Paging, decodeCursor, offsetOf, toPageResult } from '../../middleware/paging.js';
import { type FlowActor, SYSTEM_ACTOR } from './fulfilment.flow.js';
import type { ExceptionRow, OrderRow, ShipmentRow } from './fulfilment.repository.js';
import { IN_WAREHOUSE, PRE_PICK, deliveryEstimate, distanceKm } from './fulfilment.rules.js';

const actorOf = (c: Caller): FlowActor => ({
  type: 'STAFF',
  id: c.userId,
  requestId: c.requestId,
  access: c.access,
});
const num = (d: { toString(): string } | null | undefined) =>
  d === null || d === undefined ? null : Number(d.toString());
const HOLD_REASONS = [
  'CUSTOMER_REQUEST',
  'PAYMENT_ISSUE',
  'COMPLIANCE',
  'QUALITY',
  'OPERATIONS',
  'OTHER',
] as const;
type HoldReason = (typeof HOLD_REASONS)[number];
const HOLD_LABEL: Record<HoldReason, string> = {
  CUSTOMER_REQUEST: 'Customer request',
  PAYMENT_ISSUE: 'Payment issue',
  COMPLIANCE: 'Compliance',
  QUALITY: 'Quality',
  OPERATIONS: 'Operations',
  OTHER: 'Other',
};

/**
 * Fulfilment orders (W3.02 New Orders, W3.03 Order Details, W3.04 Warehouse Allocation, W3.15
 * hold part): the order read model with its shipments, the hold (soft allocations, §2a.6) and the
 * cross-warehouse reallocation saga (§2a.4: local PENDING → inventory → local apply).
 */
export class FulfilmentOrders {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'fulfilmentReadRepository'
      | 'fulfilmentSync'
      | 'shipmentFlow'
      | 'fulfilmentSettings'
      | 'stockService'
      | 'warehousesService'
      | 'serviceAreasService'
      | 'inventoryClient'
      | 'runInTransaction'
      | 'auditService'
      | 'logger'
      | 'fulfilmentExceptions'
      | 'routingService'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  // ── W3.02 ──

  async kpis(caller: Caller, warehouseId?: string) {
    const scope = this.scope(caller, warehouseId);
    const k = await this.deps.fulfilmentReadRepository.orderKpis(scope, warehouseId);
    return {
      newOrders: k.new,
      paid: k.paid,
      pendingPayment: k.pending,
      needsAllocation: k.unassigned,
      activeCount: k.active,
      tabs: [
        { key: 'all', label: 'All Orders', count: k.all },
        { key: 'new', label: 'New', count: k.new },
        { key: 'paid', label: 'Paid', count: k.paid },
        { key: 'pending', label: 'Pending payment', count: k.pending },
        { key: 'unassigned', label: 'Needs allocation', count: k.unassigned },
      ],
      asOf: new Date().toISOString(),
    };
  }

  async list(
    caller: Caller,
    f: {
      tab?: string;
      q?: string;
      payment?: string;
      warehouseId?: string;
      pin?: string;
      from?: string;
      to?: string;
    },
    p: Paging,
  ) {
    const scope = this.scope(caller, f.warehouseId);
    const offset = offsetOf(p);
    const [rows, total] = await Promise.all([
      this.deps.fulfilmentReadRepository.orders(scope, f, {
        limit: p.limit,
        offset,
        after: decodeCursor(p.cursor),
      }),
      offset === null
        ? Promise.resolve(undefined)
        : this.deps.fulfilmentReadRepository.ordersCount(scope, f),
    ]);
    const page = toPageResult(rows, p, (r) => [r.placedAt.toISOString(), r.orderId], total);
    const whs = await this.names(page.items.flatMap((r) => r.warehouseIds));
    const variants = new Map(
      (
        await this.deps.stockService.variantRows(
          page.items.flatMap((r) => (r.firstVariantId === null ? [] : [r.firstVariantId])),
        )
      ).map((v) => [v.variantId, v]),
    );
    return {
      ...page,
      items: page.items.map((r) => {
        const v = r.firstVariantId === null ? undefined : variants.get(r.firstVariantId);
        return {
          orderId: r.orderId,
          orderNo: r.orderNo,
          placedAt: r.placedAt,
          customer: { name: r.customerName, farmName: r.farmName, segment: r.segment },
          pinCode: r.pinCode,
          district: r.district,
          product: {
            name: v?.name ?? r.firstName,
            imageUrl: v?.imageUrl ?? null,
            packLabel: v?.packLabel ?? null,
            moreCount: Math.max(0, r.itemCount - 1),
          },
          quantityLabel:
            r.itemCount === 1 && v?.packLabel != null
              ? `${String(r.unitCount)} × ${v.packLabel}`
              : `${String(r.unitCount)} units`,
          units: r.unitCount,
          amount: r.grandTotal.toFixed(2),
          paymentStatus: r.paymentStatus,
          orderStatus: r.orderStatus,
          complianceStatus: r.complianceStatus,
          holdActive: r.holdActive,
          warehouses: r.warehouseIds.map((id) => whs.get(id) ?? { id, code: null, name: null }),
          shipmentStatuses: r.shipmentStatuses,
          needsAllocation: r.needsAllocation,
        };
      }),
    };
  }

  async filterOptions(caller: Caller, field: 'pin' | 'customer', q: string | undefined) {
    const scope = caller.access.scope('fulfilment.view');
    return this.deps.fulfilmentReadRepository.orderFilterOptions(scope, field, q);
  }

  // ── W3.03 ──

  async detail(caller: Caller, orderId: string) {
    const { order, shipments } = await this.visible(caller, orderId);
    const hold = await this.repo.openHold(orderId);
    const whs = await this.names(shipments.map((s) => s.warehouseId));
    const anyPicked = shipments.some(
      (s) => !PRE_PICK.includes(s.status) && s.status !== 'CANCELLED',
    );
    const live = shipments.filter((s) => s.status !== 'CANCELLED');
    return {
      orderId: order.orderId,
      orderNo: order.orderNo,
      channel: order.channel,
      placedAt: order.placedAt,
      paidAt: order.paidAt,
      confirmedAt: order.confirmedAt,
      orderStatus: order.orderStatus,
      paymentStatus: order.paymentStatus,
      payment: {
        method: order.paymentMethod,
        instrument: order.paymentInstrument,
        refMasked: order.paymentRefMasked,
        label:
          order.paymentInstrument === null
            ? null
            : `${order.paymentInstrument.toUpperCase()} · Paid in advance`,
      },
      refundStatus: order.refundStatus,
      customerPoRef: order.customerPoRef,
      complianceStatus: order.complianceStatus,
      expectedDelivery:
        order.promisedBy ??
        live
          .map((s) => s.slaDueAt)
          .filter((d): d is Date => d !== null)
          .sort((a, b) => b.getTime() - a.getTime())[0] ??
        null,
      totals: order.totals ?? { grandTotal: order.grandTotal.toFixed(2) },
      hold:
        hold === null
          ? null
          : {
              reasonCode: hold.reasonCode,
              reasonLabel: HOLD_LABEL[hold.reasonCode],
              placedAt: hold.placedAt,
              autoReleaseAt: hold.autoReleaseAt,
            },
      shipments: shipments.map((s) => ({
        id: s.id,
        shipmentNo: s.shipmentNo,
        warehouse: whs.get(s.warehouseId) ?? { id: s.warehouseId, code: null, name: null },
        status: s.status,
        priority: s.priority,
        slaDueAt: s.slaDueAt,
        units: s.lines.reduce((n, l) => n + l.qty - l.cancelledQty, 0),
        allocated: s.lines.reduce((n, l) => n + l.allocatedQty, 0),
      })),
      actions: {
        allocate:
          live.some((s) => s.status === 'RELEASED' || s.status === 'ALLOCATED') && hold === null,
        hold: hold === null && live.some((s) => IN_WAREHOUSE.includes(s.status)),
        releaseHold: hold !== null,
        edit: !anyPicked && live.length > 0,
        cancel: !anyPicked,
      },
      factsLoaded: order.factsLoaded,
      version: order.version,
    };
  }

  async customer(caller: Caller, orderId: string) {
    const { order } = await this.visible(caller, orderId);
    const ship = (order.shipTo ?? {}) as Record<string, unknown>;
    return {
      name: order.customerName,
      phone: order.customerPhone,
      farm: {
        name: order.farmName,
        code: order.farmCode,
        id: order.farmId,
        segment: order.segment,
      },
      address: {
        line1: ship.line1 ?? null,
        line2: ship.line2 ?? null,
        landmark: ship.landmark ?? null,
        village: ship.village ?? null,
        mandal: ship.mandal ?? null,
        district: order.district,
        stateCode: order.stateCode,
        pinCode: order.pinCode,
        formatted: ship.formatted ?? null,
      },
      point:
        order.latitude === null || order.longitude === null
          ? null
          : { lat: num(order.latitude), lng: num(order.longitude) },
      deliveryInstructions: (ship.instructions as string | undefined) ?? null,
    };
  }

  async items(caller: Caller, orderId: string) {
    const { order, shipments } = await this.visible(caller, orderId);
    const variantIds = order.lines.map((l) => l.variantId);
    const variants = new Map(
      (await this.deps.stockService.variantRows(variantIds)).map((v) => [v.variantId, v]),
    );
    const whs = await this.names(shipments.map((s) => s.warehouseId));
    const levels = new Map<string, Map<string, { available: number }>>();
    for (const s of shipments.filter((x) => IN_WAREHOUSE.includes(x.status)))
      levels.set(s.warehouseId, await this.deps.stockService.levelsFor(s.warehouseId, variantIds));
    const lines = order.lines.length > 0 ? order.lines : [];
    return lines.map((l) => {
      const v = variants.get(l.variantId);
      const at = shipments.flatMap((s) =>
        s.lines
          .filter((x) => x.variantId === l.variantId)
          .map((x) => ({
            shipmentId: s.id,
            warehouse: whs.get(s.warehouseId) ?? { id: s.warehouseId, code: null, name: null },
            status: s.status,
            qty: x.qty - x.cancelledQty,
            allocated: x.allocatedQty,
            picked: x.pickedQty,
            atp: levels.get(s.warehouseId)?.get(l.variantId)?.available ?? null,
          })),
      );
      const active = l.qty - l.cancelledQty;
      const allocated = at.reduce((n, x) => n + x.allocated, 0);
      return {
        lineNo: l.lineNo,
        variantId: l.variantId,
        sku: l.sku ?? v?.sku ?? null,
        name: l.name ?? v?.name ?? null,
        unit: v?.packLabel ?? null,
        imageUrl: v?.imageUrl ?? null,
        qty: active,
        cancelledQty: l.cancelledQty,
        unitPrice: l.unitPrice.toFixed(2),
        lineTotal: l.lineTotal.toFixed(2),
        stockStatus:
          allocated >= active
            ? 'ALLOCATED'
            : at.some((x) => (x.atp ?? 0) >= x.qty)
              ? 'IN_STOCK'
              : 'SHORT',
        allocation: at,
      };
    });
  }

  async activity(caller: Caller, orderId: string, cursor: string | undefined, limit: number) {
    await this.visible(caller, orderId);
    const rows = await this.repo.eventsOfOrder(orderId, cursor ?? null, limit);
    const items = rows.slice(0, limit);
    return {
      items: items.map((e) => ({
        id: e.id,
        shipmentId: e.shipmentId,
        from: e.fromStatus,
        to: e.toStatus,
        action: e.action,
        actorType: e.actorType,
        actorId: e.actorId,
        note: e.note,
        at: e.at,
      })),
      nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null,
      limit,
    };
  }

  /** W3.15 audit trail: audit rows of the order, its shipments, tasks and holds. */
  async audit(caller: Caller, orderId: string, cursor: string | undefined, limit: number) {
    const { shipments } = await this.visible(caller, orderId);
    const holds = await this.repo.holds(orderId);
    const tasks = await this.repo.tasksOfShipments(shipments.map((s) => s.id));
    const rows = await this.deps.auditService.forTargets(
      [
        orderId,
        ...shipments.map((s) => s.id),
        ...holds.map((h) => h.id),
        ...tasks.map((t) => t.id),
      ],
      cursor ?? null,
      limit,
    );
    const items = rows.slice(0, limit);
    return { items, nextCursor: rows.length > limit ? (items.at(-1)?.id ?? null) : null, limit };
  }

  // ── hold (W3.03 Hold Order, W3.15 hold parameters) ──

  async holdView(caller: Caller, orderId: string) {
    await this.visible(caller, orderId);
    const [open, history, settings] = await Promise.all([
      this.repo.openHold(orderId),
      this.repo.holds(orderId),
      this.deps.fulfilmentSettings.all(),
    ]);
    return {
      active: open === null ? null : { ...open, reasonLabel: HOLD_LABEL[open.reasonCode] },
      history: history.map((h) => ({ ...h, reasonLabel: HOLD_LABEL[h.reasonCode] })),
      reasons: HOLD_REASONS.map((r) => ({ code: r, label: HOLD_LABEL[r] })),
      parameters: {
        keepAllocationHours: settings['fulfilment.keepAllocationHours'],
        holdReserveCapPct: settings['fulfilment.holdReserveCapPct'],
      },
    };
  }

  /**
   * Puts the order on hold: forward moves stop; allocated (unpicked) lots stay as SOFT allocations
   * until `keepAllocationUntil` (borrowable by short orders), unless the warehouse × SKU soft-held
   * share would pass the cap — then they go back to AVAILABLE at once (§2a.6).
   */
  async hold(
    caller: Caller,
    orderId: string,
    input: {
      reasonCode: HoldReason;
      note?: string | null;
      autoReleaseAt?: string | null;
      keepAllocationHours?: number;
    },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const order = await this.repo.lockOrder(tx, orderId);
      if (order === null) throw new NotFoundError('Order');
      const shipments = (await this.repo.lockOrderShipments(tx, orderId)).filter((s) =>
        IN_WAREHOUSE.includes(s.status),
      );
      if (shipments.length === 0)
        throw new ConflictError('Nothing left in a warehouse to hold', {
          details: { reason: 'NOTHING_TO_HOLD' },
        });
      for (const s of shipments) caller.access.require('fulfilment.manage', s.warehouseId);
      if ((await this.repo.openHold(orderId, tx)) !== null)
        throw new ConflictError('The order is already on hold', {
          details: { reason: 'ALREADY_ON_HOLD' },
        });
      const settings = await this.deps.fulfilmentSettings.all();
      const keepH = Math.min(
        24,
        input.keepAllocationHours ?? settings['fulfilment.keepAllocationHours'],
      );
      const now = new Date();
      const h = await this.repo.createHold(tx, {
        orderId,
        reasonCode: input.reasonCode,
        note: input.note ?? null,
        placedBy: caller.userId,
        autoReleaseAt:
          input.autoReleaseAt === undefined || input.autoReleaseAt === null
            ? null
            : new Date(input.autoReleaseAt),
        keepAllocationUntil: new Date(now.getTime() + keepH * 3_600_000),
      });
      await this.repo.updateOrder(tx, orderId, { holdActive: true });
      const actor = actorOf(caller);
      for (const s of shipments) {
        await this.repo.updateShipment(tx, s.id, { holdActive: true });
        await this.deps.shipmentFlow.note(
          tx,
          s,
          'HOLD_PLACED',
          actor,
          `${HOLD_LABEL[input.reasonCode]}${input.note ? `: ${input.note}` : ''}`,
        );
        if (s.status === 'ALLOCATED' || s.status === 'ASSIGNED') {
          const allocs = (await this.repo.allocations(s.id, tx)).filter(
            (a) => a.status === 'ALLOCATED' && a.pickedQty === 0,
          );
          const overCap = await this.overCap(
            tx,
            s.warehouseId,
            allocs,
            settings['fulfilment.holdReserveCapPct'],
          );
          if (overCap)
            await this.releaseForHold(tx, s, allocs, actor, 'Hold above the soft-allocation cap');
          else await this.repo.markSoft(tx, [s.id], true);
        }
      }
      await this.recordAudit(
        tx,
        caller,
        'order.hold_placed',
        h.id,
        { orderId, reasonCode: input.reasonCode },
        input.note ?? null,
      );
    });
    return this.holdView(caller, orderId);
  }

  /** W3.15 "Override hold expiration" / note. */
  async patchHold(
    caller: Caller,
    orderId: string,
    input: { autoReleaseAt?: string | null; note?: string | null; expectedVersion: number },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const h = await this.repo.openHold(orderId, tx);
      if (h === null) throw new NotFoundError('Hold');
      await this.requireManage(tx, caller, orderId);
      if (h.version !== input.expectedVersion)
        throw new ConflictError('The hold changed', { details: { reason: 'VERSION_CONFLICT' } });
      await this.repo.updateHold(tx, h.id, {
        ...(input.autoReleaseAt === undefined
          ? {}
          : { autoReleaseAt: input.autoReleaseAt === null ? null : new Date(input.autoReleaseAt) }),
        ...(input.note === undefined ? {} : { note: input.note }),
      });
      await this.recordAudit(tx, caller, 'order.hold_updated', h.id, input, input.note ?? null);
    });
    return this.holdView(caller, orderId);
  }

  /** Release to picking: soft lots become firm again; released ones need FEFO again. */
  async releaseHold(caller: Caller | null, orderId: string, input: { note?: string | null }) {
    await this.deps.runInTransaction(async (tx) => {
      const h = await this.repo.openHold(orderId, tx);
      if (h === null)
        throw new ConflictError('The order is not on hold', { details: { reason: 'NOT_ON_HOLD' } });
      if (caller !== null) await this.requireManage(tx, caller, orderId);
      const actor: FlowActor = caller === null ? SYSTEM_ACTOR : actorOf(caller);
      await this.repo.updateHold(tx, h.id, {
        releasedAt: new Date(),
        releasedBy: caller?.userId ?? null,
        releaseNote: input.note ?? null,
      });
      await this.repo.updateOrder(tx, orderId, { holdActive: false });
      const shipments = await this.repo.lockOrderShipments(tx, orderId);
      await this.repo.markSoft(
        tx,
        shipments.map((s) => s.id),
        false,
      );
      for (const s of shipments.filter((x) => IN_WAREHOUSE.includes(x.status))) {
        await this.repo.updateShipment(tx, s.id, { holdActive: false });
        await this.deps.shipmentFlow.note(tx, s, 'HOLD_RELEASED', actor, input.note ?? null);
      }
      if (caller !== null)
        await this.recordAudit(
          tx,
          caller,
          'order.hold_released',
          h.id,
          { orderId },
          input.note ?? null,
        );
    });
    return caller === null ? null : this.holdView(caller, orderId);
  }

  /** hold-allocation-release job: soft lots past `keepAllocationUntil` go back (§2a.6). */
  async expireSoftAllocations(limit = 100) {
    const due = await this.repo.dueKeepAllocation(new Date(), limit);
    let released = 0;
    for (const h of due)
      await this.deps.runInTransaction(async (tx) => {
        const shipments = await this.repo.lockOrderShipments(tx, h.orderId);
        for (const s of shipments) {
          const soft = (await this.repo.allocations(s.id, tx)).filter(
            (a) => a.status === 'ALLOCATED' && a.soft,
          );
          if (soft.length === 0) continue;
          released += await this.releaseForHold(
            tx,
            s,
            soft,
            SYSTEM_ACTOR,
            'Hold kept allocations past the limit',
          );
        }
        await this.repo.updateHold(tx, h.id, { keepAllocationUntil: null });
      });
    return { holds: due.length, released };
  }

  /** hold-auto-release job. */
  async autoRelease(limit = 100) {
    const due = await this.repo.dueAutoRelease(new Date(), limit);
    for (const h of due)
      await this.releaseHold(null, h.orderId, { note: 'Auto-release time reached' });
    return { released: due.length };
  }

  // ── W3.04 allocation ──

  async candidates(caller: Caller, orderId: string) {
    const { order, shipments } = await this.visible(caller, orderId);
    if (order.pinCode === null) return { orderId, pinCode: null, candidates: [] };
    const cover = await this.deps.serviceAreasService.coverage(caller, order.pinCode);
    const whs = new Map(
      (await this.deps.warehousesService.findMany(cover.map((c) => c.warehouseId))).map((w) => [
        w.id,
        w,
      ]),
    );
    const active = order.lines.filter((l) => l.qty - l.cancelledQty > 0);
    const settings = await this.deps.fulfilmentSettings.all();
    const point = { lat: num(order.latitude), lng: num(order.longitude) };
    const assigned = new Set(
      shipments.filter((s) => s.status !== 'CANCELLED').map((s) => s.warehouseId),
    );
    const cold = active.some((l) => l.temperatureClass?.startsWith('CC') === true);
    const out = [];
    for (const c of cover) {
      const w = whs.get(c.warehouseId);
      const levels = await this.deps.stockService.levelsFor(
        c.warehouseId,
        active.map((l) => l.variantId),
      );
      const fit = active.map((l) => ({
        variantId: l.variantId,
        need: l.qty - l.cancelledQty,
        available: levels.get(l.variantId)?.available ?? 0,
      }));
      const full = fit.every((f) => f.available >= f.need);
      const partial = !full && fit.some((f) => f.available > 0);
      const km = distanceKm(point, { lat: num(w?.latitude), lng: num(w?.longitude) });
      const coldOk = w?.temperatureClasses.some((t) => t.startsWith('CC')) === true;
      const score = Math.max(
        0,
        Math.round(
          100 -
            (c.priorityRank - 1) * 10 +
            (full ? 0 : partial ? -25 : -60) -
            (km === null ? 15 : Math.min(30, km / 5)) -
            (cold && !coldOk ? 40 : 0) -
            (c.routable ? 0 : 50),
        ),
      );
      out.push({
        warehouseId: c.warehouseId,
        code: c.code,
        name: c.name,
        type: c.type,
        priorityRank: c.priorityRank,
        routable: c.routable,
        stock: full ? 'ALL' : partial ? 'PARTIAL' : 'NONE',
        lines: fit,
        distanceKm: km,
        estimatedDelivery: deliveryEstimate(
          new Date(),
          2,
          km,
          settings['fulfilment.avgTransitKmph'],
        ),
        deliveryArea: w === undefined ? null : `${w.district ?? w.city} (${w.stateCode})`,
        coldChain: coldOk,
        coldRequired: cold,
        assigned: assigned.has(c.warehouseId),
        score,
      });
    }
    // D-57b W3.12: the routing rules decide the order (same evaluator as checkout); score breaks ties.
    const lines = active.map((l) => ({ variantId: l.variantId, qty: l.qty - l.cancelledQty }));
    const routing = this.deps.routingService;
    const { decision } = await routing.decide(
      await routing.routingOrder(
        {
          pinCode: order.pinCode,
          stateCode: order.stateCode,
          district: order.district,
          value: num(order.grandTotal),
          lat: point.lat,
          lng: point.lng,
        },
        lines,
      ),
      lines,
    );
    const rank = new Map(decision.ordered.map((wid, i) => [wid, i]));
    const step = decision.trace.find((s) => s.ruleId === decision.ruleId);
    const gates = new Map(step?.candidates.map((c) => [c.warehouseId, c.gate]) ?? []);
    const far = Number.MAX_SAFE_INTEGER;
    out.sort(
      (a, b) =>
        (rank.get(a.warehouseId) ?? far) - (rank.get(b.warehouseId) ?? far) || b.score - a.score,
    );
    return {
      orderId,
      pinCode: order.pinCode,
      routing: {
        ruleId: decision.ruleId,
        ruleName: decision.ruleName,
        fallbackUsed: decision.fallbackUsed,
        hold: decision.hold,
        strategy: settings['fulfilment.allocationFallback'].strategy,
      },
      itemsPending:
        active.length -
        shipments
          .flatMap((s) => s.lines)
          .filter((l) => l.allocatedQty >= l.qty - l.cancelledQty && l.qty - l.cancelledQty > 0)
          .length,
      candidates: out.map((c, i) => ({
        rank: i + 1,
        ...c,
        routed: rank.has(c.warehouseId),
        ruleGate: gates.get(c.warehouseId) ?? null,
      })),
    };
  }

  async map(caller: Caller, orderId: string) {
    const { order, shipments } = await this.visible(caller, orderId);
    const cover =
      order.pinCode === null
        ? []
        : await this.deps.serviceAreasService.coverage(caller, order.pinCode);
    const ids = [
      ...new Set([...cover.map((c) => c.warehouseId), ...shipments.map((s) => s.warehouseId)]),
    ];
    const whs = await this.deps.warehousesService.findMany(ids);
    const point = { lat: num(order.latitude), lng: num(order.longitude) };
    return {
      header:
        order.district === null
          ? null
          : `${order.district}${order.stateCode === null ? '' : `, ${order.stateCode}`}`,
      delivery: { ...point, pinCode: order.pinCode, district: order.district },
      nodes: whs.map((w) => ({
        warehouseId: w.id,
        code: w.code,
        name: w.name,
        type: w.type,
        lat: num(w.latitude),
        lng: num(w.longitude),
        inArea: cover.some((c) => c.warehouseId === w.id),
        assigned: shipments.some((s) => s.warehouseId === w.id && s.status !== 'CANCELLED'),
        distanceKm: distanceKm(point, { lat: num(w.latitude), lng: num(w.longitude) }),
      })),
    };
  }

  /**
   * Assign (some) lines to another warehouse — the reallocation saga (§2a.4):
   * 1. local PENDING row + line locks; 2. inventory reallocate (key = id); 3. local apply →
   * COMPLETED. A definitive refusal → FAILED (locks off); a timeout stays PENDING for the
   * recovery job, which retries with the same key (inventory is idempotent).
   */
  async allocate(
    caller: Caller,
    orderId: string,
    input: {
      warehouseId: string;
      reason: string;
      variantIds?: string[];
      lines?: { variantId: string; qty: number }[];
    },
  ) {
    if (!caller.access.isGlobal('fulfilment.reallocate')) throw new ForbiddenError();
    await this.deps.warehousesService.requireVisible(
      caller,
      input.warehouseId,
      'fulfilment.manage',
    );
    const id = uuidv7();
    await this.deps.runInTransaction(async (tx) => {
      const order = await this.repo.lockOrder(tx, orderId);
      if (order === null) throw new NotFoundError('Order');
      if (order.reservationId === null)
        throw new ConflictError('The order has no stock reservation yet', {
          details: { reason: 'NO_RESERVATION' },
        });
      if ((await this.repo.openReallocationOf(orderId, tx)) !== null)
        throw new ConflictError('A reallocation is already running', {
          details: { reason: 'REALLOCATION_PENDING' },
        });
      const shipments = await this.repo.lockOrderShipments(tx, orderId);
      const moves: {
        variantId: string;
        fromWarehouseId: string;
        qty: number;
        shipmentId: string;
        lineNo: number;
      }[] = [];
      for (const s of shipments) {
        if (s.warehouseId === input.warehouseId || !IN_WAREHOUSE.includes(s.status)) continue;
        for (const l of s.lines) {
          const active = l.qty - l.cancelledQty;
          if (active <= 0) continue;
          if (input.variantIds !== undefined && !input.variantIds.includes(l.variantId)) continue;
          const want = input.lines?.find((x) => x.variantId === l.variantId)?.qty ?? active;
          if (input.lines !== undefined && !input.lines.some((x) => x.variantId === l.variantId))
            continue;
          if (!PRE_PICK.includes(s.status))
            throw new ConflictError(`${s.shipmentNo} is being picked; it cannot be reallocated`, {
              details: { reason: 'NOT_EDITABLE_AFTER_PICK' },
            });
          if (l.reallocationId !== null)
            throw new ConflictError('A line is locked', {
              details: { reason: 'REALLOCATION_PENDING' },
            });
          moves.push({
            variantId: l.variantId,
            fromWarehouseId: s.warehouseId,
            qty: Math.min(want, active),
            shipmentId: s.id,
            lineNo: l.lineNo,
          });
        }
      }
      if (moves.length === 0)
        throw new ValidationError([{ path: 'body', message: 'nothing to move to that warehouse' }]);
      await this.repo.createReallocation(tx, {
        id,
        orderId,
        fromWarehouseId: moves[0]?.fromWarehouseId ?? input.warehouseId,
        toWarehouseId: input.warehouseId,
        lines: moves,
        reason: input.reason.slice(0, 500),
        requestedBy: caller.userId,
      });
      for (const m of moves)
        await this.repo.updateLine(tx, m.shipmentId, m.lineNo, { reallocationId: id });
      await this.recordAudit(
        tx,
        caller,
        'order.reallocation_requested',
        id,
        { orderId, to: input.warehouseId, moves },
        input.reason,
      );
    });
    await this.advance(id);
    return this.reallocation(caller, id);
  }

  async reallocation(caller: Caller, id: string) {
    const r = await this.repo.reallocation(id);
    if (r === null) throw new NotFoundError('Reallocation');
    caller.access.require('fulfilment.view', r.toWarehouseId);
    return {
      id: r.id,
      orderId: r.orderId,
      fromWarehouseId: r.fromWarehouseId,
      toWarehouseId: r.toWarehouseId,
      lines: r.lines,
      status: r.status,
      attempts: r.attempts,
      lastError: r.lastError,
      reason: r.reason,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  }

  /** Steps 2–6 of the saga (also the recovery job). Never throws. */
  async advance(id: string): Promise<void> {
    const r = await this.repo.reallocation(id);
    if (r === null || (r.status !== 'PENDING' && r.status !== 'INVENTORY_DONE')) return;
    const order = await this.repo.order(r.orderId);
    const moves = r.lines as unknown as {
      variantId: string;
      fromWarehouseId: string;
      qty: number;
      shipmentId: string;
      lineNo: number;
    }[];
    if (r.status === 'PENDING') {
      if (order?.reservationId == null) return this.fail(id, 'NO_RESERVATION');
      const res = await this.deps.inventoryClient.reallocate(
        order.reservationId,
        id,
        moves.map((m) => ({
          variantId: m.variantId,
          fromWarehouseId: m.fromWarehouseId,
          toWarehouseId: r.toWarehouseId,
          qty: m.qty,
        })),
      );
      if (!res.ok) {
        if (res.definitive) return this.fail(id, `${res.reason}: ${res.message}`);
        await this.repo.updateReallocation(undefined, id, {
          attempts: { increment: 1 },
          lastError: res.message.slice(0, 500),
        });
        return;
      }
      await this.repo.updateReallocation(undefined, id, {
        status: 'INVENTORY_DONE',
        attempts: { increment: 1 },
      });
    }
    try {
      await this.deps.runInTransaction((tx) => this.applyLocal(tx, id));
    } catch (err) {
      this.deps.logger.error({ err, reallocationId: id }, 'reallocation local apply failed');
      const cur = await this.repo.reallocation(id);
      const attempts = (cur?.attempts ?? 0) + 1;
      await this.repo.updateReallocation(undefined, id, {
        attempts,
        lastError: (err instanceof Error ? err.message : 'apply failed').slice(0, 500),
      });
      if (attempts >= 6 && order?.reservationId != null)
        await this.compensate(id, order.reservationId, moves, r.toWarehouseId);
    }
  }

  /** reallocation-recovery job. */
  async recoverReallocations(limit = 50) {
    const due = await this.repo.pendingReallocations(new Date(Date.now() - 30_000), limit);
    for (const r of due) await this.advance(r.id);
    return { checked: due.length };
  }

  /** Phase 5 strategies for a shortage (split, partial ship, backorder). */
  resolveShortage(
    ...args: [Caller, ExceptionRow, 'SPLIT' | 'BACKORDER' | 'PARTIAL_SHIP', Record<string, unknown>]
  ): Promise<Record<string, unknown>> {
    const action = args[2];
    return Promise.reject(
      new ConflictError(`${action} arrives with split / backorder planning`, {
        details: { reason: 'NOT_AVAILABLE' },
      }),
    );
  }

  // ── internals ──

  private async applyLocal(tx: Tx, id: string) {
    const r = await this.repo.lockReallocation(tx, id);
    if (r?.status !== 'INVENTORY_DONE') return;
    const moves = r.lines as unknown as {
      variantId: string;
      fromWarehouseId: string;
      qty: number;
      shipmentId: string;
      lineNo: number;
    }[];
    const order = await this.repo.lockOrder(tx, r.orderId);
    if (order === null) throw new Error('order vanished');
    const shipments = await this.repo.lockOrderShipments(tx, r.orderId);
    const actor = SYSTEM_ACTOR;
    for (const m of moves) {
      const s = shipments.find((x) => x.id === m.shipmentId);
      if (s === undefined) continue;
      const line = s.lines.find((l) => l.lineNo === m.lineNo);
      if (line === undefined) continue;
      const allocs = (await this.repo.allocations(s.id, tx)).filter(
        (a) => a.lineNo === m.lineNo && a.status === 'ALLOCATED',
      );
      await this.deps.shipmentFlow.releaseLots(
        tx,
        s,
        allocs,
        `Reallocated to another warehouse (${id})`,
        actor,
      );
      await this.repo.updateLine(tx, s.id, m.lineNo, {
        qty: line.qty - m.qty,
        allocatedQty: Math.max(0, line.allocatedQty - allocs.reduce((n, a) => n + a.qty, 0)),
        reallocationId: null,
      });
    }
    // Source shipments with nothing left → cancelled; RELEASED again if an allocated line moved.
    for (const s of await this.repo.lockOrderShipments(tx, r.orderId)) {
      if (!moves.some((m) => m.shipmentId === s.id)) continue;
      if (s.lines.every((l) => l.qty - l.cancelledQty <= 0))
        await this.deps.shipmentFlow.move(tx, s, 'CANCELLED', actor, 'REALLOCATED_AWAY', {
          force: true,
          note: r.reason,
        });
      else if (
        (s.status === 'ALLOCATED' || s.status === 'ASSIGNED') &&
        s.lines.some((l) => l.allocatedQty < l.qty - l.cancelledQty)
      ) {
        await this.repo.cancelTasks(tx, s.id);
        await this.deps.shipmentFlow.move(tx, s, 'RELEASED', actor, 'REALLOCATED_PARTLY', {
          force: true,
          note: r.reason,
        });
      }
    }
    // Target shipment: add the lines (new shipment → released at once; order is confirmed).
    const target = (await this.repo.shipmentsOfOrder(r.orderId, tx)).find(
      (s) => s.warehouseId === r.toWarehouseId && IN_WAREHOUSE.includes(s.status),
    );
    const grouped = new Map<string, number>();
    for (const m of moves) grouped.set(m.variantId, (grouped.get(m.variantId) ?? 0) + m.qty);
    if (target === undefined) {
      const s = await this.deps.fulfilmentSync.createShipment(
        tx,
        order,
        r.toWarehouseId,
        [...grouped].map(([variantId, qty]) => ({ variantId, qty })),
      );
      if (order.orderStatus !== 'PENDING_ADMIN_CONFIRMATION')
        await this.deps.fulfilmentSync.release(tx, s, new Date());
    } else {
      for (const [variantId, qty] of grouped) {
        const l = target.lines.find((x) => x.variantId === variantId);
        if (l !== undefined)
          await this.repo.updateLine(tx, target.id, l.lineNo, { qty: l.qty + qty });
        else
          await this.repo.addLine(tx, {
            shipmentId: target.id,
            lineNo: Math.max(0, ...target.lines.map((x) => x.lineNo)) + 1,
            variantId,
            qty,
            orderLineNo: order.lines.find((x) => x.variantId === variantId)?.lineNo ?? null,
          });
      }
      if (target.status === 'ALLOCATED' || target.status === 'ASSIGNED') {
        await this.repo.cancelTasks(tx, target.id);
        await this.deps.shipmentFlow.move(tx, target, 'RELEASED', actor, 'LINES_ADDED', {
          force: true,
          note: r.reason,
        });
      } else await this.deps.shipmentFlow.note(tx, target, 'LINES_ADDED', actor, r.reason);
    }
    await this.repo.updateOrder(tx, r.orderId, { autoAllocated: false });
    await this.repo.updateReallocation(tx, id, { status: 'COMPLETED', lastError: null });
  }

  private async fail(id: string, why: string) {
    await this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.lockReallocation(tx, id);
      if (r === null) return;
      for (const m of r.lines as unknown as { shipmentId: string; lineNo: number }[])
        await this.repo
          .updateLine(tx, m.shipmentId, m.lineNo, { reallocationId: null })
          .catch(() => undefined);
      await this.repo.updateReallocation(tx, id, {
        status: 'FAILED',
        lastError: why.slice(0, 500),
      });
    });
  }

  /** Local apply keeps failing → move the reservation back (key "<id>:revert"), critical alert. */
  private async compensate(
    id: string,
    reservationId: string,
    moves: readonly { variantId: string; fromWarehouseId: string; qty: number }[],
    to: string,
  ) {
    const res = await this.deps.inventoryClient.reallocate(
      reservationId,
      `${id}:revert`,
      moves.map((m) => ({
        variantId: m.variantId,
        fromWarehouseId: to,
        toWarehouseId: m.fromWarehouseId,
        qty: m.qty,
      })),
    );
    if (!res.ok && !res.definitive) return; // retried next run
    await this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.lockReallocation(tx, id);
      if (r === null) return;
      for (const m of r.lines as unknown as { shipmentId: string; lineNo: number }[])
        await this.repo
          .updateLine(tx, m.shipmentId, m.lineNo, { reallocationId: null })
          .catch(() => undefined);
      await this.repo.updateReallocation(tx, id, { status: 'COMPENSATED' });
      await this.deps.fulfilmentExceptions.raise(tx, {
        type: 'ALLOCATION_ISSUE',
        cause: 'OTHER',
        severity: 'CRITICAL',
        warehouseId: to,
        orderId: r.orderId,
        title: 'Reallocation could not be applied and was reversed',
        diagnostic: { reallocationId: id, lastError: r.lastError },
        proposal: { action: 'REALLOCATE' },
        dedupeKey: `realloc:${id}`,
      });
    });
    this.deps.logger.error(
      { reallocationId: id },
      'reallocation compensated (reversed in inventory)',
    );
  }

  private async overCap(
    tx: Tx,
    warehouseId: string,
    allocs: readonly { variantId: string; qty: number }[],
    capPct: number,
  ) {
    const byVariant = new Map<string, number>();
    for (const a of allocs) byVariant.set(a.variantId, (byVariant.get(a.variantId) ?? 0) + a.qty);
    const levels = await this.deps.stockService.levelsFor(warehouseId, [...byVariant.keys()]);
    for (const [variantId, qty] of byVariant) {
      const held = await this.repo.softHeldQty(tx, warehouseId, variantId);
      const sellable = (levels.get(variantId)?.available ?? 0) + held + qty;
      if (sellable > 0 && ((held + qty) / sellable) * 100 > capPct) return true;
    }
    return false;
  }

  private async releaseForHold(
    tx: Tx,
    s: ShipmentRow,
    allocs: Awaited<ReturnType<Cradle['fulfilmentRepository']['allocations']>>,
    actor: FlowActor,
    reason: string,
  ) {
    const n = await this.deps.shipmentFlow.releaseLots(tx, s, allocs, reason, actor);
    for (const l of s.lines)
      await this.repo.updateLine(tx, s.id, l.lineNo, {
        allocatedQty: Math.max(
          0,
          l.allocatedQty -
            allocs.filter((a) => a.lineNo === l.lineNo).reduce((x, a) => x + a.qty, 0),
        ),
      });
    await this.repo.cancelTasks(tx, s.id);
    if (s.status === 'ALLOCATED' || s.status === 'ASSIGNED')
      await this.deps.shipmentFlow.move(tx, s, 'RELEASED', actor, 'HOLD_ALLOCATION_RELEASED', {
        force: true,
        note: reason,
      });
    return n;
  }

  private async requireManage(tx: Tx, caller: Caller, orderId: string) {
    const shipments = await this.repo.shipmentsOfOrder(orderId, tx);
    if (shipments.length === 0) {
      if (caller.access.scope('fulfilment.manage') !== 'ALL') throw new NotFoundError('Order');
      return;
    }
    for (const s of shipments.filter((x) => IN_WAREHOUSE.includes(x.status)))
      caller.access.require('fulfilment.manage', s.warehouseId);
  }

  /** Order + shipments the caller may see (404 outside scope); pulls facts once if missing. */
  async visible(
    caller: Caller,
    orderId: string,
  ): Promise<{ order: OrderRow; shipments: ShipmentRow[] }> {
    let order = await this.repo.order(orderId);
    if (order === null) throw new NotFoundError('Order');
    const shipments = await this.repo.shipmentsOfOrder(orderId);
    const scope = caller.access.scope('fulfilment.view');
    if (scope !== 'ALL' && !shipments.some((s) => scope.includes(s.warehouseId)))
      throw new NotFoundError('Order');
    if (!order.factsLoaded && (await this.deps.fulfilmentSync.loadFacts(orderId)))
      order = (await this.repo.order(orderId)) ?? order;
    return { order, shipments };
  }

  private scope(caller: Caller, warehouseId?: string) {
    if (warehouseId !== undefined) caller.access.require('fulfilment.view', warehouseId);
    return caller.access.scope('fulfilment.view');
  }

  private async names(ids: readonly string[]) {
    const rows = await this.deps.warehousesService.findMany([...new Set(ids)]);
    return new Map(rows.map((w) => [w.id, { id: w.id, code: w.code, name: w.name }]));
  }

  private async recordAudit(
    tx: Tx,
    caller: Caller,
    action: string,
    id: string,
    after: unknown,
    reason: string | null = null,
  ) {
    await this.deps.auditService.record(
      tx,
      { userId: caller.userId, ip: caller.ip, requestId: caller.requestId },
      {
        action,
        targetType: action.startsWith('order.hold') ? 'hold' : 'order',
        targetId: id,
        after: after as Record<string, unknown>,
        reason,
      },
    );
  }
}
