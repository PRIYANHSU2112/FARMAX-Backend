import { ConflictError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { OrderDeliveryUpdatedV1 } from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import type { Caller } from '../../middleware/guards.js';
import { IN_WAREHOUSE, PRE_PICK } from './fulfilment.rules.js';

export interface DeliveryChange {
  contactName?: string;
  contactPhone?: string;
  line1?: string;
  line2?: string | null;
  landmark?: string | null;
  village?: string | null;
  mandal?: string | null;
  district?: string;
  pinCode?: string;
  latitude?: number | null;
  longitude?: number | null;
  deliveryPromise?: string | null;
}

export interface AmendmentInput {
  delivery?: DeliveryChange;
  /** Absolute quantities per SKU (0 = remove). */
  lines?: { variantId: string; qty: number }[];
  reason: string;
}

/**
 * Order hold & edit — amendments (D-57b W3.15). One save changes delivery details (order-service
 * owns them; the warehouse checks its PIN coverage first) and lowers / removes quantities (the
 * normal order cancel: refund + reservation release). A quantity INCREASE needs a balance payment
 * — prepaid orders cannot take it yet (`modules.balancePayment: false`; place an add-on order).
 * Allowed only while no shipment is being picked.
 */
export class FulfilmentAmendments {
  constructor(
    private readonly deps: Pick<
      Cradle,
      | 'fulfilmentRepository'
      | 'fulfilmentOrders'
      | 'fulfilmentSync'
      | 'fulfilmentExceptions'
      | 'fulfilmentFefo'
      | 'dispatchService'
      | 'serviceAreasService'
      | 'orderClient'
      | 'runInTransaction'
      | 'auditService'
    >,
  ) {}

  /** What a save would do (nothing changes). */
  async quote(caller: Caller, orderId: string, input: Omit<AmendmentInput, 'reason'>) {
    const { order, shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    const open = shipments.filter((s) => IN_WAREHOUSE.includes(s.status));
    const onFloor = open.filter((s) => !PRE_PICK.includes(s.status));
    const issues: { code: string; message: string }[] = [];
    if (onFloor.length > 0)
      issues.push({
        code: 'NOT_EDITABLE_AFTER_PICK',
        message: `${onFloor.map((s) => s.shipmentNo).join(', ')} is being picked`,
      });
    const newPin = input.delivery?.pinCode;
    if (newPin !== undefined && newPin !== order.pinCode) {
      const cover = new Set(
        (await this.deps.serviceAreasService.networkCoverage(newPin)).map((c) => c.warehouseId),
      );
      const uncovered = open.filter((s) => !cover.has(s.warehouseId));
      if (uncovered.length > 0)
        issues.push({
          code: 'PIN_NOT_COVERED',
          message: `The assigned warehouse does not serve ${newPin}; re-route the order first`,
        });
    }
    const active = new Map<string, number>();
    for (const l of order.lines) active.set(l.variantId, l.qty - l.cancelledQty);
    const decreases: {
      variantId: string;
      from: number;
      to: number;
      qty: number;
      refund: string;
    }[] = [];
    const increases: { variantId: string; from: number; to: number }[] = [];
    for (const l of input.lines ?? []) {
      const cur = active.get(l.variantId) ?? 0;
      const ol = order.lines.find((x) => x.variantId === l.variantId);
      if (l.qty < cur)
        decreases.push({
          variantId: l.variantId,
          from: cur,
          to: l.qty,
          qty: cur - l.qty,
          refund: (Number(ol?.unitPrice.toFixed(2) ?? 0) * (cur - l.qty)).toFixed(2),
        });
      else if (l.qty > cur) increases.push({ variantId: l.variantId, from: cur, to: l.qty });
    }
    if (increases.length > 0)
      issues.push({
        code: 'BALANCE_PAYMENT_NOT_AVAILABLE',
        message:
          'More units need a balance payment; prepaid orders cannot take it yet — place an add-on order.',
      });
    if (
      decreases.length > 0 &&
      decreases.every((d) => d.to === 0) &&
      decreases.length === active.size
    )
      issues.push({
        code: 'USE_CANCEL',
        message: 'Removing every item cancels the order; use Cancel order instead.',
      });
    return {
      orderId,
      orderNo: order.orderNo,
      version: order.version,
      delivery: input.delivery ?? null,
      decreases,
      increases,
      refundEstimate: decreases.reduce((n, d) => n + Number(d.refund), 0).toFixed(2),
      issues,
      ok: issues.length === 0,
      modules: { balancePayment: false },
    };
  }

  /** "Save & Update Order Changes". */
  async amend(caller: Caller, orderId: string, input: AmendmentInput) {
    const q = await this.quote(caller, orderId, input);
    if (!q.ok)
      throw new ConflictError(q.issues[0]?.message ?? 'The change is not allowed', {
        details: { reason: q.issues[0]?.code ?? 'NOT_ALLOWED', issues: q.issues },
      });
    const { shipments } = await this.deps.fulfilmentOrders.visible(caller, orderId);
    for (const s of shipments.filter((x) => IN_WAREHOUSE.includes(x.status)))
      caller.access.require('fulfilment.manage', s.warehouseId);
    if (input.delivery !== undefined)
      await this.deps.orderClient.updateDelivery(orderId, {
        ...input.delivery,
        reason: input.reason,
        by: caller.userId,
      });
    if (q.decreases.length > 0)
      await this.deps.orderClient.cancelLines(orderId, {
        lines: q.decreases.map((d) => ({ variantId: d.variantId, qty: d.qty })),
        note: `Order amended from the warehouse: ${input.reason}`.slice(0, 500),
        by: caller.userId,
      });
    await this.deps.runInTransaction(async (tx) => {
      await this.deps.auditService.record(
        tx,
        { userId: caller.userId, ip: caller.ip, requestId: caller.requestId },
        {
          action: 'order.amend',
          targetType: 'order',
          targetId: orderId,
          after: {
            delivery: input.delivery === undefined ? null : Object.keys(input.delivery),
            decreases: q.decreases,
          },
          reason: input.reason,
        },
      );
    });
    // Pull the new facts now (the event does it too; the screen wants them at once).
    await this.deps.fulfilmentSync.loadFacts(orderId);
    return {
      orderId,
      deliveryUpdated: input.delivery !== undefined,
      decreases: q.decreases,
      refundEstimate: q.refundEstimate,
    };
  }

  /** `order.delivery_updated.v1`: refresh the read model; an uncovered PIN → allocation issue. */
  async applyDeliveryUpdated(tx: Tx, d: OrderDeliveryUpdatedV1) {
    await this.deps.fulfilmentRepository.updateOrder(tx, d.orderId, { factsLoaded: false });
    const cover = new Set(
      (await this.deps.serviceAreasService.networkCoverage(d.pinCode)).map((c) => c.warehouseId),
    );
    for (const s of (await this.deps.fulfilmentRepository.shipmentsOfOrder(d.orderId, tx)).filter(
      (x) => IN_WAREHOUSE.includes(x.status) && !cover.has(x.warehouseId),
    ))
      await this.deps.fulfilmentExceptions.raise(tx, {
        type: 'ALLOCATION_ISSUE',
        cause: 'OTHER',
        severity: 'HIGH',
        warehouseId: s.warehouseId,
        orderId: d.orderId,
        shipmentId: s.id,
        title: `New delivery PIN ${d.pinCode} is outside this warehouse's service area`,
        diagnostic: { pinCode: d.pinCode, changes: d.changes },
        proposal: { action: 'REALLOCATE' },
        dedupeKey: `pin:${s.id}:${d.pinCode}`,
      });
  }

  /** Shipment manifest: header, ship-to, lots per line, packages, vehicle / trip. */
  async manifest(caller: Caller, shipmentId: string) {
    const [header, allocations, vehicle] = await Promise.all([
      this.deps.fulfilmentFefo.header(caller, shipmentId),
      this.deps.fulfilmentFefo.allocations(caller, shipmentId),
      this.deps.dispatchService.shipmentVehicle(caller, shipmentId).catch(() => null),
    ]);
    const s = await this.deps.fulfilmentRepository.shipment(shipmentId);
    const [packages, order] = await Promise.all([
      this.deps.fulfilmentRepository.packages(shipmentId),
      s === null ? null : this.deps.fulfilmentRepository.order(s.orderId),
    ]);
    return {
      header,
      shipTo:
        order === null
          ? null
          : {
              name: order.customerName,
              farmName: order.farmName,
              customerPoRef: order.customerPoRef,
              address: order.shipTo,
              pinCode: order.pinCode,
              district: order.district,
            },
      lines: allocations,
      packages: packages.map((p) => ({
        boxNo: p.boxNo,
        packageType: p.packageType,
        weightKg: p.weightKg === null ? null : Number(p.weightKg.toString()),
        sealed: p.sealed,
      })),
      totals:
        s === null
          ? null
          : { lines: s.lineCount, units: s.unitCount, weightKg: s.weightKg, value: s.value },
      vehicle,
      generatedAt: new Date(),
    };
  }
}
