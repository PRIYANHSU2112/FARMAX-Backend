import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AuditRepository } from './audit.repository.js';
import { auditRoutes } from './audit.routes.js';
import { AuditService } from './audit.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    auditRepository: AuditRepository;
    auditService: AuditService;
  }
}

/** Append-only audit: warehouse panel `/quality/audit`. */
export const auditModule = defineModule({
  name: 'audit',
  prefix: '/quality',
  register: (container) => {
    container.register({
      auditRepository: asClass(AuditRepository).singleton(),
      auditService: asClass(AuditService).singleton(),
    });
  },
  routes: auditRoutes('panel'),
});

/** Same handler on the admin panel (`/admin/quality/audit`, GLOBAL grants). */
export const auditAdminModule = defineModule({
  name: 'audit-admin',
  prefix: '/admin/quality',
  routes: auditRoutes('admin'),
});
