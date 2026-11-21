import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AuditRepository } from './audit.repository.js';
import { AuditService } from './audit.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    auditRepository: AuditRepository;
    auditService: AuditService;
  }
}

/** call_audit_log writer (no routes). */
export const auditModule = defineModule({
  name: 'audit',
  register: (container) => {
    container.register({
      auditRepository: asClass(AuditRepository).singleton(),
      auditService: asClass(AuditService).singleton(),
    });
  },
});
