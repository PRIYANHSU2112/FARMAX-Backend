import type { Paginated } from '@farmx/common/types';
import {
  type Tx,
  cursorArgs,
  isUniqueViolation,
  toPage,
  withPrismaErrors,
} from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { AttemptView, PaymentListQuery, PaymentRow } from './payments.types.js';

/** Statuses that occupy the one-live-payment-per-order slot (partial unique index). */
const LIVE: PaymentRow['status'][] = [
  'CREATED',
  'PENDING',
  'FAILED',
  'CAPTURED',
  'PARTIALLY_REFUNDED',
  'REFUNDED',
];

/**
 * Only place that touches `payments` / `payment_attempts`. Every state change runs under `lock`
 * (SELECT … FOR UPDATE): verify, webhook, reconcile, expiry, cancel and refunds serialise per
 * payment.
 */
export class PaymentsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async find(id: string, tx?: Tx): Promise<PaymentRow | null> {
    return (await withPrismaErrors(() =>
      (tx ?? this.db).payment.findUnique({ where: { id } }),
    ));
  }

  async liveForOrder(orderId: string, tx?: Tx): Promise<PaymentRow | null> {
    return (await withPrismaErrors(() =>
      (tx ?? this.db).payment.findFirst({ where: { orderId, status: { in: LIVE } } }),
    ));
  }

  async byProviderOrder(providerOrderId: string): Promise<PaymentRow | null> {
    return (await withPrismaErrors(() =>
      this.db.payment.findUnique({ where: { providerOrderId } }),
    ));
  }

  /** Insert CREATED; null when the order already has a live payment (concurrent create). */
  async create(data: Prisma.PaymentUncheckedCreateInput): Promise<PaymentRow | null> {
    try {
      return (await this.db.payment.create({ data }));
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  async lock(tx: Tx, id: string): Promise<PaymentRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "payments" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }

  async update(
    id: string,
    data: Prisma.PaymentUncheckedUpdateInput,
    tx?: Tx,
  ): Promise<PaymentRow> {
    return (await (tx ?? this.db).payment.update({
      where: { id },
      data: { ...data, version: { increment: 1 } },
    }));
  }

  /** Records a gateway attempt once (same gateway payment + status → no duplicate). */
  async recordAttempt(
    tx: Tx,
    a: Omit<AttemptView, 'id' | 'createdAt'> & { paymentId: string },
  ): Promise<boolean> {
    const res = await tx.paymentAttempt.createMany({ data: [a], skipDuplicates: true });
    return res.count === 1;
  }

  attempts(paymentId: string): Promise<AttemptView[]> {
    return withPrismaErrors(() =>
      this.db.paymentAttempt.findMany({
        where: { paymentId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          providerPaymentId: true,
          status: true,
          method: true,
          errorCode: true,
          errorReason: true,
          source: true,
          createdAt: true,
        },
      }),
    );
  }

  async list(query: PaymentListQuery): Promise<Paginated<PaymentRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.payment.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
          ...(query.userId === undefined ? {} : { userId: query.userId }),
        },
        orderBy: { id: 'desc' },
        ...cursorArgs(query),
      }),
    );
    return toPage(rows as PaymentRow[], query.limit);
  }

  /** Open payments with a gateway order, created before `before` (reconcile candidates). */
  async openOlderThan(before: Date, limit: number): Promise<PaymentRow[]> {
    return (await withPrismaErrors(() =>
      this.db.payment.findMany({
        where: {
          status: { in: ['PENDING', 'FAILED'] },
          providerOrderId: { not: null },
          createdAt: { lt: before },
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'asc' },
        take: limit,
      }),
    ));
  }

  /** Open payments past their window (expiry candidates), oldest first. */
  async openExpired(limit: number): Promise<PaymentRow[]> {
    return (await withPrismaErrors(() =>
      this.db.payment.findMany({
        where: { status: { in: ['CREATED', 'PENDING', 'FAILED'] }, expiresAt: { lt: new Date() } },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      }),
    ));
  }
}
