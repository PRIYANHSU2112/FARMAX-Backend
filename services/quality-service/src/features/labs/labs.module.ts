import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { LabsRepository } from './labs.repository.js';
import { labsRoutes } from './labs.routes.js';
import { LabsService } from './labs.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    labsRepository: LabsRepository;
    labsService: LabsService;
  }
}

/** W16.08 labs: warehouse panel `/quality/labs`. */
export const labsModule = defineModule({
  name: 'labs',
  prefix: '/quality',
  register: (container) => {
    container.register({
      labsRepository: asClass(LabsRepository).singleton(),
      labsService: asClass(LabsService).singleton(),
    });
  },
  routes: labsRoutes('panel'),
});

/** Same handlers on the admin panel (`/admin/quality/labs`). */
export const labsAdminModule = defineModule({
  name: 'labs-admin',
  prefix: '/admin/quality',
  routes: labsRoutes('admin'),
});
