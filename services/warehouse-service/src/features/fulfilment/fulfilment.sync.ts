import type { Tx } from '@farmx/database';
import type {
  IssueRejectedV1,
  OrderConfirmedV1,
  OrderPaidV1,
  OrderPlacedV1,
  OrderStockReleaseV1,
  ReservationCommittedV1,
  ReservationReleasedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { type FlowActor, SYSTEM_ACTOR } from './fulfilment.flow.js';
import type { OrderRow, ShipmentRow } from './fulfilment.repository.js';
import { IN_WAREHOUSE, slaDueAt } from './fulfilment.rules.js';

const searchOf = (...parts: (string | null | undefined)[]) =>
  parts
    .filter((p): p is string => typeof p === 'string' && p !== '')
    .join(' ')
    .toLowerCase()
    .slice(0, 1000);

const COLD = (tc: string | null | undefined) => tc?.startsWith('CC') === true;

/**
 * Order + reservation events → order read model and F1 shipments (inside the inbox transaction):
 *   order.placed / paid                 → order row (customer name, PIN, payment status)
 *   inventory.reservation_committed     → one PENDING_RELEASE shipment per warehouse holding stock
 *   order.confirmed                     → shipments RELEASED (SLA), compliance gate evaluated
 *   order.rejected / cancelled / failed → FULL: shipments cancelled, lots given back
 *   inventory.reservation_released      → PARTIAL (per warehouse): lines shrink, extra lots freed
 * The full facts (address, phone, lines, payment) are pulled from order-service OUTSIDE the
 * inbox transaction (facts-sync job / on first read). Every applier is idempotent.
 */
export class FulfilmentSync {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'shipmentFlow'
      | 'stockService'
      | 'calendarService'
      | 'fulfilmentSettings'
      | 'orderClient'
      | 'runInTransaction'
      | 'logger'
      | 'complianceService'
      | 'fulfilmentExceptions'
      | 'dispatchService'
      | 'routingService'
    >,
  ) {}

  private get repo() {
    return this.deps.fulfilmentRepository;
  }

  async applyPlaced(tx: Tx, d: OrderPlacedV1, at: Date): Promise<void> {
    const ship = d.shipTo;
    await this.repo.upsertOrder(
      tx,
      d.orderId,
      {
        orderNo: d.orderNo,
        userId: d.userId,
        farmId: d.farmId,
        customerName: ship?.name.slice(0, 120) ?? null,
        district: ship?.district?.slice(0, 80) ?? null,
        pinCode: ship?.pinCode ?? null,
        orderStatus: 'PENDING_ADMIN_CONFIRMATION',
        paymentStatus: 'PENDING',
        grandTotal: d.grandTotal,
        placedAt: at,
        searchText: searchOf(d.orderNo, ship?.name, ship?.pinCode, ship?.district),
      },
      {
        orderNo: d.orderNo,
        userId: d.userId,
        farmId: d.farmId,
        grandTotal: d.grandTotal,
        placedAt: at,
      },
    );
  }

  async applyPaid(tx: Tx, d: OrderPaidV1, at: Date): Promise<void> {
    await this.repo.upsertOrder(
      tx,
      d.orderId,
      {
        orderNo: d.orderNo,
        orderStatus: 'PENDING_ADMIN_CONFIRMATION',
        paymentStatus: 'PAID',
        paidAt: at,
        placedAt: at,
        searchText: searchOf(d.orderNo),
      },
      { paymentStatus: 'PAID', paidAt: at },
    );
  }

  async applyCommitted(tx: Tx, d: ReservationCommittedV1, at: Date): Promise<void> {
    await this.repo.upsertOrder(
      tx,
      d.orderRef,
      {
        orderNo: '',
        orderStatus: 'PENDING_ADMIN_CONFIRMATION',
        paymentStatus: 'PAID',
        placedAt: at,
        reservationId: d.reservationId,
      },
      { reservationId: d.reservationId },
    );
    if (d.lines === undefined || d.lines.length === 0) return;
    const order = await this.repo.lockOrder(tx, d.orderRef);
    if (order === null) return;
    const existing = await this.repo.lockOrderShipments(tx, d.orderRef);
    const groups = new Map<string, { variantId: string; qty: number }[]>();
    for (const l of d.lines)
      groups.set(l.warehouseId, [
        ...(groups.get(l.warehouseId) ?? []),
        { variantId: l.variantId, qty: l.qty },
      ]);
    for (const [warehouseId, lines] of groups) {
      if (existing.some((s) => s.warehouseId === warehouseId)) continue;
      const s = await this.createShipment(tx, order, warehouseId, lines);
      if (order.orderStatus === 'CONFIRMED' || order.orderStatus === 'IN_FULFILMENT')
        await this.release(tx, s, order.confirmedAt ?? at);
    }
  }

  async applyConfirmed(tx: Tx, d: OrderConfirmedV1, at: Date): Promise<void> {
    const confirmedAt = new Date(d.confirmedAt);
    await this.repo.upsertOrder(
      tx,
      d.orderId,
      {
        orderNo: d.orderNo,
        orderStatus: 'CONFIRMED',
        paymentStatus: 'PAID',
        placedAt: at,
        confirmedAt,
        searchText: searchOf(d.orderNo),
      },
      { orderNo: d.orderNo, orderStatus: 'CONFIRMED', confirmedAt },
    );
    const order = await this.repo.lockOrder(tx, d.orderId);
    if (order === null) return;
    if (order.lines.length === 0)
      await this.repo.replaceOrderLines(
        tx,
        d.orderId,
        d.lines.map((l) => ({ lineNo: l.lineNo, variantId: l.variantId, qty: l.qty })),
      );
    const shipments = await this.repo.lockOrderShipments(tx, d.orderId);
    for (const s of shipments)
      for (const l of s.lines)
        if (l.orderLineNo === null) {
          const ol = d.lines.find((x) => x.variantId === l.variantId);
          if (ol !== undefined)
            await this.repo.updateLine(tx, s.id, l.lineNo, { orderLineNo: ol.lineNo });
        }
    const status = await this.deps.complianceService.evaluateInTx(tx, {
      orderId: d.orderId,
      orderNo: d.orderNo,
      warehouseId: shipments[0]?.warehouseId ?? null,
      lines: d.lines,
      value: order.grandTotal.toFixed(2),
    });
    await this.repo.updateOrder(tx, d.orderId, { complianceStatus: status });
    for (const s of await this.repo.shipmentsOfOrder(d.orderId, tx))
      if (s.status === 'PENDING_RELEASE') await this.release(tx, s, confirmedAt);
  }

  async applyStopped(
    tx: Tx,
    d: OrderStockReleaseV1,
    at: Date,
    status: 'REJECTED' | 'CANCELLED' | 'FAILED',
  ): Promise<void> {
    const order = await this.repo.lockOrder(tx, d.orderId);
    if (order === null) return;
    if (d.scope === 'PARTIAL') {
      const lines = order.lines.map((l) => {
        const c = d.lines.filter((x) => x.variantId === l.variantId).reduce((n, x) => n + x.qty, 0);
        return {
          lineNo: l.lineNo,
          variantId: l.variantId,
          productId: l.productId,
          sku: l.sku,
          name: l.name,
          temperatureClass: l.temperatureClass,
          qty: l.qty,
          cancelledQty: Math.min(l.qty, l.cancelledQty + c),
          unitPrice: l.unitPrice,
          lineTotal: l.lineTotal,
        };
      });
      await this.repo.replaceOrderLines(tx, d.orderId, lines);
      return;
    }
    await this.repo.updateOrder(tx, d.orderId, { orderStatus: status, cancelledAt: at });
    await this.cancelAll(
      tx,
      d.orderId,
      `Order ${status.toLowerCase()} (${d.reasonCode})`,
      SYSTEM_ACTOR,
    );
    await this.deps.complianceService.closeForOrderInTx(tx, d.orderId, status);
  }

  async applyReleased(tx: Tx, d: ReservationReleasedV1): Promise<void> {
    if (d.scope === 'FULL') {
      await this.cancelAll(tx, d.orderRef, 'Reservation released', SYSTEM_ACTOR);
      return;
    }
    const shipments = await this.repo.lockOrderShipments(tx, d.orderRef);
    for (const r of d.lines) {
      if (r.warehouseId === undefined) continue;
      const s = shipments.find((x) => x.warehouseId === r.warehouseId);
      if (s === undefined || !IN_WAREHOUSE.includes(s.status)) continue;
      await this.shrink(tx, s, r.variantId, r.qty, SYSTEM_ACTOR, 'Partial cancellation');
    }
  }

  /** Cancels every shipment of an order still in the warehouse (lots back, tasks cancelled). */
  async cancelAll(tx: Tx, orderId: string, reason: string, actor: FlowActor): Promise<void> {
    const shipments = await this.repo.lockOrderShipments(tx, orderId);
    for (const s of shipments) {
      if (!IN_WAREHOUSE.includes(s.status)) {
        if (s.status !== 'CANCELLED')
          this.deps.logger.warn(
            { shipmentId: s.id, status: s.status },
            'order closed after the shipment left the warehouse; returns flow',
          );
        continue;
      }
      await this.deps.shipmentFlow.releaseLots(
        tx,
        s,
        await this.repo.allocations(s.id, tx),
        reason,
        actor,
      );
      await this.repo.cancelTasks(tx, s.id);
      for (const l of s.lines)
        await this.repo.updateLine(tx, s.id, l.lineNo, { cancelledQty: l.qty, allocatedQty: 0 });
      await this.deps.shipmentFlow.move(tx, s, 'CANCELLED', actor, 'CANCELLED', {
        note: reason,
        force: true,
      });
    }
    const hold = await this.repo.openHold(orderId, tx);
    if (hold !== null)
      await this.repo.updateHold(tx, hold.id, {
        releasedAt: new Date(),
        releaseNote: 'Order closed',
      });
    await this.repo.updateOrder(tx, orderId, { holdActive: false });
  }

  /**
   * A line lost `qty` (partial cancel / reallocation away): unallocated units go first, then the
   * newest ALLOCATED lots are freed; picked or packed units are never touched here (exception).
   */
  async shrink(
    tx: Tx,
    s: ShipmentRow,
    variantId: string,
    qty: number,
    actor: FlowActor,
    reason: string,
  ): Promise<void> {
    const line = s.lines.find((l) => l.variantId === variantId);
    if (line === undefined) return;
    const cancelled = Math.min(line.qty, line.cancelledQty + qty);
    const active = line.qty - cancelled;
    const rows = (await this.repo.allocations(s.id, tx)).filter(
      (a) => a.lineNo === line.lineNo && a.status === 'ALLOCATED',
    );
    let excess = line.allocatedQty - active;
    let freed = 0;
    for (const a of [...rows].reverse()) {
      if (excess <= 0) break;
      const free = a.qty - a.pickedQty;
      if (free <= 0) continue;
      const take = Math.min(free, excess);
      await this.deps.shipmentFlow.stock(
        tx,
        s,
        [
          {
            type: 'DEALLOCATE',
            from: 'RESERVED',
            to: 'AVAILABLE',
            qty: take,
            source: { id: a.positionId },
            shipmentId: s.id,
          },
        ],
        'DEALLOCATE',
        SYSTEM_ACTOR,
        reason,
      );
      await this.repo.updateAllocation(
        tx,
        a.id,
        take === a.qty
          ? { status: 'RELEASED', releasedAt: new Date(), releaseReason: reason.slice(0, 200) }
          : { qty: a.qty - take },
      );
      excess -= take;
      freed += take;
    }
    await this.repo.updateLine(tx, s.id, line.lineNo, {
      cancelledQty: cancelled,
      allocatedQty: line.allocatedQty - freed,
    });
    if (excess > 0)
      await this.deps.fulfilmentExceptions.raise(tx, {
        type: 'ALLOCATION_MISMATCH',
        cause: 'CUSTOMER_CANCEL',
        severity: 'HIGH',
        warehouseId: s.warehouseId,
        orderId: s.orderId,
        shipmentId: s.id,
        variantId,
        requiredQty: active,
        availableQty: line.allocatedQty - freed,
        impactedQty: excess,
        title: `${String(excess)} picked units exceed the order after a cancellation`,
        diagnostic: { reason, lineNo: line.lineNo },
        proposal: { action: 'RESTOCK' },
        dedupeKey: `shrink:${s.id}:${variantId}`,
      });
    const after = await this.repo.shipment(s.id, tx);
    if (after?.lines.every((l) => l.qty - l.cancelledQty <= 0) === true)
      await this.deps.shipmentFlow.move(tx, after, 'CANCELLED', actor, 'CANCELLED', {
        note: reason,
        force: true,
      });
    else
      await this.deps.shipmentFlow.note(tx, s, 'LINE_REDUCED', actor, `${reason}: −${String(qty)}`);
  }

  /** PENDING_RELEASE → RELEASED with its SLA due time (calendar, cut-off, priority). */
  async release(tx: Tx, s: ShipmentRow, at: Date): Promise<void> {
    const [settings, cal] = await Promise.all([
      this.deps.fulfilmentSettings.all(s.warehouseId),
      this.deps.calendarService.slaCalendar(s.warehouseId),
    ]);
    const due = slaDueAt(at, s.priority, cal, settings['fulfilment.priorityDispatchHours']);
    const order = await this.repo.order(s.orderId, tx);
    const routeId = await this.deps.dispatchService.routeForPin(
      s.warehouseId,
      order?.pinCode ?? null,
      tx,
    );
    await this.deps.shipmentFlow.move(tx, s, 'RELEASED', SYSTEM_ACTOR, 'RELEASED', {
      data: { slaDueAt: due, releasedAt: at, ...(routeId === null ? {} : { routeId }) },
    });
  }

  async createShipment(
    tx: Tx,
    order: OrderRow,
    warehouseId: string,
    lines: readonly { variantId: string; qty: number }[],
  ): Promise<ShipmentRow> {
    const [variants, settings] = await Promise.all([
      this.deps.stockService.variantRows(
        lines.map((l) => l.variantId),
        tx,
      ),
      this.deps.fulfilmentSettings.all(warehouseId),
    ]);
    const v = new Map(variants.map((x) => [x.variantId, x]));
    const grams = lines.reduce((n, l) => n + l.qty * (v.get(l.variantId)?.weightGrams ?? 0), 0);
    const weightKg = grams / 1000;
    const isBulk = weightKg >= settings['fulfilment.bulkMinKg'];
    const rows = lines.map((l, i) => {
      const ol = order.lines.find((x) => x.variantId === l.variantId);
      const unit = ol === undefined ? 0 : Number(ol.unitPrice.toFixed(2));
      return {
        lineNo: i + 1,
        orderLineNo: ol?.lineNo ?? null,
        variantId: l.variantId,
        qty: l.qty,
        unitPrice: unit.toFixed(2),
        lineTotal: (unit * l.qty).toFixed(2),
      };
    });
    const s = await this.repo.createShipment(
      tx,
      {
        shipmentNo: await this.deps.stockService.nextDocNo(tx, isBulk ? 'BLK' : 'SHP'),
        orderId: order.orderId,
        warehouseId,
        isBulk,
        deliveryType: isBulk ? 'BULK' : 'STANDARD',
        coldRequired: lines.some((l) => COLD(v.get(l.variantId)?.temperatureClass)),
        lineCount: rows.length,
        unitCount: rows.reduce((n, l) => n + l.qty, 0),
        weightKg: weightKg.toFixed(3),
        value: rows.reduce((n, l) => n + Number(l.lineTotal), 0).toFixed(2),
        holdActive: order.holdActive,
      },
      rows,
    );
    await this.deps.shipmentFlow.created(tx, s, SYSTEM_ACTOR);
    return s;
  }

  /** inventory refused to issue (over-issue): a high exception for a supervisor (§2a.11). */
  async applyIssueRejected(tx: Tx, d: IssueRejectedV1): Promise<void> {
    for (const l of d.lines)
      await this.deps.fulfilmentExceptions.raise(tx, {
        type: 'ISSUE_MISMATCH',
        cause: 'DRIFT',
        severity: 'HIGH',
        warehouseId: d.warehouseId,
        orderId: d.orderRef,
        shipmentId: d.shipmentId,
        variantId: l.variantId,
        requiredQty: l.requested,
        availableQty: l.held,
        impactedQty: l.requested - l.held,
        title: 'Inventory refused to issue more than the reservation holds',
        diagnostic: { dispatchId: d.dispatchId, requested: l.requested, held: l.held },
        proposal: { action: 'RECONCILE' },
        dedupeKey: 'issue:' + d.dispatchId + ':' + l.variantId,
      });
  }

  /** Compliance decision → order read model (FEFO allocation waits for APPROVED). */
  async setComplianceStatus(
    tx: Tx,
    orderId: string,
    status: 'NOT_REQUIRED' | 'PENDING' | 'FLAGGED' | 'APPROVED' | 'REJECTED' | 'ON_HOLD',
  ) {
    await this.repo.updateOrder(tx, orderId, { complianceStatus: status });
  }

  // ── order-service facts (outside the inbox transaction) ──

  /** Pulls the full facts of one order; false when order-service is unavailable. */
  async loadFacts(orderId: string): Promise<boolean> {
    const f = await this.deps.orderClient.fulfilmentFacts(orderId);
    if (f === null) return false;
    await this.deps.stockService.ensureVariants(f.lines.map((l) => l.variantId));
    // W3.12: which routing rule decides this order (best effort; never blocks the facts).
    const open = f.lines
      .filter((l) => l.qty - l.cancelledQty > 0)
      .map((l) => ({ variantId: l.variantId, qty: l.qty - l.cancelledQty }));
    const routingRuleId =
      f.shipTo.pinCode === null
        ? null
        : await this.deps.routingService
            .ruleFor(
              {
                pinCode: f.shipTo.pinCode,
                stateCode: f.shipTo.stateCode ?? null,
                district: f.shipTo.district ?? null,
                value: Number(f.totals.grandTotal ?? 0),
                lat: f.shipTo.latitude ?? null,
                lng: f.shipTo.longitude ?? null,
              },
              open,
            )
            .catch((err: unknown) => {
              this.deps.logger.warn({ err, orderId }, 'routing rule stamp skipped');
              return null;
            });
    await this.deps.runInTransaction(async (tx) => {
      const lines = f.lines.map((l) => ({
        lineNo: l.lineNo,
        variantId: l.variantId,
        productId: l.productId,
        sku: l.sku.slice(0, 40),
        name: l.name.slice(0, 250),
        temperatureClass: l.temperatureClass,
        qty: l.qty,
        cancelledQty: l.cancelledQty,
        unitPrice: l.unitPrice,
        lineTotal: l.lineTotal,
      }));
      const data = {
        orderNo: f.orderNo,
        userId: f.userId,
        farmId: f.farmId,
        channel: f.channel.slice(0, 12),
        customerName: (f.customer.name ?? f.shipTo.name)?.slice(0, 120) ?? null,
        customerPhone: f.customer.phone?.slice(0, 20) ?? null,
        farmName: f.customer.farmName?.slice(0, 160) ?? null,
        farmCode: f.customer.farmCode?.slice(0, 30) ?? null,
        customerPoRef: f.customerPoRef,
        shipTo: f.shipTo,
        district: f.shipTo.district?.slice(0, 80) ?? null,
        stateCode: f.shipTo.stateCode?.slice(0, 4) ?? null,
        pinCode: f.shipTo.pinCode,
        latitude: f.shipTo.latitude,
        longitude: f.shipTo.longitude,
        orderStatus: f.status,
        paymentStatus: f.paymentStatus,
        paymentMethod: f.paymentMethod,
        paymentInstrument: f.payment.instrument?.slice(0, 20) ?? null,
        paymentRefMasked: f.payment.providerRefMasked?.slice(0, 20) ?? null,
        refundStatus: f.refundStatus,
        grandTotal: f.totals.grandTotal ?? '0.00',
        totals: f.totals,
        itemCount: f.lines.filter((l) => l.qty - l.cancelledQty > 0).length,
        unitCount: f.lines.reduce((n, l) => n + l.qty - l.cancelledQty, 0),
        placedAt: new Date(f.placedAt),
        paidAt: f.paidAt === null ? null : new Date(f.paidAt),
        confirmedAt: f.confirmedAt === null ? null : new Date(f.confirmedAt),
        factsLoaded: true,
        searchText: searchOf(
          f.orderNo,
          f.customer.name,
          f.customer.farmName,
          f.customer.farmCode,
          f.shipTo.pinCode,
          f.shipTo.district,
          f.customerPoRef,
          f.customer.phone?.slice(-4),
        ),
      };
      await this.repo.upsertOrder(tx, orderId, { ...data, routingRuleId }, data);
      await this.repo.replaceOrderLines(tx, orderId, lines);
      for (const s of await this.repo.lockOrderShipments(tx, orderId)) {
        let value = 0;
        for (const l of s.lines) {
          const ol = lines.find((x) => x.variantId === l.variantId);
          if (ol === undefined) continue;
          const lineTotal = (Number(ol.unitPrice) * l.qty).toFixed(2);
          value += Number(lineTotal);
          await this.repo.updateLine(tx, s.id, l.lineNo, {
            orderLineNo: ol.lineNo,
            unitPrice: ol.unitPrice,
            lineTotal,
          });
        }
        await this.repo.updateShipment(tx, s.id, { value: value.toFixed(2) });
      }
    });
    return true;
  }

  /** facts-sync job: orders whose facts were never loaded (oldest first). */
  async syncFacts(limit = 50): Promise<{ loaded: number; pending: number }> {
    const due = await this.repo.ordersNeedingFacts(limit);
    let loaded = 0;
    for (const o of due) if (await this.loadFacts(o.orderId)) loaded += 1;
    return { loaded, pending: due.length - loaded };
  }
}
