import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { OffersController } from './offers.controller.js';
import { offersRoutes } from './offers.routes.js';
import { OffersService } from './offers.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    offersService: OffersService;
    offersController: OffersController;
  }
}

/** Offers and price preview (no tables of its own: projections + promotions + pricing engine). */
export const offersModule = defineModule({
  name: 'offers',
  prefix: '/orders',
  register: (container) => {
    container.register({
      offersService: asClass(OffersService).singleton(),
      offersController: asClass(OffersController).singleton(),
    });
  },
  routes: offersRoutes,
});
