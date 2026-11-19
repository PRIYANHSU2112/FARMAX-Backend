import type { Paginated } from '@farmx/common/types';
import { cursorArgs, toPage, withPrismaErrors } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { AdminAuditLog, Prisma } from '@farmx/database/client';
import type { Tx } from '@farmx/database';
import type { AuditEntry, AuditListQuery, AuditLogView } from './audit.types.js';

const toView = (row: AdminAuditLog): AuditLogView => ({
  id: row.id,
  actorUserId: row.actorUserId,
  action: row.action,
  targetType: row.targetType,
  targetId: row.targetId,
  subjectUserId: row.subjectUserId,
  before: row.before,
  after: row.after,
  reason: row.reason,
  metadata: row.metadata,
  ip: row.ip,
  userAgent: row.userAgent,
  requestId: row.requestId,
  createdAt: row.createdAt.toISOString(),
});

/** The only code that touches `admin_audit_log`. Insert + read; the table is append-only. */
export class AuditRepository {
  private readonly db: Cradle['db'];

  constructor({ db }: Pick<Cradle, 'db'>) {
    this.db = db;
  }

  /** Inserts one row. Pass `tx` to commit it atomically with the audited change. */
  async create(entry: AuditEntry, tx?: Tx): Promise<{ id: string }> {
    const db = tx ?? this.db;
    return withPrismaErrors(() =>
      db.adminAuditLog.create({
        data: {
          actorUserId: entry.actor.userId,
          action: entry.action,
          targetType: entry.targetType,
          targetId: entry.targetId,
          subjectUserId: entry.subjectUserId ?? null,
          before: entry.before ?? undefined,
          after: entry.after ?? undefined,
          reason: entry.reason ?? null,
          metadata: entry.metadata ?? undefined,
          ip: entry.actor.ip ?? null,
          userAgent: entry.actor.userAgent ?? null,
          requestId: entry.actor.requestId ?? null,
        },
        select: { id: true },
      }),
    );
  }

  /** Newest first (UUID v7 ids are time-ordered), keyset-paginated. */
  async list(query: AuditListQuery): Promise<Paginated<AuditLogView>> {
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.actorUserId === undefined ? {} : { actorUserId: query.actorUserId }),
      ...(query.subjectUserId === undefined ? {} : { subjectUserId: query.subjectUserId }),
      ...(query.targetType === undefined ? {} : { targetType: query.targetType }),
      ...(query.targetId === undefined ? {} : { targetId: query.targetId }),
      ...(query.action === undefined ? {} : { action: query.action }),
      ...(query.from === undefined && query.to === undefined
        ? {}
        : {
            createdAt: {
              ...(query.from === undefined ? {} : { gte: query.from }),
              ...(query.to === undefined ? {} : { lt: query.to }),
            },
          }),
    };
    const rows = await withPrismaErrors(() =>
      this.db.adminAuditLog.findMany({ where, orderBy: { id: 'desc' }, ...cursorArgs(query) }),
    );
    return toPage(rows.map(toView), query.limit);
  }
}
