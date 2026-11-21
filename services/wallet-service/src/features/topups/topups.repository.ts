import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { TopupRow } from './topups.types.js';

/**
 * Only place that touches `wallet_topups`. Every state change runs under `lock`
 * (SELECT … FOR UPDATE): events, live checks and the reconcile job serialise per top-up.
 */
export class TopupsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  find(id: string, tx?: Tx): Promise<TopupRow | null> {
    return withPrismaErrors(() => (tx ?? this.db).walletTopup.findUnique({ where: { id } }));
  }

  byKey(tx: Tx, userId: string, idempotencyKey: string): Promise<TopupRow | null> {
    return tx.walletTopup.findUnique({
      where: { userId_idempotencyKey: { userId, idempotencyKey } },
    });
  }

  insert(tx: Tx, data: Prisma.WalletTopupUncheckedCreateInput): Promise<TopupRow> {
    return tx.walletTopup.create({ data });
  }

  async lock(tx: Tx, id: string): Promise<TopupRow | null> {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "wallet_topups" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return rows.length === 0 ? null : this.find(id, tx);
  }

  update(tx: Tx, id: string, data: Prisma.WalletTopupUncheckedUpdateInput): Promise<TopupRow> {
    return tx.walletTopup.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  /** Sum of today's top-ups that still count against the daily limit (not EXPIRED). */
  async startedSince(tx: Tx, userId: string, since: Date): Promise<bigint> {
    const agg = await tx.walletTopup.aggregate({
      where: { userId, createdAt: { gte: since }, status: { not: 'EXPIRED' } },
      _sum: { amountPaise: true },
    });
    return agg._sum.amountPaise ?? 0n;
  }

  /** Has the customer completed a top-up (other than `exceptId`)? (first-top-up cashback) */
  async hasCompletedOther(tx: Tx, userId: string, exceptId?: string): Promise<boolean> {
    const n = await tx.walletTopup.count({
      where: {
        userId,
        status: 'COMPLETED',
        ...(exceptId === undefined ? {} : { id: { not: exceptId } }),
      },
    });
    return n > 0;
  }

  /** Completed top-ups whose cashback points are not credited yet (sweep; W2 rows included). */
  ungrantedCashback(limit: number): Promise<TopupRow[]> {
    return withPrismaErrors(() =>
      this.db.walletTopup.findMany({
        where: { status: 'COMPLETED', cashbackPoints: { gt: 0 }, cashbackGrantedAt: null },
        orderBy: { completedAt: 'asc' },
        take: limit,
      }),
    );
  }

  /**
   * Open top-ups created before `before`, least recently checked first (reconcile candidates).
   * Each check bumps `updatedAt` (`touch`), so a backlog is worked round-robin, never starved.
   */
  openOlderThan(before: Date, limit: number): Promise<TopupRow[]> {
    return withPrismaErrors(() =>
      this.db.walletTopup.findMany({
        where: { status: { in: ['CREATED', 'PENDING', 'FAILED'] }, createdAt: { lt: before } },
        orderBy: { updatedAt: 'asc' },
        take: limit,
      }),
    );
  }

  /** Completed top-ups since `since` (ledger check: each must have its credit journal). */
  completedSince(since: Date, limit: number): Promise<TopupRow[]> {
    return withPrismaErrors(() =>
      this.db.walletTopup.findMany({
        where: { status: 'COMPLETED', completedAt: { gte: since } },
        orderBy: { completedAt: 'asc' },
        take: limit,
      }),
    );
  }

  /** Marks a top-up as just checked (reconcile fairness). */
  async touch(id: string): Promise<void> {
    await withPrismaErrors(() =>
      this.db.walletTopup.update({ where: { id }, data: { updatedAt: new Date() } }),
    );
  }
}
