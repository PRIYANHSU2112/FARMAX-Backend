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

import type { RefundListQuery, RefundRow } from './refunds.types.js';

/** Only place that touches `refunds`. Changes run under `lock` (or a SKIP LOCKED claim). */
export class RefundsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async find(id: string, tx?: Tx): Promise<RefundRow | null> {
    return (await withPrismaErrors(() =>
      (tx ?? this.db).refund.findUnique({ where: { id } }),
    ));
  }

  async bySourceRef(sourceRef: string, tx?: Tx): Promise<RefundRow | null> {
    return (await withPrismaErrors(() =>
      (tx ?? this.db).refund.findUnique({ where: { sourceRef } }),
    ));
  }

  async byProviderRefundId(providerRefundId: string): Promise<RefundRow | null> {
    return (await withPrismaErrors(() =>
      this.db.refund.findUnique({ where: { providerRefundId } }),
    ));
  }

  /** Σ of refunds of a payment that still count against its captured amount. */
  async committedPaise(tx: Tx, paymentId: string): Promise<bigint> {
    const agg = await tx.refund.aggregate({
      where: { paymentId, status: { not: 'FAILED_FINAL' } },
      _sum: { amountPaise: true },
    });
    return agg._sum.amountPaise ?? 0n;
  }

  async create(tx: Tx, data: Prisma.RefundUncheckedCreateInput): Promise<RefundRow> {
    return (await tx.refund.create({ data }));
  }

  async lock(tx: Tx, id: string): Promise<RefundRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "refunds" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }

  async update(id: string, data: Prisma.RefundUncheckedUpdateInput, tx?: Tx): Promise<RefundRow> {
    try {
      return (await (tx ?? this.db).refund.update({
        where: { id },
        data: { ...data, version: { increment: 1 } },
      }));
    } catch (error) {
      if (isUniqueViolation(error))
        throw new Error('providerRefundId already linked to a refund', { cause: error });
      throw error;
    }
  }

  /**
   * Claims due refunds (APPROVED / RETRYING, nextRetryAt ≤ now): flips them to PROCESSING with
   * attempts + 1 in one statement, skipping rows another worker holds.
   */
  claimDue(limit: number): Promise<RefundRow[]> {
    return withPrismaErrors(
      () => this.db.$queryRaw<RefundRow[]>`
        UPDATE "refunds" SET "status" = 'PROCESSING', "attempts" = "attempts" + 1,
               "version" = "version" + 1, "updatedAt" = now()
        WHERE "id" IN (
          SELECT "id" FROM "refunds"
          WHERE "status" IN ('APPROVED', 'RETRYING')
            AND ("nextRetryAt" IS NULL OR "nextRetryAt" <= now())
          ORDER BY "nextRetryAt" NULLS FIRST, "createdAt"
          LIMIT ${limit} FOR UPDATE SKIP LOCKED)
        RETURNING *`,
    );
  }

  /** PROCESSING refunds that need a gateway look: accepted long ago, or claimed and abandoned. */
  stale(acceptedBefore: Date, claimedBefore: Date, limit: number): Promise<RefundRow[]> {
    return withPrismaErrors(
      () =>
        this.db.refund.findMany({
          where: {
            status: 'PROCESSING',
            OR: [
              { providerRefundId: { not: null }, initiatedAt: { lt: acceptedBefore } },
              { providerRefundId: null, updatedAt: { lt: claimedBefore } },
            ],
          },
          take: limit,
        }) as Promise<RefundRow[]>,
    );
  }

  forPayment(paymentId: string): Promise<RefundRow[]> {
    return withPrismaErrors(
      () =>
        this.db.refund.findMany({
          where: { paymentId },
          orderBy: { createdAt: 'asc' },
        }) as Promise<RefundRow[]>,
    );
  }

  async list(query: RefundListQuery): Promise<Paginated<RefundRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.refund.findMany({
        where: {
          ...(query.status === undefined ? {} : { status: query.status }),
          ...(query.orderId === undefined ? {} : { orderId: query.orderId }),
        },
        orderBy: { id: 'desc' },
        ...cursorArgs(query),
      }),
    );
    return toPage(rows as RefundRow[], query.limit);
  }
}
