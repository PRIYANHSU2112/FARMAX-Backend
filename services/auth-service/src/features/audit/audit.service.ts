import type { Paginated } from '@farmx/common/types';
import type { Cradle } from '@fastify/awilix';

import type { Tx } from '@farmx/database';
import type { AuditEntry, AuditListQuery, AuditLogView } from './audit.types.js';

/**
 * Public API of the audit module. Other modules call `record(entry, tx)` inside the same
 * transaction as the change they audit, so a change without its audit row cannot commit.
 */
export class AuditService {
  private readonly auditRepository: Cradle['auditRepository'];

  constructor({ auditRepository }: Pick<Cradle, 'auditRepository'>) {
    this.auditRepository = auditRepository;
  }

  async record(entry: AuditEntry, tx?: Tx): Promise<void> {
    await this.auditRepository.create(entry, tx);
  }

  list(query: AuditListQuery): Promise<Paginated<AuditLogView>> {
    return this.auditRepository.list(query);
  }
}
