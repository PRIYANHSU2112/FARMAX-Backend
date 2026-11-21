// Public API of the adjustments feature (staff: manual wallet / points adjustments).
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AdjustmentsRepository } from './adjustments.repository.js';
import { adjustmentsRoutes } from './adjustments.routes.js';
import { AdjustmentsService } from './adjustments.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    adjustmentsRepository: AdjustmentsRepository;
    adjustmentsService: AdjustmentsService;
  }
}

export const adjustmentsModule = defineModule({
  name: 'adjustments',
  prefix: '/admin/wallet/adjustments',
  register: (container) => {
    container.register({
      adjustmentsRepository: asClass(AdjustmentsRepository).singleton(),
      adjustmentsService: asClass(AdjustmentsService).singleton(),
    });
  },
  routes: adjustmentsRoutes,
});

export { ADMIN_WALLET_TAG } from './adjustments.docs.js';
