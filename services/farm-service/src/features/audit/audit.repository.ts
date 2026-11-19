import type { Paginated } from '@farmx/common/types';
import { type Tx, cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { AuditEntry, AuditRecord } from './audit.types.js';

/** Only place that touches `farm_audit_log` (append-only: INSERT and SELECT). */
export class AuditRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async insert(tx: Tx, entry: AuditEntry): Promise<void> {
    await tx.farmAuditLog.create({
      data: {
        actorUserId: entry.actorUserId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
        reason: entry.reason ?? null,
        ip: entry.ip ?? null,
        requestId: entry.requestId ?? null,
      },
    });
  }

  async listForTarget(
    targetType: string,
    targetId: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    const rows = await withPrismaErrors(() =>
      this.db.farmAuditLog.findMany({
        where: { targetType, targetId },
        orderBy: { id: 'desc' },
        select: { id: true, actorUserId: true, action: true, reason: true, createdAt: true },
        ...cursorArgs(query),
      }),
    );
    return toPage(rows, query.limit);
  }
}
