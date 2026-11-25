import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { SamplesRepository } from './samples.repository.js';
import { samplesRoutes } from './samples.routes.js';
import { SamplesService } from './samples.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    samplesRepository: SamplesRepository;
    samplesService: SamplesService;
  }
}

/** W16.01–W16.04 samples: warehouse panel `/quality/samples`. */
export const samplesModule = defineModule({
  name: 'samples',
  prefix: '/quality',
  register: (container) => {
    container.register({
      samplesRepository: asClass(SamplesRepository).singleton(),
      samplesService: asClass(SamplesService).singleton(),
    });
  },
  routes: samplesRoutes('panel'),
});

/** Same handlers on the admin panel. */
export const samplesAdminModule = defineModule({
  name: 'samples-admin',
  prefix: '/admin/quality',
  routes: samplesRoutes('admin'),
});
