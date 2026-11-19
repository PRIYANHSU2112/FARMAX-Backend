import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AvailabilityPublisher } from './stock.availability.js';
import { StockRepository } from './stock.repository.js';
import { stockRoutes } from './stock.routes.js';
import { StockService } from './stock.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    stockRepository: StockRepository;
    stockService: StockService;
    availabilityPublisher: AvailabilityPublisher;
  }
}

export const stockModule = defineModule({
  name: 'stock',
  prefix: '/admin/inventory',
  register: (container) => {
    container.register({
      stockRepository: asClass(StockRepository).singleton(),
      stockService: asClass(StockService).singleton(),
      availabilityPublisher: asClass(AvailabilityPublisher).singleton(),
    });
  },
  routes: stockRoutes,
});
