import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { SpecsRepository } from './specs.repository.js';
import { specsRoutes } from './specs.routes.js';
import { SpecsService } from './specs.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    specsRepository: SpecsRepository;
    specsService: SpecsService;
  }
}

/** W16.09 SKU specifications: warehouse panel `/quality/specs`. */
export const specsModule = defineModule({
  name: 'specs',
  prefix: '/quality',
  register: (container) => {
    container.register({
      specsRepository: asClass(SpecsRepository).singleton(),
      specsService: asClass(SpecsService).singleton(),
    });
  },
  routes: specsRoutes('panel'),
});

/** Same handlers on the admin panel. */
export const specsAdminModule = defineModule({
  name: 'specs-admin',
  prefix: '/admin/quality',
  routes: specsRoutes('admin'),
});
