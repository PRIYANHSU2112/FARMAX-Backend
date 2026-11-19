import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { DuplicateCase, Prisma } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';

import type { CaseStatus, CaseView, OwnerClaim, QueueQuery } from './review.types.js';

const iso = (d: Date | null): string | null => (d === null ? null : d.toISOString());

const toView = (row: DuplicateCase): CaseView => ({
  id: row.id,
  farmId: row.farmId,
  matchedFarmId: row.matchedFarmId,
  matchedOwnerId: row.matchedOwnerId,
  sameOwner: row.sameOwner,
  signals: row.signals,
  score: row.score,
  distanceM: row.distanceM,
  nameSimilarity: row.nameSimilarity?.toNumber() ?? null,
  ownerClaim: row.ownerClaim,
  ownerClaimAt: iso(row.ownerClaimAt),
  status: row.status,
  assignedToUserId: row.assignedToUserId,
  slaDueAt: row.slaDueAt.toISOString(),
  resolvedByUserId: row.resolvedByUserId,
  resolvedAt: iso(row.resolvedAt),
  resolutionNote: row.resolutionNote,
  createdAt: row.createdAt.toISOString(),
});

/** Only place that queries `farm_duplicate_cases`. */
export class ReviewRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async create(tx: Tx, data: Prisma.DuplicateCaseUncheckedCreateInput): Promise<CaseView> {
    return toView(await tx.duplicateCase.create({ data }));
  }

  async findById(id: string, tx?: Tx): Promise<CaseView | null> {
    const row = await withPrismaErrors(() =>
      (tx ?? this.db).duplicateCase.findUnique({ where: { id } }),
    );
    return row === null ? null : toView(row);
  }

  /** Latest case of a farm (index farmId, status). */
  async findLatestForFarm(farmId: string): Promise<CaseView | null> {
    const row = await withPrismaErrors(() =>
      this.db.duplicateCase.findFirst({ where: { farmId }, orderBy: { id: 'desc' } }),
    );
    return row === null ? null : toView(row);
  }

  /** Open cases by SLA (partial index on slaDueAt WHERE status = OPEN). */
  async listQueue(query: QueueQuery, reviewerId: string): Promise<Paginated<CaseView>> {
    const rows = await withPrismaErrors(() =>
      this.db.duplicateCase.findMany({
        where: {
          status: 'OPEN',
          ...(query.assignee === 'me' ? { assignedToUserId: reviewerId } : {}),
          ...(query.assignee === 'unassigned' ? { assignedToUserId: null } : {}),
          ...(query.overdue === true ? { slaDueAt: { lt: new Date() } } : {}),
        },
        orderBy: [{ slaDueAt: 'asc' }, { id: 'asc' }],
        ...cursorArgs(query),
      }),
    );
    const page = toPage(rows, query.limit);
    return { ...page, items: page.items.map(toView) };
  }

  async setClaim(tx: Tx, id: string, claim: OwnerClaim): Promise<void> {
    await tx.duplicateCase.update({
      where: { id },
      data: { ownerClaim: claim, ownerClaimAt: new Date() },
    });
  }

  async assign(tx: Tx, id: string, assigneeUserId: string): Promise<CaseView> {
    return toView(
      await tx.duplicateCase.update({ where: { id }, data: { assignedToUserId: assigneeUserId } }),
    );
  }

  /** Resolves only an OPEN case (concurrent double-decisions: the second one gets 0 rows). */
  async resolve(
    tx: Tx,
    id: string,
    status: CaseStatus,
    resolvedByUserId: string | null,
    note: string,
  ): Promise<boolean> {
    const { count } = await tx.duplicateCase.updateMany({
      where: { id, status: 'OPEN' },
      data: { status, resolvedByUserId, resolvedAt: new Date(), resolutionNote: note },
    });
    return count === 1;
  }
}
