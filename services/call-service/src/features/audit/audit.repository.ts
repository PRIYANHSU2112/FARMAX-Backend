import type { Tx } from '@farmx/database';

import type { Actor, AuditEntry } from './audit.types.js';

/** Only place that touches `call_audit_log` (append-only: INSERT only, trigger-enforced). */
export class AuditRepository {
  async insert(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
    await tx.callAuditLog.create({
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
}
