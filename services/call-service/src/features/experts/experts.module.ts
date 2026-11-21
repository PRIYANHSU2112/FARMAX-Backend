import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ExpertsRepository } from './experts.repository.js';
import { expertsRoutes } from './experts.routes.js';
import { ExpertsService } from './experts.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    expertsRepository: ExpertsRepository;
    expertsService: ExpertsService;
  }
}

/** Experts, their availability / time-off, holidays, presence and the recommended-expert card. */
export const expertsModule = defineModule({
  name: 'experts',
  prefix: '/calls',
  register: (container) => {
    container.register({
      expertsRepository: asClass(ExpertsRepository).singleton(),
      expertsService: asClass(ExpertsService).singleton(),
    });
  },
  routes: expertsRoutes,
});
