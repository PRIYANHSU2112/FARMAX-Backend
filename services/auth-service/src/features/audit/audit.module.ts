import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AuditController } from './audit.controller.js';
import { AuditRepository } from './audit.repository.js';
import { auditRoutes } from './audit.routes.js';
import { AuditService } from './audit.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    auditRepository: AuditRepository;
    auditService: AuditService;
    auditController: AuditController;
  }
}

export const auditModule = defineModule({
  name: 'audit',
  prefix: '/admin/audit-logs',
  register: (container) => {
    container.register({
      auditRepository: asClass(AuditRepository).singleton(),
      auditService: asClass(AuditService).singleton(),
      auditController: asClass(AuditController).singleton(),
    });
  },
  routes: auditRoutes,
});
