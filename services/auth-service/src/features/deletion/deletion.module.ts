import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { DeletionRepository } from './deletion.repository.js';
import { deletionRoutes } from './deletion.routes.js';
import { DeletionService } from './deletion.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    deletionRepository: DeletionRepository;
    deletionService: DeletionService;
  }
}

/** Self-service account deletion + recovery (`/me/deletion-request*`, `/auth/account-recovery/*`). */
export const deletionModule = defineModule({
  name: 'deletion',
  register: (container) => {
    container.register({
      deletionRepository: asClass(DeletionRepository).singleton(),
      deletionService: asClass(DeletionService).singleton(),
    });
  },
  routes: deletionRoutes,
});
