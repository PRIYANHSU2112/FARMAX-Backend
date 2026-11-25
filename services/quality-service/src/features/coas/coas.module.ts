import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { CoasRepository } from './coas.repository.js';
import { coasRoutes } from './coas.routes.js';
import { CoasService } from './coas.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    coasRepository: CoasRepository;
    coasService: CoasService;
  }
}

/** W16.05 / W16.06 / W16.10 certificates: warehouse panel `/quality/coas`. */
export const coasModule = defineModule({
  name: 'coas',
  prefix: '/quality',
  register: (container) => {
    container.register({
      coasRepository: asClass(CoasRepository).singleton(),
      coasService: asClass(CoasService).singleton(),
    });
  },
  routes: coasRoutes('panel'),
});

/** Same handlers on the admin panel. */
export const coasAdminModule = defineModule({
  name: 'coas-admin',
  prefix: '/admin/quality',
  routes: coasRoutes('admin'),
});
