import { ConflictError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import { uuidv7 } from '../../adapters/uuid.js';
import type { Actor as AuditActor } from '../audit/index.js';
import { fromPaise, toPaise } from '../pricing/index.js';
import { type CancelPlan, planCancellation, refundFor } from './orders.cancellation.js';
import type { Ctx } from './orders.lifecycle.js';
import {
  type Actor,
  type CancelInput,
  type OrderRow,
  type OrderWithLines,
  PAID_STATUSES,
} from './orders.types.js';

type Deps = Pick<
  Cradle,
  'ordersRepository' | 'orderLifecycle' | 'runInTransaction' | 'settingsService' | 'auditService'
>;

/** Orders that can still be cancelled (F1 adds "until the first shipment is picked"). */
const CANCELLABLE = ['PENDING_ADMIN_CONFIRMATION', 'CONFIRMED'];

export interface CancellationQuote {
  eligible: boolean;
  reason: string | null;
  full: boolean;
  freeWindowEndsAt: Date;
  fee: string;
  refundAmount: string;
  lines: { lineNo: number; variantId: string; qty: number; refund: string }[];
}

const linesOf = (o: OrderWithLines) =>
  o.lines.map((l) => ({
    lineNo: l.lineNo,
    variantId: l.variantId,
    qty: l.qty,
    cancelledQty: l.cancelledQty,
    lineTotalPaise: toPaise(l.lineTotal.toFixed(2)),
  }));

/**
 * Buyer + staff cancellation (full or by item). One transaction under the order row lock: lines
 * shrink, a cancellation record is written, then either the whole order closes (offers reversed,
 * stock released, refund of everything still refundable) or only the cancelled units are released
 * and refunded from what was paid per line.
 */
export class OrderCancelService {
  constructor(private readonly deps: Deps) {}

  /** What a cancel would do now (no change). */
  async quote(
    order: OrderWithLines,
    input: Pick<CancelInput, 'lines'>,
    actor: Actor,
  ): Promise<CancellationQuote> {
    const settings = await this.deps.settingsService.current();
    const freeWindowEndsAt = new Date(
      order.placedAt.getTime() + settings.freeCancelMinutes * 60_000,
    );
    const empty = { full: false, freeWindowEndsAt, fee: '0.00', refundAmount: '0.00', lines: [] };
    const why = this.blocker(order);
    if (why !== null) return { eligible: false, reason: why, ...empty };
    const plan = planCancellation(linesOf(order), input.lines);
    if (!plan.ok)
      return { eligible: false, reason: plan.issues.map((i) => i.message).join('; '), ...empty };
    if (!plan.full && !this.paid(order))
      return {
        eligible: false,
        reason: 'An unpaid order can only be cancelled as a whole',
        ...empty,
      };
    const refund = this.money(order, plan, settings, actor, await this.decidedPaise(order));
    return {
      eligible: true,
      reason: null,
      full: plan.full,
      freeWindowEndsAt,
      fee: fromPaise(refund.fee),
      refundAmount: fromPaise(refund.net),
      lines: plan.items.map((i) => ({
        lineNo: i.lineNo,
        variantId: i.variantId,
        qty: i.qty,
        refund: fromPaise(i.refundPaise),
      })),
    };
  }

  async cancel(
    orderId: string,
    input: CancelInput,
    actor: Actor,
    o: { ctx: Ctx; expectedVersion?: number; key?: string; hash?: string; audit?: AuditActor },
  ): Promise<OrderRow> {
    const settings = await this.deps.settingsService.current();
    return this.deps.runInTransaction(async (tx) => {
      const repo = this.deps.ordersRepository;
      const locked = await repo.lock(tx, orderId);
      if (locked === null) throw new NotFoundError('Order');
      if (o.expectedVersion !== undefined && locked.version !== o.expectedVersion)
        throw new ConflictError('The order changed; reload and retry', {
          details: { reason: 'VERSION_CONFLICT', currentVersion: locked.version },
        });
      const order = await repo.find(orderId, tx);
      if (order === null) throw new NotFoundError('Order');
      const why = this.blocker(order);
      if (why !== null)
        throw new ConflictError(why, {
          details: { reason: 'NOT_CANCELLABLE', status: order.status },
        });
      const plan = planCancellation(linesOf(order), input.lines);
      if (!plan.ok) throw new ValidationError(plan.issues, 'Nothing valid to cancel');
      if (!plan.full && !this.paid(order))
        throw new ValidationError(
          [{ path: 'body.lines', message: 'an unpaid order can only be cancelled as a whole' }],
          'Cancel the whole order while it is unpaid',
        );
      const refund = this.money(order, plan, settings, actor, await this.decidedPaise(order, tx));
      const cancellationId = uuidv7();
      await repo.cancelLines(tx, order.id, plan.items);
      await repo.createCancellation(tx, {
        id: cancellationId,
        orderId: order.id,
        scope: plan.full ? 'FULL' : 'PARTIAL',
        lines: plan.items.map((i) => ({ ...i, refund: fromPaise(i.refundPaise) })),
        reasonCode: input.reasonCode,
        note: input.note ?? null,
        stage: order.status,
        fee: fromPaise(refund.fee),
        refundAmount: fromPaise(refund.net),
        actorType: actor.type,
        requestedBy: actor.id,
        idempotencyKey: o.key ?? null,
        requestHash: o.hash ?? null,
      });
      const common = {
        actor,
        reasonCode: input.reasonCode,
        refundPaise: refund.net,
        refundSourceRef: `cancel:${cancellationId}`,
        // Buyer cancellations within policy refund automatically; staff ones may need approval.
        refundIsSystem: actor.type === 'CUSTOMER',
        ctx: o.ctx,
      };
      const after = plan.full
        ? await this.deps.orderLifecycle.closeInTx(tx, order, {
            ...common,
            to: 'CANCELLED',
            reason: input.note ?? null,
            refundSource: 'CANCEL',
          })
        : await this.deps.orderLifecycle.partialCancelInTx(tx, order, {
            ...common,
            items: plan.items,
          });
      if (o.audit !== undefined)
        await this.deps.auditService.record(tx, o.audit, {
          action: plan.full ? 'order.cancel' : 'order.cancel_items',
          targetType: 'order',
          targetId: order.id,
          before: { status: order.status },
          after: {
            status: after.status,
            items: plan.items,
            refund: fromPaise(refund.net),
            fee: fromPaise(refund.fee),
          },
          reason: input.note ?? input.reasonCode,
        });
      return after;
    });
  }

  private blocker(order: OrderRow): string | null {
    return CANCELLABLE.includes(order.status)
      ? null
      : `Order is ${order.status} and can no longer be cancelled`;
  }

  private paid(order: OrderRow): boolean {
    return PAID_STATUSES.includes(order.paymentStatus);
  }

  private async decidedPaise(order: OrderRow, tx?: Tx): Promise<number> {
    if (tx !== undefined) return this.deps.orderLifecycle.refundablePaise(tx, order);
    const decided = (await this.deps.ordersRepository.refundRequests(order.id)).reduce(
      (n, r) => n + toPaise(r.amount.toFixed(2)),
      0,
    );
    return Math.max(0, toPaise(order.paidAmount.toFixed(2)) - decided);
  }

  private money(
    order: OrderRow,
    plan: Extract<CancelPlan, { ok: true }>,
    settings: { freeCancelMinutes: number; cancellationFeePercent: number },
    actor: Actor,
    refundablePaise: number,
  ) {
    const afterWindow = Date.now() > order.placedAt.getTime() + settings.freeCancelMinutes * 60_000;
    return refundFor({
      full: plan.full,
      itemsRefundPaise: plan.itemsRefundPaise,
      refundablePaise: this.paid(order) ? refundablePaise : 0,
      feePercent: settings.cancellationFeePercent,
      chargeFee: actor.type === 'CUSTOMER' && afterWindow,
    });
  }
}
