import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ComplianceRepository } from './compliance.repository.js';
import { complianceRoutes } from './compliance.routes.js';
import { ComplianceService } from './compliance.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    complianceRepository: ComplianceRepository;
    complianceService: ComplianceService;
  }
}

/** D-57b W3.16 compliance gate: warehouse panel `/wms/compliance/*`. */
export const complianceModule = defineModule({
  name: 'compliance',
  prefix: '/wms',
  register: (container) => {
    container.register({
      complianceRepository: asClass(ComplianceRepository).singleton(),
      complianceService: asClass(ComplianceService).singleton(),
    });
  },
  routes: complianceRoutes('panel'),
});

/** Same handlers on the admin panel + registry / inspector writes. */
export const complianceAdminModule = defineModule({
  name: 'compliance-admin',
  prefix: '/admin/wms',
  routes: complianceRoutes('admin'),
});
