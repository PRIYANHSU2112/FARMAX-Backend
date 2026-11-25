import type { Tx } from '@farmx/database';

import type { AuditRepository } from './audit.repository.js';

/** Who did it: a staff user, a customer, or the system (event consumer / job). */
export interface Actor {
  userId: string | null;
  type: 'STAFF' | 'SYSTEM' | 'CUSTOMER';
  requestId?: string | null;
  ip?: string | null;
}

export const SYSTEM: Actor = { userId: null, type: 'SYSTEM' };

export interface AuditEntry {
  action: string;
  targetType: 'sample' | 'coa' | 'batch' | 'decision' | 'spec' | 'lab';
  targetId: string;
  warehouseId?: string | null;
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

/** JSON-safe copy (Dates → ISO strings); undefined / null → not stored. */
const json = (v: unknown): object | undefined =>
  v === undefined || v === null ? undefined : (JSON.parse(JSON.stringify(v)) as object);

/**
 * Append-only audit (D-60 point 5). Always written in the SAME transaction as the change, so a
 * change without its audit row can never commit. The table rejects UPDATE / DELETE (trigger).
 */
export class AuditService {
  constructor(private readonly deps: { auditRepository: AuditRepository }) {}

  async record(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
    await this.deps.auditRepository.insert(tx, {
      actorUserId: actor.userId,
      actorType: actor.type,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      warehouseId: entry.warehouseId ?? null,
      before: json(entry.before),
      after: json(entry.after),
      reason: entry.reason ?? null,
      requestId: actor.requestId ?? null,
      ip: actor.ip ?? null,
    });
  }

  /** Audit trail (newest first), optionally of one target or one actor. */
  async list(q: {
    targetType?: string;
    targetId?: string;
    actorUserId?: string;
    cursor?: string;
    limit: number;
  }) {
    const rows = await this.deps.auditRepository.list({ ...q, take: q.limit + 1 });
    const items = rows.slice(0, q.limit).map((r) => ({
      id: r.id,
      actorUserId: r.actorUserId,
      actorType: r.actorType,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      warehouseId: r.warehouseId,
      before: r.before,
      after: r.after,
      reason: r.reason,
      requestId: r.requestId,
      ip: r.ip,
      at: r.at.toISOString(),
    }));
    return {
      items,
      nextCursor: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null,
      limit: q.limit,
    };
  }
}
