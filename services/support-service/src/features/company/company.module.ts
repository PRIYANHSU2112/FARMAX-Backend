import { defineModule } from '@farmx/common/server';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { companyAdminRoutes } from './company.admin.routes.js';
import { createCompanyEventHandlers } from './company.events.js';
import { CompanyRepository } from './company.repository.js';
import { companyRoutes } from './company.routes.js';
import { CompanyService } from './company.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    companyRepository: CompanyRepository;
    companyService: CompanyService;
    companyEventHandlers: EventHandlerMap;
  }
}

/**
 * Company licences / certificates + dealer / partner applications.
 *   /support/company/*   public documents, apply, my applications
 *   /admin/support/*     documents CRUD, application review queue (staff)
 */
export const companyModule = defineModule({
  name: 'company',
  register: (container) => {
    container.register({
      companyRepository: asClass(CompanyRepository).singleton(),
      companyService: asClass(CompanyService).singleton(),
      companyEventHandlers: asFunction((cradle: Cradle) =>
        createCompanyEventHandlers(cradle),
      ).singleton(),
    });
  },
  routes: async (app) => {
    await app.register(companyRoutes, { prefix: '/support/company' });
    await app.register(companyAdminRoutes, { prefix: '/admin/support' });
  },
});
