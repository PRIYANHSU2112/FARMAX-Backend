import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Actor, AuditEntry, AuditTarget } from './audit.types.js';

/** Every change writes one row IN the same transaction as the change (D-22). */
export class AuditService {
  private readonly auditRepository: Cradle['auditRepository'];

  constructor({ auditRepository }: Pick<Cradle, 'auditRepository'>) {
    this.auditRepository = auditRepository;
  }

  record(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
    return this.auditRepository.insert(tx, actor, entry);
  }

  /** Audit rows about some targets (order + its shipments, W3.15 audit trail), newest first. */
  forTargets(targetIds: readonly string[], before: string | null, limit: number) {
    return this.auditRepository.forTargets(targetIds, before, limit);
  }

  /** Audit rows of some target types (W3.12 routing audit log), newest first. */
  forTypes(types: readonly AuditTarget[], before: string | null, limit: number) {
    return this.auditRepository.forTypes(types, before, limit);
  }
}
