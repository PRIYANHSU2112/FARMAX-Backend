import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type {
  LotRow,
  LotSource,
  PointsAccountRow,
  PointsJournalRow,
  PointsSystemCode,
} from './rewards.types.js';

const ACCOUNT = {
  id: true,
  userId: true,
  availablePts: true,
  pendingPts: true,
  debtPts: true,
  lifetimeEarned: true,
} as const;

/**
 * Only place that touches `points_*`. Lock order everywhere: the customer's points account
 * (`lockAccount`) first, then their lots — so concurrent earn / convert / expire / reverse of one
 * customer serialise and never deadlock.
 */
export class RewardsRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async systemAccounts(tx?: Tx): Promise<Map<PointsSystemCode, string>> {
    const rows = await withPrismaErrors(() =>
      (tx ?? this.db).pointsAccount.findMany({
        where: { ownerType: 'SYSTEM' },
        select: { id: true, code: true },
      }),
    );
    return new Map(rows.map((r) => [r.code as PointsSystemCode, r.id]));
  }

  accountOf(userId: string, tx?: Tx): Promise<PointsAccountRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).pointsAccount.findUnique({ where: { userId }, select: ACCOUNT }),
    );
  }

  /** Creates the account if missing, then locks it (FOR UPDATE) for this transaction. */
  async lockAccount(tx: Tx, userId: string): Promise<PointsAccountRow> {
    await tx.pointsAccount.createMany({
      data: [{ ownerType: 'USER', userId }],
      skipDuplicates: true,
    });
    await tx.$queryRaw`SELECT 1 FROM "points_accounts" WHERE "userId" = ${userId}::uuid FOR UPDATE`;
    return tx.pointsAccount.findUniqueOrThrow({ where: { userId }, select: ACCOUNT });
  }

  async setBuckets(
    tx: Tx,
    id: string,
    b: { availablePts: bigint; pendingPts: bigint; debtPts: bigint; lifetimeEarned: bigint },
  ): Promise<void> {
    await tx.pointsAccount.update({ where: { id }, data: { ...b, version: { increment: 1 } } });
  }

  journalByKey(tx: Tx, idempotencyKey: string): Promise<PointsJournalRow | null> {
    return tx.pointsJournal.findUnique({ where: { idempotencyKey } });
  }

  /** INSERT … ON CONFLICT DO NOTHING (null = the key or the number was taken). */
  async insertJournal(
    tx: Tx,
    data: Prisma.PointsJournalCreateManyInput,
  ): Promise<PointsJournalRow | null> {
    const [row] = await tx.pointsJournal.createManyAndReturn({
      data: [data],
      skipDuplicates: true,
    });
    return row ?? null;
  }

  async insertPostings(tx: Tx, rows: Prisma.PointsPostingCreateManyInput[]): Promise<void> {
    await tx.pointsPosting.createMany({ data: rows });
  }

  async insertConsumptions(
    tx: Tx,
    rows: Prisma.PointsLotConsumptionCreateManyInput[],
  ): Promise<void> {
    if (rows.length > 0) await tx.pointsLotConsumption.createMany({ data: rows });
  }

  lotBySource(
    tx: Tx | undefined,
    sourceType: LotSource,
    sourceRef: string,
  ): Promise<LotRow | null> {
    return withPrismaErrors(() =>
      (tx ?? this.db).pointsLot.findUnique({
        where: { sourceType_sourceRef: { sourceType, sourceRef } },
      }),
    );
  }

  async lockLot(tx: Tx, id: string): Promise<LotRow | null> {
    await tx.$queryRaw`SELECT 1 FROM "points_lots" WHERE "id" = ${id}::uuid FOR UPDATE`;
    return tx.pointsLot.findUnique({ where: { id } });
  }

  insertLot(tx: Tx, data: Prisma.PointsLotUncheckedCreateInput): Promise<LotRow> {
    return tx.pointsLot.create({ data });
  }

  async updateLot(tx: Tx, id: string, data: Prisma.PointsLotUncheckedUpdateInput): Promise<void> {
    await tx.pointsLot.update({ where: { id }, data: { ...data, version: { increment: 1 } } });
  }

  /** The customer's spendable lots, soonest expiry first, locked (caller holds the account lock). */
  async availableLotsForUpdate(tx: Tx, userId: string, exceptId?: string): Promise<LotRow[]> {
    const ids = await tx.$queryRaw<{ id: string }[]>`
      SELECT "id" FROM "points_lots"
       WHERE "userId" = ${userId}::uuid AND "status" = 'AVAILABLE' AND "remainingPts" > 0
       ORDER BY "expiresAt", "id"
       FOR UPDATE`;
    const lots = await tx.pointsLot.findMany({
      where: { id: { in: ids.map((r) => r.id).filter((id) => id !== exceptId) } },
      orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
    });
    return lots;
  }

  /** PENDING lots whose hold is over (oldest first). */
  dueToMature(now: Date, limit: number): Promise<LotRow[]> {
    return withPrismaErrors(() =>
      this.db.pointsLot.findMany({
        where: { status: 'PENDING', availableAt: { lte: now } },
        orderBy: { availableAt: 'asc' },
        take: limit,
      }),
    );
  }

  /** AVAILABLE lots past expiry with points left. */
  dueToExpire(now: Date, limit: number): Promise<LotRow[]> {
    return withPrismaErrors(() =>
      this.db.pointsLot.findMany({
        where: { status: 'AVAILABLE', remainingPts: { gt: 0 }, expiresAt: { lte: now } },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      }),
    );
  }

  /** AVAILABLE lots expiring before `until` that were not announced yet. */
  dueForNotice(until: Date, limit: number): Promise<LotRow[]> {
    return withPrismaErrors(() =>
      this.db.pointsLot.findMany({
        where: {
          status: 'AVAILABLE',
          remainingPts: { gt: 0 },
          expiresAt: { lte: until },
          expiryNoticeAt: null,
        },
        orderBy: { expiresAt: 'asc' },
        take: limit,
      }),
    );
  }

  /** Points expiring before `until` and the first expiry date. */
  async expiring(userId: string, until: Date): Promise<{ points: bigint; first: Date | null }> {
    const agg = await withPrismaErrors(() =>
      this.db.pointsLot.aggregate({
        where: { userId, status: 'AVAILABLE', remainingPts: { gt: 0 }, expiresAt: { lte: until } },
        _sum: { remainingPts: true },
        _min: { expiresAt: true },
      }),
    );
    return { points: agg._sum.remainingPts ?? 0n, first: agg._min.expiresAt };
  }

  async journals(
    userId: string,
    q: { cursor?: string; limit: number },
  ): Promise<Paginated<PointsJournalRow>> {
    const rows = await withPrismaErrors(() =>
      this.db.pointsJournal.findMany({
        where: { userId },
        orderBy: { id: 'desc' },
        ...cursorArgs(q),
      }),
    );
    return toPage(rows, q.limit);
  }

  /** Oldest first, at most `limit` (points statement rows). */
  journalsBetween(
    userId: string,
    from: Date,
    to: Date,
    limit: number,
  ): Promise<PointsJournalRow[]> {
    return withPrismaErrors(() =>
      this.db.pointsJournal.findMany({
        where: { userId, createdAt: { gte: from, lt: to } },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    );
  }

  /** Available points at `at` (after the last journal before it). */
  async availableAt(userId: string, at: Date): Promise<bigint> {
    const j = await withPrismaErrors(() =>
      this.db.pointsJournal.findFirst({
        where: { userId, createdAt: { lt: at } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { availableAfter: true },
      }),
    );
    return j?.availableAfter ?? 0n;
  }

  /** Buckets that differ from SUM(postings) or from the open lots (ledger-check job). */
  async mismatches(): Promise<
    { checkType: string; refId: string; userId: string; expected: string; actual: string }[]
  > {
    const buckets = await this.db.$queryRaw<{ userId: string; actual: string; expected: string }[]>`
      SELECT a."userId",
             a."availablePts" || '/' || a."pendingPts" || '/' || a."debtPts" AS "actual",
             COALESCE(SUM(p."points") FILTER (WHERE p."bucket" = 'AVAILABLE'), 0) || '/' ||
             COALESCE(SUM(p."points") FILTER (WHERE p."bucket" = 'PENDING'), 0) || '/' ||
             -COALESCE(SUM(p."points") FILTER (WHERE p."bucket" = 'DEBT'), 0) AS "expected"
        FROM "points_accounts" a LEFT JOIN "points_postings" p ON p."accountId" = a."id"
       WHERE a."ownerType" = 'USER'
       GROUP BY a."id"
      HAVING a."availablePts" <> COALESCE(SUM(p."points") FILTER (WHERE p."bucket" = 'AVAILABLE'), 0)
          OR a."pendingPts" <> COALESCE(SUM(p."points") FILTER (WHERE p."bucket" = 'PENDING'), 0)
          OR a."debtPts" <> -COALESCE(SUM(p."points") FILTER (WHERE p."bucket" = 'DEBT'), 0)`;
    const lots = await this.db.$queryRaw<{ userId: string; actual: string; expected: string }[]>`
      SELECT a."userId",
             a."availablePts" || '/' || a."pendingPts" AS "actual",
             COALESCE(SUM(l."remainingPts") FILTER (WHERE l."status" = 'AVAILABLE'), 0) || '/' ||
             COALESCE(SUM(l."remainingPts") FILTER (WHERE l."status" = 'PENDING'), 0) AS "expected"
        FROM "points_accounts" a LEFT JOIN "points_lots" l ON l."userId" = a."userId"
       WHERE a."ownerType" = 'USER'
       GROUP BY a."id"
      HAVING a."availablePts" <> COALESCE(SUM(l."remainingPts") FILTER (WHERE l."status" = 'AVAILABLE'), 0)
          OR a."pendingPts" <> COALESCE(SUM(l."remainingPts") FILTER (WHERE l."status" = 'PENDING'), 0)`;
    return [
      ...buckets.map((b) => ({ checkType: 'POINTS_BUCKETS', refId: b.userId, ...b })),
      ...lots.map((b) => ({ checkType: 'POINTS_LOTS', refId: b.userId, ...b })),
    ];
  }
}
