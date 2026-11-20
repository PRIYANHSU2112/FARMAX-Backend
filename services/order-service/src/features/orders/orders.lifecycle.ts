import { ConflictError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import {
  ORDER_EVENTS,
  type PaymentCapturedV1,
  type PaymentExpiredV1,
  type PaymentFailedV1,
  type RefundFailedV1,
  type RefundInitiatedV1,
  type RefundProcessedV1,
  type ReservationCommittedV1,
  type ReservationRejectedV1,
  type ReservationReleasedV1,
} from '@farmx/infra/events';
import type { Cradle } from '@fastify/awilix';

import { emitOrderEvent } from '../../adapters/events.js';
import { fromPaise, toPaise } from '../pricing/index.js';
import type { CancelItem } from './orders.cancellation.js';
import {
  type Actor,
  type FailureCode,
  type OrderLineRow,
  type OrderRow,
  PAID_STATUSES,
  type PaymentStatus,
  type RefundSource,
  type RefundStatus,
  SERVICE,
  SYSTEM,
  type StatusField,
  type StockStatus,
  TERMINAL,
  UNPAID_STATUSES,
} from './orders.types.js';

type Deps = Pick<Cradle, 'ordersRepository' | 'promotionsService' | 'logger'>;

interface Changes {
  status?: OrderRow['status'];
  paymentStatus?: PaymentStatus;
  stockStatus?: StockStatus;
  refundStatus?: RefundStatus;
}

const FIELD: Record<keyof Changes, StatusField> = {
  status: 'STATUS',
  paymentStatus: 'PAYMENT',
  stockStatus: 'STOCK',
  refundStatus: 'REFUND',
};

/** Holding stock now (a release is needed when the order closes). */
const HOLDS_STOCK: readonly StockStatus[] = ['PENDING', 'RESERVED', 'COMMITTED'];

const isTerminal = (o: OrderRow) => TERMINAL.includes(o.status);
const isPaid = (o: OrderRow) => PAID_STATUSES.includes(o.paymentStatus);

/** Event context: request / causing event, carried into every outbox event. */
export interface Ctx {
  correlationId: string;
  causationId?: string;
}

/**
 * Every order transition (docs/oms/03-state-machines.md). Each method runs INSIDE the caller's
 * transaction, locks the order row first, checks the expected state, writes the change + one
 * append-only status event per changed column, and writes side effects to the outbox. Stale or
 * duplicate events are no-ops, so redelivery and out-of-order delivery are safe.
 */
export class OrderLifecycle {
  constructor(private readonly deps: Deps) {}

  /** Writes the changed status columns (+ extra data) and their events. */
  async apply(
    tx: Tx,
    order: OrderRow,
    changes: Changes,
    actor: Actor,
    reason: { code?: string | null; note?: string | null } = {},
    data: Record<string, unknown> = {},
  ): Promise<OrderRow> {
    const events = (Object.keys(changes) as (keyof Changes)[])
      .filter((k) => changes[k] !== undefined && changes[k] !== order[k])
      .map((k) => ({ field: FIELD[k], from: order[k], to: changes[k] as string }));
    const updated = await this.deps.ordersRepository.update(tx, order.id, { ...changes, ...data });
    await this.deps.ordersRepository.addEvents(tx, order.id, actor, events, reason);
    return updated;
  }

  // ── Closing an order (fail; reject / cancel reuse this shape in P4) ──

  /**
   * FAILED: reverse offers, release stock (if any is held), refund if money was taken.
   * `stockTo` overrides the stock column (FAILED at checkout, REJECTED after a late payment).
   */
  async failInTx(
    tx: Tx,
    order: OrderRow,
    failureCode: FailureCode,
    actor: Actor,
    ctx: Ctx,
    o: { stockTo?: StockStatus; refundSource?: RefundSource; note?: string } = {},
  ): Promise<OrderRow> {
    if (isTerminal(order)) return order;
    await this.deps.promotionsService.reverseInTx(tx, order.id);
    const releases = HOLDS_STOCK.includes(order.stockStatus) && o.stockTo === undefined;
    const paymentStatus: PaymentStatus | undefined =
      failureCode === 'PAYMENT_NOT_COMPLETED' && UNPAID_STATUSES.includes(order.paymentStatus)
        ? 'EXPIRED'
        : undefined;
    let updated = await this.apply(
      tx,
      order,
      {
        status: 'FAILED',
        ...(o.stockTo !== undefined ? { stockStatus: o.stockTo } : {}),
        ...(releases ? { stockStatus: 'RELEASE_REQUESTED' as const } : {}),
        ...(paymentStatus !== undefined ? { paymentStatus } : {}),
      },
      actor,
      { code: failureCode, note: o.note ?? null },
      { failureCode, failedAt: new Date(), closeReasonCode: failureCode },
    );
    await emitOrderEvent(
      tx,
      ORDER_EVENTS.failed,
      {
        orderId: order.id,
        orderNo: order.orderNo,
        reservationId: order.reservationId,
        scope: 'FULL',
        lines: [],
        reasonCode: failureCode,
      },
      ctx.correlationId,
      ctx.causationId,
    );
    if (isPaid(order) && order.activePaymentId !== null)
      updated = await this.requestRefundInTx(tx, updated, {
        source: o.refundSource ?? 'FAIL',
        sourceRef: `fail:${order.id}`,
        paymentId: order.activePaymentId,
        amountPaise:
          toPaise(order.paidAmount.toFixed(2)) - toPaise(order.refundedAmount.toFixed(2)),
        reason: `Order ${order.orderNo} failed: ${failureCode}`,
        ctx,
      });
    return updated;
  }

  /** A refund DECISION (lifecycle A): stored + `order.refund_requested.v1` (payment executes). */
  async requestRefundInTx(
    tx: Tx,
    order: OrderRow,
    r: {
      source: RefundSource;
      sourceRef: string;
      paymentId: string;
      amountPaise: number;
      reason: string;
      ctx: Ctx;
      requestedBy?: string | null;
      isSystem?: boolean;
    },
  ): Promise<OrderRow> {
    if (r.amountPaise <= 0) return order;
    if ((await this.deps.ordersRepository.lockRefundRequest(tx, r.sourceRef)) !== null)
      return order;
    const isSystem = r.isSystem ?? true;
    await this.deps.ordersRepository.createRefundRequest(tx, {
      orderId: order.id,
      source: r.source,
      sourceRef: r.sourceRef,
      paymentId: r.paymentId,
      amount: fromPaise(r.amountPaise),
      reason: r.reason.slice(0, 300),
      isSystem,
      requestedBy: r.requestedBy ?? null,
    });
    await emitOrderEvent(
      tx,
      ORDER_EVENTS.refundRequested,
      {
        sourceRef: r.sourceRef,
        orderId: order.id,
        paymentId: r.paymentId,
        amountPaise: r.amountPaise,
        reason: r.reason.slice(0, 300),
        isSystem,
        requestedBy: r.requestedBy ?? null,
      },
      r.ctx.correlationId,
      r.ctx.causationId,
    );
    return this.apply(tx, order, { refundStatus: 'REQUESTED' }, SYSTEM, { code: r.source });
  }

  // ── Payment events ──

  async onPaymentCaptured(tx: Tx, d: PaymentCapturedV1, ctx: Ctx): Promise<void> {
    const order = await this.locked(tx, d.orderId);
    if (order === null || isPaid(order)) return;
    const paid = {
      paidAt: new Date(),
      paidAmount: fromPaise(d.amountPaise),
      activePaymentId: d.paymentId,
    };
    if (isTerminal(order)) {
      // R5: money truth is recorded, the order is NOT revived, the money goes back.
      const updated = await this.apply(
        tx,
        order,
        { paymentStatus: 'PAID' },
        SERVICE,
        { code: 'LATE_PAYMENT' },
        paid,
      );
      await this.requestRefundInTx(tx, updated, {
        source: 'LATE_PAYMENT',
        sourceRef: `late:${d.paymentId}`,
        paymentId: d.paymentId,
        amountPaise: d.amountPaise,
        reason: `Payment captured after order ${order.orderNo} closed (${order.status})`,
        ctx,
      });
      return;
    }
    const mismatch =
      d.amountPaise !== toPaise(order.grandTotal.toFixed(2)) || d.currency !== order.currency;
    if (mismatch)
      this.deps.logger.error(
        { orderId: order.id, expected: order.grandTotal.toFixed(2), captured: d.amountPaise },
        'captured amount differs from the order total (R8): confirm blocked',
      );
    await this.apply(
      tx,
      order,
      { paymentStatus: 'PAID' },
      SERVICE,
      mismatch ? { code: 'AMOUNT_MISMATCH' } : {},
      {
        ...paid,
        ...(mismatch ? { paymentException: 'AMOUNT_MISMATCH' } : {}),
      },
    );
    // Stock is committed even on a mismatch (protects it); the admin then rejects + refunds.
    await emitOrderEvent(
      tx,
      ORDER_EVENTS.paid,
      {
        orderId: order.id,
        orderNo: order.orderNo,
        reservationId: order.reservationId,
        paymentId: d.paymentId,
        amount: fromPaise(d.amountPaise),
      },
      ctx.correlationId,
      ctx.causationId,
    );
  }

  async onPaymentFailed(tx: Tx, d: PaymentFailedV1): Promise<void> {
    const order = await this.locked(tx, d.orderId);
    if (order === null || isTerminal(order) || order.paymentStatus !== 'PENDING') return;
    await this.apply(tx, order, { paymentStatus: 'FAILED' }, SERVICE, {
      code: d.errorCode,
      note: d.errorReason,
    });
  }

  /** payment-service already re-checked the gateway before expiring: the order FAILS. */
  async onPaymentExpired(tx: Tx, d: PaymentExpiredV1, ctx: Ctx): Promise<void> {
    const order = await this.locked(tx, d.orderId);
    if (order === null || isTerminal(order) || !UNPAID_STATUSES.includes(order.paymentStatus))
      return;
    await this.failInTx(tx, order, 'PAYMENT_NOT_COMPLETED', SERVICE, ctx);
  }

  // ── Stock events ──

  async onReservationCommitted(tx: Tx, d: ReservationCommittedV1, ctx: Ctx): Promise<void> {
    const order = await this.locked(tx, d.orderRef);
    if (order === null) return;
    if (isTerminal(order)) {
      // Closed meanwhile: whatever was committed must go back.
      if (order.stockStatus === 'RELEASED') return;
      await this.apply(tx, order, { stockStatus: 'RELEASE_REQUESTED' }, SERVICE, {
        code: 'ORDER_CLOSED',
      });
      await emitOrderEvent(
        tx,
        ORDER_EVENTS.failed,
        {
          orderId: order.id,
          orderNo: order.orderNo,
          reservationId: d.reservationId,
          scope: 'FULL',
          lines: [],
          reasonCode: 'ORDER_CLOSED',
        },
        ctx.correlationId,
        ctx.causationId,
      );
      return;
    }
    if (order.stockStatus === 'COMMITTED') return;
    await this.apply(
      tx,
      order,
      { stockStatus: 'COMMITTED' },
      SERVICE,
      { code: d.recovered ? 'RECOVERED_AFTER_EXPIRY' : null },
      { reservationId: d.reservationId },
    );
  }

  /** R4: paid after the hold expired and the stock is gone → FAILED + full refund. */
  async onReservationRejected(tx: Tx, d: ReservationRejectedV1, ctx: Ctx): Promise<void> {
    const order = await this.locked(tx, d.orderRef);
    if (order === null || isTerminal(order)) return;
    await this.failInTx(tx, order, 'STOCK_UNAVAILABLE_AFTER_PAYMENT', SERVICE, ctx, {
      stockTo: 'REJECTED',
      refundSource: 'STOCK_REJECTED',
      note: `Short: ${d.shortfall.map((s) => `${s.variantId} ${String(s.available)}/${String(s.requested)}`).join(', ')}`,
    });
  }

  async onReservationReleased(tx: Tx, d: ReservationReleasedV1): Promise<void> {
    const order = await this.locked(tx, d.orderRef);
    if (order === null || d.scope !== 'FULL' || order.stockStatus === 'RELEASED') return;
    await this.apply(tx, order, { stockStatus: 'RELEASED' }, SERVICE);
  }

  // ── Refund events (lifecycle A follows lifecycle B) ──

  async onRefundInitiated(tx: Tx, d: RefundInitiatedV1): Promise<void> {
    const rr = await this.deps.ordersRepository.lockRefundRequest(tx, d.sourceRef);
    if (rr === null || !['REQUESTED', 'RETRY_REQUESTED', 'FAILED'].includes(rr.status)) return;
    await this.deps.ordersRepository.updateRefundRequest(tx, rr.id, {
      status: 'ACCEPTED',
      paymentRefundId: d.refundId,
      providerRefundId: d.providerRefundId,
      expectedBy: new Date(d.expectedBy),
    });
    const order = await this.locked(tx, rr.orderId);
    if (order !== null) await this.apply(tx, order, { refundStatus: 'IN_PROGRESS' }, SERVICE);
  }

  async onRefundProcessed(tx: Tx, d: RefundProcessedV1): Promise<void> {
    const rr = await this.deps.ordersRepository.lockRefundRequest(tx, d.sourceRef);
    if (rr === null || rr.status === 'COMPLETED') return;
    await this.deps.ordersRepository.updateRefundRequest(tx, rr.id, {
      status: 'COMPLETED',
      completedAt: new Date(),
      arn: d.arn,
      paymentRefundId: d.refundId,
    });
    const order = await this.locked(tx, rr.orderId);
    if (order === null) return;
    const open = (await this.deps.ordersRepository.refundRequests(order.id, tx)).filter(
      (r) => r.id !== rr.id && !['COMPLETED', 'MANUALLY_RESOLVED'].includes(r.status),
    );
    const fully = d.refundedPaise >= d.capturedPaise;
    await this.apply(
      tx,
      order,
      {
        paymentStatus: fully ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
        refundStatus: open.length > 0 ? 'IN_PROGRESS' : fully ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
      },
      SERVICE,
      { code: 'REFUND_COMPLETED' },
      { refundedAmount: fromPaise(d.refundedPaise) },
    );
  }

  async onRefundFailed(tx: Tx, d: RefundFailedV1): Promise<void> {
    const rr = await this.deps.ordersRepository.lockRefundRequest(tx, d.sourceRef);
    if (rr === null || rr.status === 'COMPLETED' || rr.status === 'MANUALLY_RESOLVED') return;
    await this.deps.ordersRepository.updateRefundRequest(tx, rr.id, {
      status: 'FAILED',
      failureReason: d.reason.slice(0, 300),
    });
    const order = await this.locked(tx, rr.orderId);
    if (order !== null)
      await this.apply(tx, order, { refundStatus: 'ACTION_REQUIRED' }, SERVICE, {
        code: 'REFUND_FAILED',
        note: d.reason,
      });
  }

  // ── Admin decisions + cancellation (P4) ──

  /** Paid + committed + no exception → CONFIRMED → order.confirmed.v1 (shipments / invoice later). */
  async confirmInTx(
    tx: Tx,
    order: OrderRow,
    lines: readonly OrderLineRow[],
    staffId: string,
    ctx: Ctx,
    note?: string,
  ): Promise<OrderRow> {
    const blocked =
      order.status !== 'PENDING_ADMIN_CONFIRMATION'
        ? 'NOT_PENDING'
        : !isPaid(order)
          ? 'NOT_PAID'
          : order.paymentException !== null
            ? 'PAYMENT_EXCEPTION'
            : order.stockStatus !== 'COMMITTED'
              ? 'STOCK_NOT_COMMITTED'
              : null;
    if (blocked !== null)
      throw new ConflictError(`Cannot confirm: ${blocked}`, {
        details: {
          reason: blocked,
          status: order.status,
          paymentStatus: order.paymentStatus,
          stockStatus: order.stockStatus,
          paymentException: order.paymentException,
        },
      });
    const now = new Date();
    const updated = await this.apply(
      tx,
      order,
      { status: 'CONFIRMED' },
      { type: 'STAFF', id: staffId },
      { code: 'CONFIRMED', note: note ?? null },
      { confirmedAt: now, confirmedBy: staffId },
    );
    await emitOrderEvent(
      tx,
      ORDER_EVENTS.confirmed,
      {
        orderId: order.id,
        orderNo: order.orderNo,
        reservationId: order.reservationId,
        confirmedAt: now.toISOString(),
        lines: lines
          .filter((l) => l.qty - l.cancelledQty > 0)
          .map((l) => ({ lineNo: l.lineNo, variantId: l.variantId, qty: l.qty - l.cancelledQty })),
      },
      ctx.correlationId,
      ctx.causationId,
    );
    return updated;
  }

  /**
   * REJECTED / CANCELLED (whole order): offers reversed, stock released, everything still
   * refundable goes back (docs/oms §3A.2 — one transaction, side effects via the outbox).
   */
  async closeInTx(
    tx: Tx,
    order: OrderRow,
    c: {
      to: 'REJECTED' | 'CANCELLED';
      actor: Actor;
      reasonCode: string;
      reason: string | null;
      refundPaise: number;
      refundSource: RefundSource;
      refundSourceRef: string;
      refundIsSystem: boolean;
      ctx: Ctx;
    },
  ): Promise<OrderRow> {
    if (isTerminal(order))
      throw new ConflictError(`Order is already ${order.status}`, {
        details: { reason: 'ALREADY_CLOSED', status: order.status },
      });
    await this.deps.promotionsService.reverseInTx(tx, order.id);
    const now = new Date();
    let updated = await this.apply(
      tx,
      order,
      {
        status: c.to,
        ...(HOLDS_STOCK.includes(order.stockStatus)
          ? { stockStatus: 'RELEASE_REQUESTED' as const }
          : {}),
      },
      c.actor,
      { code: c.reasonCode, note: c.reason },
      {
        closeReasonCode: c.reasonCode,
        closeReason: c.reason?.slice(0, 500) ?? null,
        ...(c.to === 'REJECTED'
          ? { rejectedAt: now, rejectedBy: c.actor.id }
          : { cancelledAt: now, cancelledBy: c.actor.id }),
      },
    );
    await emitOrderEvent(
      tx,
      c.to === 'REJECTED' ? ORDER_EVENTS.rejected : ORDER_EVENTS.cancelled,
      {
        orderId: order.id,
        orderNo: order.orderNo,
        reservationId: order.reservationId,
        scope: 'FULL',
        lines: [],
        reasonCode: c.reasonCode,
      },
      c.ctx.correlationId,
      c.ctx.causationId,
    );
    if (isPaid(order) && order.activePaymentId !== null && c.refundPaise > 0)
      updated = await this.requestRefundInTx(tx, updated, {
        source: c.refundSource,
        sourceRef: c.refundSourceRef,
        paymentId: order.activePaymentId,
        amountPaise: c.refundPaise,
        reason: `${c.to === 'REJECTED' ? 'Rejected' : 'Cancelled'}: ${c.reasonCode}`,
        ctx: c.ctx,
        requestedBy: c.actor.type === 'STAFF' ? c.actor.id : null,
        isSystem: c.refundIsSystem,
      });
    return updated;
  }

  /** Partial cancel: lines shrink, the order stays; only the cancelled units are released. */
  async partialCancelInTx(
    tx: Tx,
    order: OrderRow,
    c: {
      items: readonly CancelItem[];
      actor: Actor;
      reasonCode: string;
      refundPaise: number;
      refundSourceRef: string;
      refundIsSystem: boolean;
      ctx: Ctx;
    },
  ): Promise<OrderRow> {
    await this.deps.ordersRepository.addEvents(
      tx,
      order.id,
      c.actor,
      [{ field: 'ITEMS', from: null, to: 'PARTIALLY_CANCELLED' }],
      {
        code: c.reasonCode,
        note: c.items.map((i) => `line ${String(i.lineNo)} -${String(i.qty)}`).join(', '),
      },
    );
    let updated = await this.deps.ordersRepository.update(tx, order.id, {});
    await emitOrderEvent(
      tx,
      ORDER_EVENTS.cancelled,
      {
        orderId: order.id,
        orderNo: order.orderNo,
        reservationId: order.reservationId,
        scope: 'PARTIAL',
        lines: c.items.map((i) => ({ variantId: i.variantId, qty: i.qty })),
        reasonCode: c.reasonCode,
      },
      c.ctx.correlationId,
      c.ctx.causationId,
    );
    if (isPaid(order) && order.activePaymentId !== null && c.refundPaise > 0)
      updated = await this.requestRefundInTx(tx, updated, {
        source: 'CANCEL',
        sourceRef: c.refundSourceRef,
        paymentId: order.activePaymentId,
        amountPaise: c.refundPaise,
        reason: `Partial cancel: ${c.reasonCode}`,
        ctx: c.ctx,
        requestedBy: c.actor.type === 'STAFF' ? c.actor.id : null,
        isSystem: c.refundIsSystem,
      });
    return updated;
  }

  /** Paid minus every refund already decided (a FAILED one will be retried, so it counts). */
  async refundablePaise(tx: Tx, order: OrderRow): Promise<number> {
    const decided = (await this.deps.ordersRepository.refundRequests(order.id, tx)).reduce(
      (n, r) => n + toPaise(r.amount.toFixed(2)),
      0,
    );
    return Math.max(0, toPaise(order.paidAmount.toFixed(2)) - decided);
  }

  private async locked(tx: Tx, orderId: string): Promise<OrderRow | null> {
    const order = await this.deps.ordersRepository.lock(tx, orderId);
    if (order === null) this.deps.logger.warn({ orderId }, 'event for an unknown order; ignored');
    return order;
  }
}
