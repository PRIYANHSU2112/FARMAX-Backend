import type { Paginated } from '@farmx/common/types';
import type { Tx } from '@farmx/database';
import type { Cradle } from '@fastify/awilix';

import type { Actor, AuditEntry, AuditRecord } from './audit.types.js';

/** Every admin change writes one row IN the same transaction as the change (D-17 pattern). */
export class AuditService {
  private readonly auditRepository: Cradle['auditRepository'];

  constructor({ auditRepository }: Pick<Cradle, 'auditRepository'>) {
    this.auditRepository = auditRepository;
  }

  record(
    tx: Tx,
    actor: Actor,
    entry: Omit<AuditEntry, 'actorUserId' | 'ip' | 'requestId'>,
  ): Promise<void> {
    return this.auditRepository.insert(tx, {
      ...entry,
      actorUserId: actor.userId,
      ip: actor.ip,
      requestId: actor.requestId,
    });
  }

  history(
    targetType: AuditEntry['targetType'],
    targetId: string,
    query: { cursor?: string; limit: number },
  ): Promise<Paginated<AuditRecord>> {
    return this.auditRepository.listForTarget(targetType, targetId, query);
  }
}
