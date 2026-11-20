import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { TemplatesAdminService } from './templates.admin.service.js';
import { TemplatesRepository } from './templates.repository.js';
import { templatesRoutes } from './templates.routes.js';
import { TemplatesService } from './templates.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    templatesRepository: TemplatesRepository;
    templatesService: TemplatesService;
    templatesAdminService: TemplatesAdminService;
  }
}

/** Rendering + template management at `/admin/notification-templates`. */
export const templatesModule = defineModule({
  name: 'templates',
  prefix: '/admin/notification-templates',
  register: (container) => {
    container.register({
      templatesRepository: asClass(TemplatesRepository).singleton(),
      templatesService: asClass(TemplatesService).singleton(),
      templatesAdminService: asClass(TemplatesAdminService).singleton(),
    });
  },
  routes: templatesRoutes,
});
