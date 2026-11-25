import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import type { StockMove } from '../stock/index.js';
import type { FlowActor } from './fulfilment.flow.js';
import type { OrderRow, ShipmentRow } from './fulfilment.repository.js';
import { daysLeft, istDay, pickShelfLifeRule } from './fulfilment.rules.js';

type Lot = Awaited<ReturnType<Cradle['stockService']['lotsFor']>>[number];

export interface LotView {
  positionId: string;
  batchId: string;
  batchNo: string;
  expiryDate: string | null;
  mfgDate: string | null;
  daysLeft: number | null;
  expiryRisk: boolean;
  bin: { id: string; code: string | null; zone: string | null; rack: string | null } | null;
  ownerType: string;
  available: number;
  certificateStatus: string;
  isOpening: boolean;
  eligible: boolean;
  ineligibleReason: string | null;
  recommended: boolean;
  proposedQty: number;
}

const ymd = (d: Date | null) => (d === null ? null : d.toISOString().slice(0, 10));
const actorOf = (c: Caller): FlowActor => ({
  type: 'STAFF',
  id: c.userId,
  requestId: c.requestId,
  access: c.access,
});

/**
 * FEFO stock allocation (W3.05) + pick list (W3.06). Lots are ranked first-expiry-first-out
 * (null expiry last); a lot is eligible when binned, unexpired and above the minimum remaining
 * shelf life (most specific rule). Reserving moves AVAILABLE → RESERVED on the exact lot; a
 * non-recommended lot needs `fulfilment.fefo_override` + a reason. Held orders' allocations are
 * borrowed (oldest hold first) when the stock is short (§2a.6).
 */
export class FulfilmentFefo {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'shipmentFlow'
      | 'stockService'
      | 'stockSettings'
      | 'storageService'
      | 'fulfilmentSettings'
      | 'runInTransaction'
      | 'auditService'
      | 'warehousesService'
      | 'fulfilmentExceptions'
      | 'fulfilmentSync'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  // ── reads ──

  async header(caller: Caller, shipmentId: string) {
    const { s, order } = await this.visible(caller, shipmentId);
    const [wh] = await this.deps.warehousesService.findMany([s.warehouseId]);
    const active = s.lines.reduce((n, l) => n + l.qty - l.cancelledQty, 0);
    const allocated = s.lines.reduce((n, l) => n + l.allocatedQty, 0);
    return {
      id: s.id,
      shipmentNo: s.shipmentNo,
      status: s.status,
      priority: s.priority,
      deliveryType: s.deliveryType,
      isBulk: s.isBulk,
      holdActive: s.holdActive,
      atRisk: s.atRisk,
      coldRequired: s.coldRequired,
      slaDueAt: s.slaDueAt,
      order: {
        orderId: order.orderId,
        orderNo: order.orderNo,
        placedAt: order.placedAt,
        customerName: order.customerName,
        farmName: order.farmName,
        customerPoRef: order.customerPoRef,
        pinCode: order.pinCode,
        district: order.district,
        complianceStatus: order.complianceStatus,
      },
      fulfilFrom: wh === undefined ? null : { id: wh.id, code: wh.code, name: wh.name },
      totals: {
        lines: s.lines.length,
        units: active,
        allocated,
        toAllocate: Math.max(0, active - allocated),
        weightKg: Number(s.weightKg.toFixed(3)),
        value: s.value.toFixed(2),
      },
      mode: 'FEFO',
      defaultDeadlineAt: s.slaDueAt,
      version: s.version,
    };
  }

  async lines(caller: Caller, shipmentId: string) {
    const { s } = await this.visible(caller, shipmentId);
    const variants = new Map(
      (await this.deps.stockService.variantRows(s.lines.map((l) => l.variantId))).map((v) => [
        v.variantId,
        v,
      ]),
    );
    return s.lines.map((l) => {
      const v = variants.get(l.variantId);
      const ordered = l.qty - l.cancelledQty;
      return {
        lineNo: l.lineNo,
        variantId: l.variantId,
        sku: v?.sku ?? null,
        name: v?.name ?? null,
        packLabel: v?.packLabel ?? null,
        imageUrl: v?.imageUrl ?? null,
        temperatureClass: v?.temperatureClass ?? null,
        ordered,
        allocated: l.allocatedQty,
        picked: l.pickedQty,
        packed: l.packedQty,
        progressLabel: `${String(l.allocatedQty)}/${String(ordered)}`,
        state: l.allocatedQty >= ordered ? 'ALLOCATED' : l.allocatedQty > 0 ? 'PARTIAL' : 'PENDING',
        locked: l.reallocationId !== null,
      };
    });
  }

