import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@farmx/common/errors';
import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import { ORDER_EVENTS } from '@farmx/infra/events';
import { orderKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

import { emitOrderEvent } from '../../adapters/events.js';
import type { Actor as AuditActor } from '../audit/index.js';
import { fromPaise, toPaise } from '../pricing/index.js';
import type { OrderSettings, SettingsPatch } from '../settings/index.js';
import type { CancellationQuote } from './orders.cancel.service.js';
import type { Ctx } from './orders.lifecycle.js';
import {
  type AdminOrderQuery,
  type CancelInput,
  type ExceptionType,
  type NoteRow,
  type OrderRow,
  type OrderWithLines,
  PAID_STATUSES,
  SYSTEM,
} from './orders.types.js';
import { type OrderDetailView, type OrderSummaryView, toDetail, toSummary } from './orders.views.js';

type Deps = Pick<
  Cradle,
  | 'ordersRepository'
  | 'orderLifecycle'
  | 'orderCancelService'
  | 'runInTransaction'
  | 'settingsService'
  | 'auditService'
  | 'redis'
  | 'logger'
>;

export interface AdminOrderView extends OrderDetailView {
  userId: string;
  farmId: string;
  version: number;
  confirmedBy: string | null;
  rejectedBy: string | null;
  cancelledBy: string | null;
  closeReasonCode: string | null;
  closeReason: string | null;
  notes: NoteRow[];
  /** Timeline with WHO (staff ids) — never shown to buyers. */
  history: { field: string; from: string | null; to: string; actorType: string; actorId: string | null; reasonCode: string | null; note: string | null; at: Date }[];
}

export interface QueueItem extends OrderSummaryView {
  paidAt: Date | null;
  waitingMinutes: number;
  overdue: boolean;
}

const STATS_TTL_S = 30;
const JOB_BATCH = 50;
const STALE_RELEASE_MS = 15 * 60_000;
const STALE_REFUND_MS = 10 * 60_000;

const staff = (a: AuditActor) => ({ type: 'STAFF' as const, id: a.userId });
const versionConflict = (current: number) =>
  new ConflictError('The order changed; reload and retry', {
    details: { reason: 'VERSION_CONFLICT', currentVersion: current },
  });

/**
 * Manager console for orders (docs/oms 05-api, D-34/D-35/D-41/D-45): review queue, confirm /
 * reject / bulk, cancel, notes, refund recovery (retry, offline), exception queues, settings and
 * the review-SLA + recovery-watch jobs. Every decision: order row lock + expectedVersion + status
 * event + audit row + outbox, in one transaction.
 */
export class OrdersAdminService {
  constructor(private readonly deps: Deps) {}

  // ── Reads ──

  async list(query: AdminOrderQuery): Promise<Paginated<OrderSummaryView>> {
    const page = await this.deps.ordersRepository.adminList(query);
    return { ...page, items: page.items.map(toSummary) };
  }

  async reviewQueue(): Promise<QueueItem[]> {
    const { adminReviewSlaHours } = await this.deps.settingsService.current();
    const now = Date.now();
    return (await this.deps.ordersRepository.reviewQueue(200)).map((o) => {
      const waitingMinutes = o.paidAt === null ? 0 : Math.floor((now - o.paidAt.getTime()) / 60_000);
      return { ...toSummary(o), paidAt: o.paidAt, waitingMinutes, overdue: waitingMinutes >= adminReviewSlaHours * 60 };
    });
  }

  /** Dashboard counters (Redis 30 s; fail-open to the database). */
  async stats() {
    const key = orderKeys.adminStats();
    try {
      const hit = await this.deps.redis.get(key);
      if (hit !== null) return JSON.parse(hit) as unknown;
    } catch (err) {
      this.deps.logger.warn({ err }, 'stats cache unavailable');
    }
    const { adminReviewSlaHours } = await this.deps.settingsService.current();
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const value = await this.deps.ordersRepository.stats(
      dayStart,
      new Date(Date.now() - adminReviewSlaHours * 3_600_000),
    );
    await this.deps.redis.set(key, JSON.stringify(value), 'EX', STATS_TTL_S).catch(() => undefined);
    return value;
  }

  async exceptions(type: ExceptionType): Promise<OrderSummaryView[]> {
    return (
      await this.deps.ordersRepository.exceptions(type, new Date(Date.now() - STALE_RELEASE_MS), 200)
    ).map(toSummary);
  }

  async detail(id: string): Promise<AdminOrderView> {
    const o = await this.mustFind(id);
    const [events, refunds, notes] = await Promise.all([
      this.deps.ordersRepository.events(id),
      this.deps.ordersRepository.refundRequests(id),
      this.deps.ordersRepository.notes(id),
    ]);
    return {
      ...toDetail(o, events, refunds),
      userId: o.userId,
      farmId: o.farmId,
      version: o.version,
      confirmedBy: o.confirmedBy,
      rejectedBy: o.rejectedBy,
      cancelledBy: o.cancelledBy,
      closeReasonCode: o.closeReasonCode,
      closeReason: o.closeReason,
      notes,
      history: events.map((e) => ({
        field: e.field,
        from: e.fromValue,
        to: e.toValue,
        actorType: e.actorType,
        actorId: e.actorId,
        reasonCode: e.reasonCode,
        note: e.note,
        at: e.at,
      })),
    };
  }

  // ── Decisions ──

  async confirm(actor: AuditActor, id: string, input: { expectedVersion?: number; note?: string }, ctx: Ctx): Promise<AdminOrderView> {
    await this.deps.runInTransaction(async (tx) => {
      const order = await this.lockedAt(tx, id, input.expectedVersion);
      const lines = (await this.deps.ordersRepository.find(id, tx))?.lines ?? [];
      await this.deps.orderLifecycle.confirmInTx(tx, order, lines, actor.userId, ctx, input.note);
      await this.deps.auditService.record(tx, actor, {
        action: 'order.confirm',
        targetType: 'order',
        targetId: id,
        before: { status: order.status },
        after: { status: 'CONFIRMED' },
        reason: input.note ?? null,
      });
    });
    return this.detail(id);
  }

  /** Reject: stock released, everything still refundable goes back automatically (D-35). */
  async reject(
    actor: AuditActor,
    id: string,
    input: { expectedVersion: number; reasonCode: string; reason: string },
    ctx: Ctx,
  ): Promise<AdminOrderView> {
    await this.deps.runInTransaction(async (tx) => {
      const order = await this.lockedAt(tx, id, input.expectedVersion);
      if (order.status !== 'PENDING_ADMIN_CONFIRMATION')
        throw new ConflictError(`Only orders awaiting confirmation can be rejected (${order.status})`, {
          details: { reason: 'NOT_PENDING', status: order.status },
        });
      await this.deps.orderLifecycle.closeInTx(tx, order, {
        to: 'REJECTED',
        actor: staff(actor),
        reasonCode: input.reasonCode,
        reason: input.reason,
        refundPaise: await this.deps.orderLifecycle.refundablePaise(tx, order),
        refundSource: 'REJECT',
        refundSourceRef: `reject:${id}`,
        refundIsSystem: true,
        ctx,
      });
      await this.deps.auditService.record(tx, actor, {
        action: 'order.reject',
        targetType: 'order',
        targetId: id,
        before: { status: order.status, paymentStatus: order.paymentStatus },
        after: { status: 'REJECTED', reasonCode: input.reasonCode },
        reason: input.reason,
      });
    });
    return this.detail(id);
  }

  /** Each order in its own transaction: one failure never blocks the others. */
  async bulkConfirm(actor: AuditActor, ids: readonly string[], ctx: Ctx) {
    const { maxBulkConfirm } = await this.deps.settingsService.current();
    if (ids.length > maxBulkConfirm)
      throw new ValidationError([{ path: 'body.orderIds', message: `at most ${String(maxBulkConfirm)}` }]);
    const results: { orderId: string; ok: boolean; reason: string | null }[] = [];
    for (const id of new Set(ids)) {
      try {
        await this.confirm(actor, id, {}, ctx);
        results.push({ orderId: id, ok: true, reason: null });
      } catch (err) {
        const reason =
          (err as { details?: { reason?: string } }).details?.reason ??
          (err instanceof NotFoundError ? 'NOT_FOUND' : 'ERROR');
        results.push({ orderId: id, ok: false, reason });
      }
    }
    return { confirmed: results.filter((r) => r.ok).length, results };
  }

  async cancel(
    actor: AuditActor,
    id: string,
    input: CancelInput & { expectedVersion: number },
    ctx: Ctx,
  ): Promise<AdminOrderView> {
    const { expectedVersion, ...cancel } = input;
    await this.deps.orderCancelService.cancel(id, cancel, staff(actor), { ctx, expectedVersion, audit: actor });
    return this.detail(id);
  }

  quoteCancel(id: string, lines: CancelInput['lines'], actor: AuditActor): Promise<CancellationQuote> {
    return this.mustFind(id).then((o) => this.deps.orderCancelService.quote(o, { lines }, staff(actor)));
  }

  async addNote(actor: AuditActor, id: string, body: string): Promise<NoteRow> {
    await this.mustFind(id);
    return this.deps.ordersRepository.addNote(id, actor.userId, body);
  }

  notes(id: string): Promise<NoteRow[]> {
    return this.deps.ordersRepository.notes(id);
  }

  // ── Refund recovery (lifecycle A) ──

  /** FAILED → RETRY_REQUESTED: the SAME decision is re-sent (payment retries the same refund). */
  async retryRefund(actor: AuditActor, orderId: string, refundId: string, reason: string, ctx: Ctx): Promise<AdminOrderView> {
    await this.deps.runInTransaction(async (tx) => {
      const rr = await this.deps.ordersRepository.lockRefundRequestById(tx, refundId);
      if (rr?.orderId !== orderId) throw new NotFoundError('Refund');
      if (rr.status !== 'FAILED')
        throw new ConflictError(`Refund is ${rr.status}`, { details: { reason: 'NOT_FAILED', status: rr.status } });
      await this.deps.ordersRepository.updateRefundRequest(tx, rr.id, { status: 'RETRY_REQUESTED', failureReason: null });
      await emitOrderEvent(
        tx,
        ORDER_EVENTS.refundRequested,
        {
          sourceRef: rr.sourceRef,
          orderId,
          paymentId: rr.paymentId,
          amountPaise: toPaise(rr.amount.toFixed(2)),
          reason: rr.reason,
          isSystem: rr.isSystem,
          requestedBy: rr.requestedBy,
        },
        ctx.correlationId,
      );
      const order = await this.deps.ordersRepository.lock(tx, orderId);
      if (order !== null)
        await this.deps.orderLifecycle.apply(tx, order, { refundStatus: 'IN_PROGRESS' }, staff(actor), { code: 'REFUND_RETRY' });
      await this.deps.auditService.record(tx, actor, {
        action: 'order.refund_retry',
        targetType: 'order',
        targetId: orderId,
        before: { refund: rr.id, status: 'FAILED' },
        after: { status: 'RETRY_REQUESTED' },
        reason,
      });
    });
    return this.detail(orderId);
  }

  /** Refunded outside the gateway (bank transfer). SoD: never the person who decided it. */
  async resolveOffline(
    actor: AuditActor,
    orderId: string,
    refundId: string,
    input: { reason: string; bankReference: string },
  ): Promise<AdminOrderView> {
    await this.deps.runInTransaction(async (tx) => {
      const rr = await this.deps.ordersRepository.lockRefundRequestById(tx, refundId);
      if (rr?.orderId !== orderId) throw new NotFoundError('Refund');
      if (rr.status !== 'FAILED')
        throw new ConflictError(`Only a FAILED refund can be resolved offline (${rr.status})`, {
          details: { reason: 'NOT_FAILED', status: rr.status },
        });
      if (rr.requestedBy !== null && rr.requestedBy === actor.userId)
        throw new ForbiddenError('An offline refund must be resolved by someone other than its requester');
      await this.deps.ordersRepository.updateRefundRequest(tx, rr.id, {
        status: 'MANUALLY_RESOLVED',
        resolvedBy: actor.userId,
        resolutionRef: input.bankReference,
        completedAt: new Date(),
      });
      const order = await this.deps.ordersRepository.lock(tx, orderId);
      if (order === null) throw new NotFoundError('Order');
      const refunded = toPaise(order.refundedAmount.toFixed(2)) + toPaise(rr.amount.toFixed(2));
      const paid = toPaise(order.paidAmount.toFixed(2));
      const open = (await this.deps.ordersRepository.refundRequests(orderId, tx)).filter(
        (r) => r.id !== rr.id && !['COMPLETED', 'MANUALLY_RESOLVED'].includes(r.status),
      );
      await this.deps.orderLifecycle.apply(
        tx,
        order,
        {
          paymentStatus: refunded >= paid ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          refundStatus: open.length > 0 ? 'IN_PROGRESS' : refunded >= paid ? 'COMPLETED' : 'PARTIALLY_COMPLETED',
        },
        staff(actor),
        { code: 'REFUND_OFFLINE', note: input.bankReference },
        { refundedAmount: fromPaise(Math.min(refunded, paid)) },
      );
      await this.deps.auditService.record(tx, actor, {
        action: 'order.refund_offline',
        targetType: 'order',
        targetId: orderId,
        before: { refund: rr.id, status: 'FAILED' },
        after: { status: 'MANUALLY_RESOLVED', bankReference: input.bankReference },
        reason: input.reason,
      });
    });
    return this.detail(orderId);
  }

  // ── Settings ──

  settings(): Promise<OrderSettings> {
    return this.deps.settingsService.current();
  }

  updateSettings(actor: AuditActor, patch: SettingsPatch): Promise<OrderSettings> {
    return this.deps.settingsService.update(actor, patch);
  }

  // ── Jobs ──

  /** SLA alert once per order; auto-reject (+ refund) when configured (adminAutoRejectHours > 0). */
  async reviewSla(): Promise<{ overdue: number; autoRejected: number }> {
    const s = await this.deps.settingsService.current();
    const now = Date.now();
    let overdue = 0;
    for (const o of await this.deps.ordersRepository.overdueReviews(new Date(now - s.adminReviewSlaHours * 3_600_000), JOB_BATCH)) {
      await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.ordersRepository.lock(tx, o.id);
        if (locked?.status !== 'PENDING_ADMIN_CONFIRMATION' || locked.reviewOverdueAt !== null) return;
        await this.deps.ordersRepository.update(tx, o.id, { reviewOverdueAt: new Date() });
        await emitOrderEvent(
          tx,
          ORDER_EVENTS.reviewOverdue,
          {
            orderId: o.id,
            orderNo: o.orderNo,
            waitingMinutes: o.paidAt === null ? 0 : Math.floor((now - o.paidAt.getTime()) / 60_000),
          },
          `review-sla:${o.id}`,
        );
        overdue += 1;
      });
    }
    let autoRejected = 0;
    if (s.adminAutoRejectHours > 0)
      for (const o of await this.deps.ordersRepository.autoRejectCandidates(new Date(now - s.adminAutoRejectHours * 3_600_000), JOB_BATCH)) {
        const done = await this.deps.runInTransaction(async (tx) => {
          const locked = await this.deps.ordersRepository.lock(tx, o.id);
          if (locked?.status !== 'PENDING_ADMIN_CONFIRMATION' || !PAID_STATUSES.includes(locked.paymentStatus)) return false;
          await this.deps.orderLifecycle.closeInTx(tx, locked, {
            to: 'REJECTED',
            actor: SYSTEM,
            reasonCode: 'REVIEW_TIMEOUT',
            reason: `Not reviewed within ${String(s.adminAutoRejectHours)} h`,
            refundPaise: await this.deps.orderLifecycle.refundablePaise(tx, locked),
            refundSource: 'AUTO_REJECT',
            refundSourceRef: `reject:${o.id}`,
            refundIsSystem: true,
            ctx: { correlationId: `auto-reject:${o.id}` },
          });
          return true;
        });
        if (done) autoRejected += 1;
      }
    return { overdue, autoRejected };
  }

  /**
   * Side effects that did not land (docs/oms §3A.2): re-send the SAME release / refund decision
   * (consumers are idempotent) and push the row's clock so it is retried every 15 / 10 minutes.
   */
  async recoveryWatch(): Promise<{ releases: number; refunds: number }> {
    const now = Date.now();
    const releases = await this.deps.ordersRepository.staleReleases(new Date(now - STALE_RELEASE_MS), JOB_BATCH);
    for (const o of releases)
      await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.ordersRepository.lock(tx, o.id);
        if (locked?.stockStatus !== 'RELEASE_REQUESTED') return;
        await emitOrderEvent(
          tx,
          locked.status === 'REJECTED' ? ORDER_EVENTS.rejected : locked.status === 'CANCELLED' ? ORDER_EVENTS.cancelled : ORDER_EVENTS.failed,
          {
            orderId: locked.id,
            orderNo: locked.orderNo,
            reservationId: locked.reservationId,
            scope: 'FULL',
            lines: [],
            reasonCode: 'RELEASE_RETRY',
          },
          `recovery-watch:${locked.id}`,
        );
        await this.deps.ordersRepository.update(tx, locked.id, {});
      });
    const refunds = await this.deps.ordersRepository.staleRefundRequests(new Date(now - STALE_REFUND_MS), JOB_BATCH);
    for (const rr of refunds)
      await this.deps.runInTransaction(async (tx) => {
        const locked = await this.deps.ordersRepository.lockRefundRequest(tx, rr.sourceRef);
        if (locked === null || !['REQUESTED', 'RETRY_REQUESTED'].includes(locked.status)) return;
        await emitOrderEvent(
          tx,
          ORDER_EVENTS.refundRequested,
          {
            sourceRef: locked.sourceRef,
            orderId: locked.orderId,
            paymentId: locked.paymentId,
            amountPaise: toPaise(locked.amount.toFixed(2)),
            reason: locked.reason,
            isSystem: locked.isSystem,
            requestedBy: locked.requestedBy,
          },
          `recovery-watch:${locked.id}`,
        );
        await this.deps.ordersRepository.updateRefundRequest(tx, locked.id, {});
      });
    if (releases.length + refunds.length > 0)
      this.deps.logger.warn({ releases: releases.length, refunds: refunds.length }, 'recovery-watch re-sent side effects');
    return { releases: releases.length, refunds: refunds.length };
  }

  // ── Helpers ──

  private async lockedAt(tx: Tx, id: string, expectedVersion?: number): Promise<OrderRow> {
    const order = await this.deps.ordersRepository.lock(tx, id);
    if (order === null) throw new NotFoundError('Order');
    if (expectedVersion !== undefined && order.version !== expectedVersion) throw versionConflict(order.version);
    return order;
  }

  private async mustFind(id: string): Promise<OrderWithLines> {
    const o = await this.deps.ordersRepository.find(id);
    if (o === null) throw new NotFoundError('Order');
    return o;
  }
}
