import { paginated } from '@farmx/common/response';
import type { Cradle } from '@fastify/awilix';
import type { FastifyRequest } from 'fastify';

import type { AuditListQuery } from './audit.types.js';

export class AuditController {
  private readonly auditService: Cradle['auditService'];

  constructor({ auditService }: Pick<Cradle, 'auditService'>) {
    this.auditService = auditService;
  }

  async list(request: FastifyRequest<{ Querystring: AuditListQuery }>) {
    return paginated(await this.auditService.list(request.query));
  }
}
