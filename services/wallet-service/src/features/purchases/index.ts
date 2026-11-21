// Public API of the purchases feature (orders paid from the wallet; internal only).
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { purchasesInternalRoutes } from './purchases.routes.js';
import { PurchasesService } from './purchases.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    purchasesService: PurchasesService;
  }
}

export const purchasesInternalModule = defineModule({
  name: 'purchases-internal',
  prefix: '/internal/wallet',
  register: (container) => {
    container.register({ purchasesService: asClass(PurchasesService).singleton() });
  },
  routes: purchasesInternalRoutes,
});
