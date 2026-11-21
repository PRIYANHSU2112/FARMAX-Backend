import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { LegalRepository } from './legal.repository.js';
import { legalRoutes } from './legal.routes.js';
import { LegalService } from './legal.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    legalRepository: LegalRepository;
    legalService: LegalService;
  }
}

/** Versioned legal pages (`/legal/:kind`, `/legal/admin/documents`). */
export const legalModule = defineModule({
  name: 'legal',
  prefix: '/legal',
  register: (container) => {
    container.register({
      legalRepository: asClass(LegalRepository).singleton(),
      legalService: asClass(LegalService).singleton(),
    });
  },
  routes: legalRoutes,
});
