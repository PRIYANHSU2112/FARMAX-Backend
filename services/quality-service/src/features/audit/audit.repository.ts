import type { Tx } from '@farmx/database';
import type { Database, Prisma } from '@farmx/database/client';

/** `quality_audit_logs` (append-only: the table rejects UPDATE / DELETE). */
export class AuditRepository {
  constructor(private readonly deps: { db: Database }) {}

  async insert(tx: Tx, data: Prisma.QaAuditLogUncheckedCreateInput): Promise<void> {
    await tx.qaAuditLog.create({ data });
  }

  list(q: {
    targetType?: string;
    targetId?: string;
    actorUserId?: string;
    cursor?: string;
    take: number;
  }) {
    return this.deps.db.qaAuditLog.findMany({
      where: {
        ...(q.targetType === undefined ? {} : { targetType: q.targetType }),
        ...(q.targetId === undefined ? {} : { targetId: q.targetId }),
        ...(q.actorUserId === undefined ? {} : { actorUserId: q.actorUserId }),
      },
      orderBy: { id: 'desc' },
      take: q.take,
      ...(q.cursor === undefined ? {} : { cursor: { id: q.cursor }, skip: 1 }),
    });
  }
}
