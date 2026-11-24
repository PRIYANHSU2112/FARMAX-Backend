import { type Tx, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Actor, AuditEntry, AuditTarget } from './audit.types.js';

/** Only place that touches `warehouse_audit_log` (append-only: INSERT only, trigger-enforced). */
export class AuditRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  async insert(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
    await tx.wmsAuditLog.create({
      data: {
        actorUserId: actor.userId,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId,
        before: entry.before ?? undefined,
        after: entry.after ?? undefined,
        reason: entry.reason ?? null,
        ip: actor.ip,
        requestId: actor.requestId,
      },
    });
  }

  /** Rows about some targets, newest first (keyset on id). */
  forTargets(targetIds: readonly string[], before: string | null, limit: number) {
    if (targetIds.length === 0) return Promise.resolve([]);
    return withPrismaErrors(() =>
      this.db.wmsAuditLog.findMany({
        where: {
          targetId: { in: [...new Set(targetIds)] },
          ...(before === null ? {} : { id: { lt: before } }),
        },
        select: {
          id: true,
          actorUserId: true,
          action: true,
          targetType: true,
          targetId: true,
          after: true,
          reason: true,
          createdAt: true,
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
  }

  /** Rows of some target types, newest first (keyset on id). */
  forTypes(types: readonly AuditTarget[], before: string | null, limit: number) {
    return withPrismaErrors(() =>
      this.db.wmsAuditLog.findMany({
        where: {
          targetType: { in: [...types] },
          ...(before === null ? {} : { id: { lt: before } }),
        },
        select: {
          id: true,
          actorUserId: true,
          action: true,
          targetType: true,
          targetId: true,
          before: true,
          after: true,
          reason: true,
          createdAt: true,
        },
        orderBy: { id: 'desc' },
        take: limit + 1,
      }),
    );
  }
}
