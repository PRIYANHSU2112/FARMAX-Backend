import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  Actor,
  AdminOrderQuery,
  ExceptionType,
  NoteRow,
  OrderLineRow,
  OrderListQuery,
  OrderRow,
  OrderStatus,
  OrderWithLines,
  RefundRequestRow,
  StatusEventRow,
  StatusField,
} from './orders.types.js';

const TABS: Record<OrderListQuery['tab'], OrderStatus[]> = {
  active: ['PENDING_ADMIN_CONFIRMATION', 'CONFIRMED'],
  completed: [],
  cancelled: ['REJECTED', 'CANCELLED', 'FAILED'],
};

const WITH_LINES = { lines: { orderBy: { lineNo: 'asc' } } } as const;

/**
 * Only place that touches `orders`, `order_lines`, `order_status_events`,
 * `order_refund_requests` and `order_sequences`. Every lifecycle change runs under `lock`
 * (SELECT … FOR UPDATE on the order row): payment events, stock events, jobs and buyer actions on
 * one order serialise, so exactly one transition wins.
 */
export class OrdersRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** ORD-yy-nnnnnnn from an atomic yearly counter (committed with the order). */
  async nextOrderNo(tx: Tx, now = new Date()): Promise<string> {
    const yy = now.getUTCFullYear() % 100;
    const rows = await tx.$queryRaw<{ last: number }[]>`
      INSERT INTO "order_sequences" ("kind", "year", "last") VALUES ('ORD', ${yy}, 1)
      ON CONFLICT ("kind", "year") DO UPDATE SET "last" = "order_sequences"."last" + 1
      RETURNING "last"`;
    const last = rows[0]?.last ?? 1;
    return `ORD-${String(yy).padStart(2, '0')}-${String(last).padStart(7, '0')}`;
  }

  async create(
    tx: Tx,
    order: Prisma.OrderUncheckedCreateInput,
    lines: Omit<Prisma.OrderLineUncheckedCreateInput, 'orderId'>[],
  ): Promise<void> {
    await tx.order.create({ data: { ...order, lines: { createMany: { data: lines } } } });
  }

  async findByKey(key: string): Promise<OrderWithLines | null> {
    return (await withPrismaErrors(() =>
      this.db.order.findUnique({ where: { idempotencyKey: key }, include: WITH_LINES }),
    ));
  }

  async find(id: string, tx?: Tx): Promise<OrderWithLines | null> {
    return (await withPrismaErrors(() =>
      (tx ?? this.db).order.findUnique({ where: { id }, include: WITH_LINES }),
    ));
  }

  async lock(tx: Tx, id: string): Promise<OrderRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "orders" WHERE "id" = ${id}::uuid FOR UPDATE`;
    if (rows.length === 0) return null;
    return (await tx.order.findUnique({ where: { id } }));
  }

  async update(tx: Tx, id: string, data: Prisma.OrderUncheckedUpdateInput): Promise<OrderRow> {
    return (await tx.order.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    }));
  }

  async addEvents(
    tx: Tx,
    orderId: string,
    actor: Actor,
    changes: { field: StatusField; from: string | null; to: string }[],
    reason: { code?: string | null; note?: string | null } = {},
  ): Promise<void> {
    if (changes.length === 0) return;
    await tx.orderStatusEvent.createMany({
      data: changes.map((c) => ({
        orderId,
        field: c.field,
        fromValue: c.from,
        toValue: c.to,
        actorType: actor.type,
        actorId: actor.id,
        reasonCode: reason.code ?? null,
        note: reason.note?.slice(0, 500) ?? null,
      })),
    });
  }

  events(orderId: string): Promise<StatusEventRow[]> {
    return withPrismaErrors(() =>
      this.db.orderStatusEvent.findMany({
        where: { orderId },
        orderBy: [{ at: 'asc' }, { id: 'asc' }],
        select: {
          field: true,
          fromValue: true,
          toValue: true,
          actorType: true,
          actorId: true,
          reasonCode: true,
          note: true,
          at: true,
        },
      }),
    );
  }

  async listForUser(userId: string, query: OrderListQuery): Promise<Paginated<OrderWithLines>> {
    const statuses = TABS[query.tab];
    const rows = await withPrismaErrors(() =>
      this.db.order.findMany({
        where: { userId, status: { in: statuses } },
        orderBy: { id: 'desc' },
        include: WITH_LINES,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows as OrderWithLines[], query.limit);
  }

  statuses(ids: readonly string[]): Promise<{ id: string; status: string }[]> {
    return withPrismaErrors(() =>
      this.db.order.findMany({ where: { id: { in: [...ids] } }, select: { id: true, status: true } }),
    );
  }

  /** Open, unpaid orders whose window + grace has passed (timeout candidates). */
  unpaidDue(before: Date, limit: number): Promise<{ id: string; activePaymentId: string | null }[]> {
    return withPrismaErrors(() =>
      this.db.order.findMany({
        where: {
          status: 'PENDING_ADMIN_CONFIRMATION',
          paymentStatus: { in: ['PENDING', 'FAILED'] },
          paymentDueAt: { lt: before },
        },
        orderBy: { paymentDueAt: 'asc' },
        take: limit,
        select: { id: true, activePaymentId: true },
      }),
    );
  }

  /** Open orders whose placement did not finish (stock outcome unknown, or no payment yet). */
  async stuck(placedBefore: Date, limit: number): Promise<OrderWithLines[]> {
    return (await withPrismaErrors(() =>
      this.db.order.findMany({
        where: {
          status: 'PENDING_ADMIN_CONFIRMATION',
          placedAt: { lt: placedBefore },
          OR: [
            { stockStatus: 'PENDING' },
            {
              stockStatus: { in: ['RESERVED', 'COMMITTED'] },
              activePaymentId: null,
              paymentDueAt: { gt: new Date() },
            },
          ],
        },
        orderBy: { placedAt: 'asc' },
        take: limit,
        include: WITH_LINES,
      }),
    ));
  }

  // ── Admin reads ──

  async adminList(query: AdminOrderQuery): Promise<Paginated<OrderWithLines>> {
    const rows = await withPrismaErrors(() =>
      this.db.order.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.paymentStatus === undefined ? {} : { paymentStatus: query.paymentStatus }),
          ...(query.stockStatus === undefined ? {} : { stockStatus: query.stockStatus }),
          ...(query.refundStatus === undefined ? {} : { refundStatus: query.refundStatus }),
          ...(query.orderNo === undefined ? {} : { orderNo: { startsWith: query.orderNo.toUpperCase() } }),
          ...(query.farmId === undefined ? {} : { farmId: query.farmId }),
          ...(query.userId === undefined ? {} : { userId: query.userId }),
          ...(query.placedFrom === undefined && query.placedTo === undefined
            ? {}
            : {
                placedAt: {
                  ...(query.placedFrom === undefined ? {} : { gte: query.placedFrom }),
                  ...(query.placedTo === undefined ? {} : { lt: query.placedTo }),
                },
              }),
        },
        orderBy: { id: 'desc' },
        include: WITH_LINES,
        ...cursorArgs(query),
      }),
    );
    return toPage(rows as OrderWithLines[], query.limit);
  }

  /** Paid + stock committed, waiting for a decision: oldest payment first. */
  async reviewQueue(limit: number): Promise<OrderWithLines[]> {
    return (await withPrismaErrors(() =>
      this.db.order.findMany({
        where: { status: 'PENDING_ADMIN_CONFIRMATION', paymentStatus: 'PAID', stockStatus: 'COMMITTED' },
        orderBy: { paidAt: 'asc' },
        take: limit,
        include: WITH_LINES,
      }),
    ));
  }

  async stats(dayStart: Date, overdueBefore: Date) {
    const rows = await withPrismaErrors(
      () => this.db.$queryRaw<
        {
          awaitingPayment: number;
          awaitingReview: number;
          reviewOverdue: number;
          placedToday: number;
          confirmedToday: number;
          rejectedToday: number;
          cancelledToday: number;
          failedToday: number;
          gmvToday: string;
          refundActionRequired: number;
        }[]
      >`
        SELECT
          COUNT(*) FILTER (WHERE "status" = 'PENDING_ADMIN_CONFIRMATION' AND "paymentStatus" IN ('PENDING','FAILED'))::int AS "awaitingPayment",
          COUNT(*) FILTER (WHERE "status" = 'PENDING_ADMIN_CONFIRMATION' AND "paymentStatus" = 'PAID')::int AS "awaitingReview",
          COUNT(*) FILTER (WHERE "status" = 'PENDING_ADMIN_CONFIRMATION' AND "paymentStatus" = 'PAID' AND "paidAt" < ${overdueBefore})::int AS "reviewOverdue",
          COUNT(*) FILTER (WHERE "placedAt" >= ${dayStart})::int AS "placedToday",
          COUNT(*) FILTER (WHERE "confirmedAt" >= ${dayStart})::int AS "confirmedToday",
          COUNT(*) FILTER (WHERE "rejectedAt" >= ${dayStart})::int AS "rejectedToday",
          COUNT(*) FILTER (WHERE "cancelledAt" >= ${dayStart})::int AS "cancelledToday",
          COUNT(*) FILTER (WHERE "failedAt" >= ${dayStart})::int AS "failedToday",
          COALESCE(SUM("paidAmount" - "refundedAmount") FILTER (WHERE "paidAt" >= ${dayStart}), 0)::text AS "gmvToday",
          COUNT(*) FILTER (WHERE "refundStatus" = 'ACTION_REQUIRED')::int AS "refundActionRequired"
        FROM "orders"
        WHERE "placedAt" >= ${dayStart} OR "status" = 'PENDING_ADMIN_CONFIRMATION' OR "refundStatus" = 'ACTION_REQUIRED'
           OR "confirmedAt" >= ${dayStart} OR "rejectedAt" >= ${dayStart} OR "cancelledAt" >= ${dayStart} OR "failedAt" >= ${dayStart}`,
    );
    return rows[0];
  }

  /** Recovery work queues (docs/oms §3A). */
  async exceptions(type: ExceptionType, staleBefore: Date, limit: number): Promise<OrderWithLines[]> {
    const where =
      type === 'refund_failed'
        ? { refundStatus: 'ACTION_REQUIRED' as const }
        : type === 'stock_release_pending'
          ? { stockStatus: 'RELEASE_REQUESTED' as const, updatedAt: { lt: staleBefore } }
          : type === 'amount_mismatch'
            ? { paymentException: { not: null }, status: 'PENDING_ADMIN_CONFIRMATION' as const }
            : {
                status: { in: ['FAILED', 'CANCELLED', 'REJECTED'] as ('FAILED' | 'CANCELLED' | 'REJECTED')[] },
                paymentStatus: 'PAID' as const,
                refundStatus: { in: ['REQUESTED', 'IN_PROGRESS', 'ACTION_REQUIRED'] as ('REQUESTED' | 'IN_PROGRESS' | 'ACTION_REQUIRED')[] },
              };
    return (await withPrismaErrors(() =>
      this.db.order.findMany({ where, orderBy: { updatedAt: 'asc' }, take: limit, include: WITH_LINES }),
    ));
  }

  // ── Notes, cancellations ──

  async addNote(orderId: string, authorId: string, body: string): Promise<NoteRow> {
    return withPrismaErrors(() =>
      this.db.orderNote.create({
        data: { orderId, authorId, body },
        select: { id: true, authorId: true, body: true, createdAt: true },
      }),
    );
  }

  notes(orderId: string): Promise<NoteRow[]> {
    return withPrismaErrors(() =>
      this.db.orderNote.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
        select: { id: true, authorId: true, body: true, createdAt: true },
      }),
    );
  }

  async createCancellation(tx: Tx, data: Prisma.OrderCancellationUncheckedCreateInput): Promise<void> {
    await tx.orderCancellation.create({ data });
  }

  cancellationByKey(key: string) {
    return withPrismaErrors(() =>
      this.db.orderCancellation.findUnique({
        where: { idempotencyKey: key },
        select: { orderId: true, requestHash: true, requestedBy: true },
      }),
    );
  }

  async cancelLines(tx: Tx, orderId: string, items: readonly { lineNo: number; qty: number }[]): Promise<void> {
    for (const it of items)
      await tx.orderLine.update({
        where: { orderId_lineNo: { orderId, lineNo: it.lineNo } },
        data: { cancelledQty: { increment: it.qty } },
      });
  }

  // ── Jobs ──

  /** Paid, committed, waiting longer than the SLA and not alerted yet. */
  overdueReviews(paidBefore: Date, limit: number): Promise<{ id: string; orderNo: string; paidAt: Date | null }[]> {
    return withPrismaErrors(() =>
      this.db.order.findMany({
        where: {
          status: 'PENDING_ADMIN_CONFIRMATION',
          paymentStatus: 'PAID',
          paidAt: { lt: paidBefore },
          reviewOverdueAt: null,
        },
        take: limit,
        select: { id: true, orderNo: true, paidAt: true },
      }),
    );
  }

  autoRejectCandidates(paidBefore: Date, limit: number): Promise<{ id: string }[]> {
    return withPrismaErrors(() =>
      this.db.order.findMany({
        where: { status: 'PENDING_ADMIN_CONFIRMATION', paymentStatus: 'PAID', paidAt: { lt: paidBefore } },
        take: limit,
        select: { id: true },
      }),
    );
  }

  staleReleases(before: Date, limit: number): Promise<OrderRow[]> {
    return withPrismaErrors(
      () =>
        this.db.order.findMany({
          where: { stockStatus: 'RELEASE_REQUESTED', updatedAt: { lt: before } },
          take: limit,
        }) as Promise<OrderRow[]>,
    );
  }

  staleRefundRequests(before: Date, limit: number): Promise<RefundRequestRow[]> {
    return withPrismaErrors(
      () =>
        this.db.orderRefundRequest.findMany({
          where: { status: { in: ['REQUESTED', 'RETRY_REQUESTED'] }, updatedAt: { lt: before } },
          take: limit,
        }) as Promise<RefundRequestRow[]>,
    );
  }

  async lockRefundRequestById(tx: Tx, id: string): Promise<RefundRequestRow | null> {
    const rows = await tx.$queryRaw<{ sourceRef: string }[]>`
      SELECT "sourceRef" FROM "order_refund_requests" WHERE "id" = ${id}::uuid FOR UPDATE`;
    const ref = rows[0]?.sourceRef;
    return ref === undefined ? null : this.lockRefundRequest(tx, ref);
  }

  // ── Refund requests (decisions, lifecycle A) ──

  async createRefundRequest(
    tx: Tx,
    data: Prisma.OrderRefundRequestUncheckedCreateInput,
  ): Promise<void> {
    await tx.orderRefundRequest.create({ data });
  }

  async lockRefundRequest(tx: Tx, sourceRef: string): Promise<RefundRequestRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "order_refund_requests" WHERE "sourceRef" = ${sourceRef} FOR UPDATE`;
    if (rows.length === 0) return null;
    return (await tx.orderRefundRequest.findUnique({ where: { sourceRef } }));
  }

  async updateRefundRequest(
    tx: Tx,
    id: string,
    data: Prisma.OrderRefundRequestUncheckedUpdateInput,
  ): Promise<void> {
    await tx.orderRefundRequest.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  async refundRequests(orderId: string, tx?: Tx): Promise<RefundRequestRow[]> {
    return (await withPrismaErrors(() =>
      (tx ?? this.db).orderRefundRequest.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' } }),
    ));
  }
}

export type { OrderLineRow };