  async lots(
    caller: Caller,
    shipmentId: string,
    lineNo: number,
    q: { recommendedOnly?: boolean; sort?: 'fefo' | 'available' | 'bin' },
  ) {
    const { s, order } = await this.visible(caller, shipmentId);
    const line = s.lines.find((l) => l.lineNo === lineNo);
    if (line === undefined) throw new NotFoundError('Shipment line');
    const need = Math.max(0, line.qty - line.cancelledQty - line.allocatedQty);
    let rows = await this.rank(s, order, line.variantId, need);
    if (q.recommendedOnly === true) rows = rows.filter((r) => r.recommended);
    if (q.sort === 'available') rows = [...rows].sort((a, b) => b.available - a.available);
    if (q.sort === 'bin')
      rows = [...rows].sort((a, b) => (a.bin?.code ?? '~').localeCompare(b.bin?.code ?? '~'));
    const minDays = await this.minDays(order, line.variantId);
    return {
      lineNo,
      variantId: line.variantId,
      ordered: line.qty - line.cancelledQty,
      allocated: line.allocatedQty,
      remaining: need,
      minShelfLifeDays: minDays.days,
      shelfLifeRule: minDays.rule,
      lots: rows,
    };
  }

  async allocationSummary(caller: Caller, shipmentId: string) {
    const { s } = await this.visible(caller, shipmentId);
    const rows = (await this.repo.allocations(s.id)).filter((a) => a.status !== 'RELEASED');
    const view = await this.allocationViews(s, rows);
    const ordered = s.lines.reduce((n, l) => n + l.qty - l.cancelledQty, 0);
    const allocated = s.lines.reduce((n, l) => n + l.allocatedQty, 0);
    return {
      shipmentId: s.id,
      status: s.status,
      ordered,
      allocated,
      remaining: Math.max(0, ordered - allocated),
      complete: allocated >= ordered && ordered > 0,
      fefoCompliant: rows.every((a) => a.isFefo),
      overrides: rows.filter((a) => !a.isFefo).length,
      lines: s.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        ordered: l.qty - l.cancelledQty,
        allocated: l.allocatedQty,
        lots: view.filter((a) => a.lineNo === l.lineNo),
      })),
    };
  }

  /** W3.06 "Products & bin allocation (FEFO)": the pick list. */
  async allocations(caller: Caller, shipmentId: string) {
    const { s } = await this.visible(caller, shipmentId);
    const rows = (await this.repo.allocations(s.id)).filter((a) => a.status !== 'RELEASED');
    return this.allocationViews(s, rows);
  }

  // ── commands ──

  /**
   * Reserve stock (auto FEFO when a line has no `picks`). Lines already allocated are skipped.
   * Short lines borrow from held orders, then raise a SHORTAGE exception (UNBINNED_STOCK when only
   * unbinned opening stock would cover it). The shipment becomes ALLOCATED once every line is.
   */
  async reserve(
    caller: Caller | null,
    shipmentId: string,
    input: {
      lines?: {
        lineNo: number;
        picks?: { positionId: string; qty: number; overrideReason?: string }[];
      }[];
    },
  ) {
    const actor: FlowActor = caller === null ? { type: 'SYSTEM', id: null } : actorOf(caller);
    // Shelf-life rules need the delivery state: pull the order facts first (outside the tx).
    const pre = await this.repo.shipment(shipmentId);
    if (pre !== null) {
      const o = await this.repo.order(pre.orderId);
      if (o !== null && !o.factsLoaded) await this.deps.fulfilmentSync.loadFacts(o.orderId);
    }
    const result = await this.deps.runInTransaction(async (tx) => {
      const s = await this.lockFor(tx, caller, shipmentId, 'fulfilment.manage');
      const order = await this.repo.order(s.orderId, tx);
      if (order === null) throw new NotFoundError('Order');
      if (!['RELEASED', 'ALLOCATED', 'ASSIGNED'].includes(s.status))
        throw new ConflictError(`A ${s.status} shipment cannot be allocated`, {
          details: { reason: 'INVALID_STATE', status: s.status },
        });
      if (s.holdActive)
        throw new ConflictError('The order is on hold', { details: { reason: 'ON_HOLD' } });
      if (!['APPROVED', 'NOT_REQUIRED'].includes(order.complianceStatus))
        throw new ConflictError('Compliance check is not approved yet', {
          details: { reason: 'COMPLIANCE_PENDING', complianceStatus: order.complianceStatus },
        });
      const moves: StockMove[] = [];
      const rows: Parameters<Cradle['fulfilmentRepository']['createAllocations']>[1] = [];
      const short: { lineNo: number; variantId: string; short: number; reason: string }[] = [];
      const wanted: {
        lineNo: number;
        picks?: { positionId: string; qty: number; overrideReason?: string }[];
      }[] = input.lines ?? s.lines.map((l) => ({ lineNo: l.lineNo }));
      for (const w of wanted) {
        const line = s.lines.find((l) => l.lineNo === w.lineNo);
        if (line === undefined)
          throw new ValidationError([
            { path: 'body.lines', message: `line ${String(w.lineNo)} is not on this shipment` },
          ]);
        if (line.reallocationId !== null)
          throw new ConflictError('The line is being reallocated', {
            details: { reason: 'REALLOCATION_PENDING' },
          });
        let need = line.qty - line.cancelledQty - line.allocatedQty;
        if (need <= 0) continue;
        const lots = await this.rank(s, order, line.variantId, need);
        const picks =
          w.picks !== undefined && w.picks.length > 0
            ? this.checkPicks(caller, s, lots, w.picks, need)
            : lots
                .filter((l) => l.proposedQty > 0)
                .map((l) => ({
                  positionId: l.positionId,
                  qty: l.proposedQty,
                  overrideReason: undefined,
                }));
        for (const p of picks) {
          const lot = lots.find((l) => l.positionId === p.positionId);
          if (lot === undefined) continue;
          moves.push({
            type: 'ALLOCATE',
            from: 'AVAILABLE',
            to: 'RESERVED',
            qty: p.qty,
            source: { id: p.positionId },
            shipmentId: s.id,
          });
          rows.push({
            shipmentId: s.id,
            lineNo: line.lineNo,
            warehouseId: s.warehouseId,
            variantId: line.variantId,
            positionId: p.positionId,
            batchId: lot.batchId,
            binId: lot.bin?.id ?? null,
            qty: p.qty,
            isFefo: lot.recommended,
            overrideReason: p.overrideReason ?? null,
            allocatedBy: caller?.userId ?? null,
          });
          need -= p.qty;
        }
        if (need > 0) need -= await this.borrow(tx, s, line.lineNo, line.variantId, need, actor);
        const taken = line.qty - line.cancelledQty - line.allocatedQty - Math.max(need, 0);
        await this.repo.updateLine(tx, s.id, line.lineNo, {
          allocatedQty: line.allocatedQty + taken,
        });
        if (need > 0) {
          const all = await this.deps.stockService.lotsFor(s.warehouseId, [line.variantId]);
          const unbinned = all.filter((l) => l.binId === null).reduce((n, l) => n + l.available, 0);
          short.push({
            lineNo: line.lineNo,
            variantId: line.variantId,
            short: need,
            reason: unbinned >= need ? 'UNBINNED_STOCK' : 'STOCK_SHORT',
          });
        }
      }
      await this.deps.shipmentFlow.stock(tx, s, moves, 'ALLOCATE', actor);
      await this.repo.createAllocations(tx, rows);
      for (const sh of short)
        await this.deps.fulfilmentExceptions.raise(tx, {
          type: 'SHORTAGE',
          cause: sh.reason === 'UNBINNED_STOCK' ? 'UNBINNED_STOCK' : 'STOCK_SHORT',
          severity: 'HIGH',
          warehouseId: s.warehouseId,
          orderId: s.orderId,
          shipmentId: s.id,
          variantId: sh.variantId,
          requiredQty: s.lines.find((l) => l.lineNo === sh.lineNo)?.qty ?? 0,
          impactedQty: sh.short,
          title:
            sh.reason === 'UNBINNED_STOCK'
              ? 'Stock is only in unbinned opening lots'
              : 'Not enough eligible stock for FEFO allocation',
          diagnostic: { lineNo: sh.lineNo, reason: sh.reason },
          proposal: { action: sh.reason === 'UNBINNED_STOCK' ? 'BIN_OPENING_STOCK' : 'REALLOCATE' },
          dedupeKey: `short:${s.id}:${sh.variantId}`,
        });
      const after = await this.repo.shipment(s.id, tx);
      if (after === null) throw new NotFoundError('Shipment');
      const complete = after.lines.every((l) => l.allocatedQty >= l.qty - l.cancelledQty);
      if (complete && after.status === 'RELEASED')
        await this.deps.shipmentFlow.move(tx, after, 'ALLOCATED', actor, 'FEFO_ALLOCATED');
      else if (rows.length > 0)
        await this.deps.shipmentFlow.note(
          tx,
          after,
          'PARTIALLY_ALLOCATED',
          actor,
          `${String(rows.length)} lots`,
        );
      if (caller !== null && rows.some((r) => r.isFefo === false))
        await this.audit(tx, caller, 'fulfilment.fefo_override', s.id, {
          overrides: rows
            .filter((r) => r.isFefo === false)
            .map((r) => ({ positionId: r.positionId, reason: r.overrideReason })),
        });
      return { allocatedLots: rows.length, complete, short };
    });
    return { shipmentId, ...result };
  }

  /** Replace one allocated (unpicked) lot by another lot of the same SKU (W3.05 Change batch). */
  async changeBatch(
    caller: Caller,
    shipmentId: string,
    input: { allocationId: string; positionId: string; qty?: number; reason: string },
  ) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lockFor(tx, caller, shipmentId, 'fulfilment.manage');
      if (s.holdActive)
        throw new ConflictError('The order is on hold', { details: { reason: 'ON_HOLD' } });
      const order = await this.repo.order(s.orderId, tx);
      if (order === null) throw new NotFoundError('Order');
      const a = (await this.repo.allocations(s.id, tx)).find((x) => x.id === input.allocationId);
      if (a?.status !== 'ALLOCATED' || a.pickedQty > 0)
        throw new ConflictError('Only an unpicked allocation can change batch', {
          details: { reason: 'INVALID_STATE' },
        });
      const qty = input.qty ?? a.qty;
      if (qty > a.qty)
        throw new ValidationError([{ path: 'body.qty', message: `at most ${String(a.qty)}` }]);
      const lots = await this.rank(s, order, a.variantId, qty);
      const [p] = this.checkPicks(
        caller,
        s,
        lots,
        [{ positionId: input.positionId, qty, overrideReason: input.reason }],
        qty,
      );
      const lot = lots.find((l) => l.positionId === input.positionId);
      if (p === undefined || lot === undefined)
        throw new ValidationError([{ path: 'body.positionId', message: 'not an eligible lot' }]);
      const actor = actorOf(caller);
      await this.deps.shipmentFlow.stock(
        tx,
        s,
        [
          {
            type: 'DEALLOCATE',
            from: 'RESERVED',
            to: 'AVAILABLE',
            qty,
            source: { id: a.positionId },
            shipmentId: s.id,
          },
          {
            type: 'ALLOCATE',
            from: 'AVAILABLE',
            to: 'RESERVED',
            qty,
            source: { id: lot.positionId },
            shipmentId: s.id,
          },
        ],
        'ALLOCATE',
        actor,
        input.reason,
      );
      await this.repo.updateAllocation(
        tx,
        a.id,
        qty === a.qty
          ? { status: 'RELEASED', releasedAt: new Date(), releaseReason: 'Batch changed' }
          : { qty: a.qty - qty },
      );
      await this.repo.createAllocations(tx, [
        {
          shipmentId: s.id,
          lineNo: a.lineNo,
          warehouseId: s.warehouseId,
          variantId: a.variantId,
          positionId: lot.positionId,
          batchId: lot.batchId,
          binId: lot.bin?.id ?? null,
          qty,
          isFefo: lot.recommended,
          overrideReason: lot.recommended ? null : input.reason,
          allocatedBy: caller.userId,
        },
      ]);
      await this.deps.shipmentFlow.note(
        tx,
        s,
        'BATCH_CHANGED',
        actor,
        `${lot.batchNo}: ${input.reason}`,
      );
      await this.audit(
        tx,
        caller,
        'fulfilment.batch_changed',
        s.id,
        {
          from: a.batchId,
          to: lot.batchId,
          qty,
          fefo: lot.recommended,
        },
        input.reason,
      );
    });
    return this.allocationSummary(caller, shipmentId);
  }

  /** Release allocations (W3.05): unpicked lots back to AVAILABLE; shipment back to RELEASED. */
  async release(caller: Caller, shipmentId: string, input: { lineNo?: number; reason?: string }) {
    await this.deps.runInTransaction(async (tx) => {
      const s = await this.lockFor(tx, caller, shipmentId, 'fulfilment.manage');
      if (!['RELEASED', 'ALLOCATED', 'ASSIGNED'].includes(s.status))
        throw new ConflictError('Picking has started; allocations can no longer be released', {
          details: { reason: 'NOT_EDITABLE_AFTER_PICK' },
        });
      const rows = (await this.repo.allocations(s.id, tx)).filter(
        (a) =>
          a.status === 'ALLOCATED' && (input.lineNo === undefined || a.lineNo === input.lineNo),
      );
      const actor = actorOf(caller);
      await this.deps.shipmentFlow.releaseLots(
        tx,
        s,
        rows,
        input.reason ?? 'Allocation released',
        actor,
      );
      for (const l of s.lines)
        if (input.lineNo === undefined || l.lineNo === input.lineNo)
          await this.repo.updateLine(tx, s.id, l.lineNo, {
            allocatedQty: Math.max(
              0,
              l.allocatedQty -
                rows.filter((a) => a.lineNo === l.lineNo).reduce((n, a) => n + a.qty, 0),
            ),
          });
      if (s.status !== 'RELEASED') {
        await this.repo.cancelTasks(tx, s.id);
        await this.deps.shipmentFlow.move(tx, s, 'RELEASED', actor, 'ALLOCATION_RELEASED', {
          note: input.reason ?? null,
          force: true,
        });
      }
    });
    return this.allocationSummary(caller, shipmentId);
  }

  // ── shelf-life rules (admin) ──

  async shelfLifeRules() {
    return this.repo.shelfLifeRules();
  }

  async createShelfLifeRule(
    caller: Caller,
    input: {
      name: string;
      stateCode?: string | null;
      rootCategoryId?: string | null;
      farmCategory?: string | null;
      minRemainingDays: number;
      isActive?: boolean;
    },
  ) {
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.createShelfLifeRule(tx, {
        name: input.name,
        stateCode: input.stateCode ?? null,
        rootCategoryId: input.rootCategoryId ?? null,
        farmCategory: input.farmCategory ?? null,
        minRemainingDays: input.minRemainingDays,
        isActive: input.isActive ?? true,
        createdBy: caller.userId,
      });
      await this.audit(tx, caller, 'fulfilment.shelf_life_rule_created', r.id, input);
      return r;
    });
  }

  async updateShelfLifeRule(
    caller: Caller,
    id: string,
    input: Partial<{
      name: string;
      stateCode: string | null;
      rootCategoryId: string | null;
      farmCategory: string | null;
      minRemainingDays: number;
      isActive: boolean;
    }> & { expectedVersion: number },
  ) {
    const cur = await this.repo.shelfLifeRule(id);
    if (cur === null) throw new NotFoundError('Shelf-life rule');
    const { expectedVersion, ...data } = input;
    if (cur.version !== expectedVersion)
      throw new ConflictError('The rule changed', { details: { reason: 'VERSION_CONFLICT' } });
    return this.deps.runInTransaction(async (tx) => {
      const r = await this.repo.updateShelfLifeRule(tx, id, { ...data, updatedBy: caller.userId });
      await this.audit(tx, caller, 'fulfilment.shelf_life_rule_updated', id, data);
      return r;
    });
  }

  async deleteShelfLifeRule(caller: Caller, id: string) {
    const cur = await this.repo.shelfLifeRule(id);
    if (cur === null) throw new NotFoundError('Shelf-life rule');
    await this.deps.runInTransaction(async (tx) => {
      await this.repo.deleteShelfLifeRule(tx, id);
      await this.audit(tx, caller, 'fulfilment.shelf_life_rule_deleted', id, { name: cur.name });
    });
  }

  /** W3.15 card: per line the rule, the earliest eligible expiry and whether allocated lots pass. */
  async shelfLifeCheck(caller: Caller, orderId: string) {
    const order = await this.repo.order(orderId);
    if (order === null) throw new NotFoundError('Order');
    const shipments = await this.repo.shipmentsOfOrder(orderId);
    if (
      !shipments.some((s) => caller.access.can('fulfilment.view', s.warehouseId)) &&
      caller.access.scope('fulfilment.view') !== 'ALL'
    )
      throw new NotFoundError('Order');
    const today = new Date(`${istDay(new Date())}T00:00:00.000Z`);
    const out = [];
    for (const s of shipments) {
      const allocs = (await this.repo.allocations(s.id)).filter((a) => a.status !== 'RELEASED');
      const lots = await this.deps.stockService.lotsFor(
        s.warehouseId,
        s.lines.map((l) => l.variantId),
      );
      const batchExp = new Map(
        (await this.deps.stockService.batchExpiries(allocs.map((a) => a.batchId))).map((b) => [
          b.id,
          b.expiryDate,
        ]),
      );
      for (const l of s.lines) {
        const m = await this.minDays(order, l.variantId);
        const earliest = lots
          .filter(
            (x) =>
              x.variantId === l.variantId &&
              x.expiryDate !== null &&
              (daysLeft(x.expiryDate, today) ?? 0) >= m.days,
          )
          .flatMap((x) => (x.expiryDate === null ? [] : [x.expiryDate]))
          .sort((a, b) => a.getTime() - b.getTime())[0];
        const mine = allocs.filter((a) => a.lineNo === l.lineNo);
        const pass = mine.every((a) => {
          const e = batchExp.get(a.batchId) ?? null;
          return e === null ? m.days === 0 : (daysLeft(e, today) ?? 0) >= m.days;
        });
        out.push({
          shipmentId: s.id,
          lineNo: l.lineNo,
          variantId: l.variantId,
          minRemainingDays: m.days,
          rule: m.rule,
          earliestEligibleExpiry: ymd(earliest ?? null),
          allocatedLots: mine.length,
          pass: mine.length === 0 ? null : pass,
        });
      }
    }
    return {
      orderId,
      status: out.every((x) => x.pass !== false) ? 'AUTO-VALIDATED' : 'FAILED',
      lines: out,
    };
  }

  // ── internals ──

  /** Lots of a SKU at the shipment's warehouse, ranked FEFO with eligibility + FEFO proposal. */
  private async rank(
    s: ShipmentRow,
    order: OrderRow,
    variantId: string,
    need: number,
  ): Promise<LotView[]> {
    const [lots, near, min] = await Promise.all([
      this.deps.stockService.lotsFor(s.warehouseId, [variantId]),
      this.deps.stockSettings.get('stock.nearExpiryDays', s.warehouseId),
      this.minDays(order, variantId),
    ]);
    const bins = await this.deps.storageService.binLocations(
      lots.flatMap((l) => (l.binId === null ? [] : [l.binId])),
    );
    const today = new Date(`${istDay(new Date())}T00:00:00.000Z`);
    let left = need;
    return lots
      .filter((l: Lot) => l.variantId === variantId)
      .map((l: Lot) => {
        const dl = daysLeft(l.expiryDate, today);
        const reason =
          l.binId === null
            ? 'UNBINNED'
            : dl !== null && dl < 0
              ? 'EXPIRED'
              : dl !== null && dl < min.days
                ? 'BELOW_MIN_SHELF_LIFE'
                : l.expiryDate === null && min.days > 0
                  ? 'EXPIRY_UNKNOWN'
                  : null;
        const eligible = reason === null;
        const proposed = eligible && left > 0 ? Math.min(left, l.available) : 0;
        left -= proposed;
        const recommended = eligible && proposed > 0;
        const b = l.binId === null ? undefined : bins.get(l.binId);
        return {
          positionId: l.positionId,
          batchId: l.batchId,
          batchNo: l.batchNo,
          expiryDate: ymd(l.expiryDate),
          mfgDate: ymd(l.mfgDate),
          daysLeft: dl,
          expiryRisk: dl !== null && dl < near,
          bin:
            l.binId === null
              ? null
              : {
                  id: l.binId,
                  code: b?.binCode ?? null,
                  zone: b?.zoneName ?? null,
                  rack: b?.rackCode ?? null,
                },
          ownerType: l.ownerType,
          available: l.available,
          certificateStatus: l.certificateStatus,
          isOpening: l.isOpening,
          eligible,
          ineligibleReason: reason,
          recommended,
          proposedQty: proposed,
        };
      });
  }

  /** Validates explicit picks; a non-FEFO pick needs the override permission + a reason. */
  private checkPicks(
    caller: Caller | null,
    s: ShipmentRow,
    lots: readonly LotView[],
    picks: readonly { positionId: string; qty: number; overrideReason?: string | undefined }[],
    need: number,
  ) {
    const total = picks.reduce((n, p) => n + p.qty, 0);
    if (total > need)
      throw new ValidationError([
        { path: 'body.lines', message: `at most ${String(need)} more units` },
      ]);
    for (const p of picks) {
      const lot = lots.find((l) => l.positionId === p.positionId);
      if (lot === undefined)
        throw new ValidationError([
          { path: 'body.lines', message: 'lot is not at this warehouse for the SKU' },
        ]);
      if (!lot.eligible)
        throw new ConflictError(
          `Lot ${lot.batchNo} is not eligible (${lot.ineligibleReason ?? ''})`,
          {
            details: { reason: 'LOT_NOT_ELIGIBLE', ineligibleReason: lot.ineligibleReason },
          },
        );
      if (p.qty > lot.available)
        throw new ConflictError(`Only ${String(lot.available)} available in ${lot.batchNo}`, {
          details: { reason: 'INSUFFICIENT_STOCK' },
        });
      if (!lot.recommended) {
        if (caller !== null && !caller.access.can('fulfilment.fefo_override', s.warehouseId))
          throw new ForbiddenError('A non-FEFO batch needs the FEFO override permission');
        if (p.overrideReason === undefined || p.overrideReason.trim().length < 5)
          throw new ValidationError([
            { path: 'body.lines', message: `a reason is required to skip FEFO for ${lot.batchNo}` },
          ]);
      }
    }
    return picks.map((p) => ({
      positionId: p.positionId,
      qty: p.qty,
      overrideReason: p.overrideReason,
    }));
  }

  /** Borrows ALLOCATED units of held orders (oldest hold first) for this line; returns units. */
  private async borrow(
    tx: Tx,
    s: ShipmentRow,
    lineNo: number,
    variantId: string,
    need: number,
    actor: FlowActor,
  ) {
    const soft = (await this.repo.softAllocations(tx, s.warehouseId, variantId)).filter(
      (a) => a.shipmentId !== s.id && a.pickedQty === 0,
    );
    let got = 0;
    for (const a of soft) {
      if (got >= need) break;
      const take = Math.min(a.qty, need - got);
      const victim = await this.repo.lockShipment(tx, a.shipmentId);
      if (victim === null) continue;
      await this.repo.updateAllocation(
        tx,
        a.id,
        take === a.qty
          ? {
              status: 'RELEASED',
              releasedAt: new Date(),
              releaseReason: `Borrowed by ${s.shipmentNo}`,
            }
          : { qty: a.qty - take },
      );
      const vl = victim.lines.find((l) => l.lineNo === a.lineNo);
      if (vl !== undefined)
        await this.repo.updateLine(tx, victim.id, vl.lineNo, {
          allocatedQty: Math.max(0, vl.allocatedQty - take),
        });
      if (victim.status === 'ALLOCATED' || victim.status === 'ASSIGNED')
        await this.deps.shipmentFlow.move(tx, victim, 'RELEASED', actor, 'ALLOCATION_BORROWED', {
          note: `${String(take)} units borrowed by ${s.shipmentNo} while on hold`,
          force: true,
        });
      await this.repo.createAllocations(tx, [
        {
          shipmentId: s.id,
          lineNo,
          warehouseId: s.warehouseId,
          variantId,
          positionId: a.positionId,
          batchId: a.batchId,
          binId: a.binId,
          qty: take,
          isFefo: true,
          allocatedBy: actor.id,
        },
      ]);
      got += take;
    }
    return got;
  }

  private async minDays(order: OrderRow, variantId: string) {
    const [rules, v, def] = await Promise.all([
      this.repo.shelfLifeRules(),
      this.deps.stockService.variantRows([variantId]),
      this.deps.fulfilmentSettings.get('fulfilment.minShelfLifeDays'),
    ]);
    const rule = pickShelfLifeRule(rules, {
      stateCode: order.stateCode,
      rootCategoryId: v[0]?.rootCategoryId ?? null,
      farmCategory: order.segment,
    });
    return {
      days: rule?.minRemainingDays ?? def,
      rule:
        rule === null
          ? null
          : { id: rule.id, name: rule.name, minRemainingDays: rule.minRemainingDays },
    };
  }

  private async allocationViews(
    s: ShipmentRow,
    rows: Awaited<ReturnType<Cradle['fulfilmentRepository']['allocations']>>,
  ) {
    const [batches, bins, variants, near] = await Promise.all([
      this.deps.stockService.batchExpiries(rows.map((a) => a.batchId)),
      this.deps.storageService.binLocations(
        rows.flatMap((a) => (a.binId === null ? [] : [a.binId])),
      ),
      this.deps.stockService.variantRows(rows.map((a) => a.variantId)),
      this.deps.stockSettings.get('stock.nearExpiryDays', s.warehouseId),
    ]);
    const b = new Map(batches.map((x) => [x.id, x]));
    const v = new Map(variants.map((x) => [x.variantId, x]));
    const today = new Date(`${istDay(new Date())}T00:00:00.000Z`);
    return rows.map((a) => {
      const bt = b.get(a.batchId);
      const dl = daysLeft(bt?.expiryDate ?? null, today);
      const bin = a.binId === null ? undefined : bins.get(a.binId);
      return {
        allocationId: a.id,
        lineNo: a.lineNo,
        variantId: a.variantId,
        sku: v.get(a.variantId)?.sku ?? null,
        name: v.get(a.variantId)?.name ?? null,
        batchId: a.batchId,
        batchNo: bt?.batchNo ?? null,
        expiryDate: ymd(bt?.expiryDate ?? null),
        daysLeft: dl,
        expiryColour: dl === null ? 'GREY' : dl < 0 ? 'RED' : dl < near ? 'AMBER' : 'GREEN',
        bin:
          a.binId === null
            ? null
            : {
                id: a.binId,
                code: bin?.binCode ?? null,
                zone: bin?.zoneName ?? null,
                rack: bin?.rackCode ?? null,
              },
        qty: a.qty,
        picked: a.pickedQty,
        status: a.status,
        isFefo: a.isFefo,
        overrideReason: a.overrideReason,
        soft: a.soft,
      };
    });
  }

  private async visible(caller: Caller, shipmentId: string) {
    const s = await this.repo.shipment(shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    caller.access.require('fulfilment.view', s.warehouseId);
    let order = await this.repo.order(s.orderId);
    if (order === null) throw new NotFoundError('Order');
    if (!order.factsLoaded && (await this.deps.fulfilmentSync.loadFacts(order.orderId)))
      order = (await this.repo.order(s.orderId)) ?? order;
    return { s, order };
  }

  private async lockFor(tx: Tx, caller: Caller | null, shipmentId: string, key: string) {
    const s = await this.repo.lockShipment(tx, shipmentId);
    if (s === null) throw new NotFoundError('Shipment');
    if (caller !== null) caller.access.require(key, s.warehouseId);
    return s;
  }

  private async audit(
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
        targetType: 'shipment',
        targetId: id,
        after: after as Record<string, unknown>,
        reason,
      },
    );
  }
}
