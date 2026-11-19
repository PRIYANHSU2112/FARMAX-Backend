import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { PromotionsController } from './promotions.controller.js';
import { PromotionsRepository } from './promotions.repository.js';
import { promotionsRoutes } from './promotions.routes.js';
import { PromotionsService } from './promotions.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    promotionsRepository: PromotionsRepository;
    promotionsService: PromotionsService;
    promotionsController: PromotionsController;
  }
}

export const promotionsModule = defineModule({
  name: 'promotions',
  prefix: '/admin/promotions',
  register: (container) => {
    container.register({
      promotionsRepository: asClass(PromotionsRepository).singleton(),
      promotionsService: asClass(PromotionsService).singleton(),
      promotionsController: asClass(PromotionsController).singleton(),
    });
  },
  routes: promotionsRoutes,
});
