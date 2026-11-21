import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Actor, AuditEntry } from './audit.types.js';

/** Every change writes one row IN the same transaction as the change (D-22). */
export class AuditService {
  private readonly auditRepository: Cradle['auditRepository'];

  constructor({ auditRepository }: Pick<Cradle, 'auditRepository'>) {
    this.auditRepository = auditRepository;
  }

  record(tx: Tx, actor: Actor, entry: AuditEntry): Promise<void> {
    return this.auditRepository.insert(tx, actor, entry);
  }
}
