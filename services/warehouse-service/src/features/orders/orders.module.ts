import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createOrderEventHandlers } from './orders.events.js';
import { OrdersRepository } from './orders.repository.js';
import { ordersRoutes } from './orders.routes.js';
import { OrdersService } from './orders.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    ordersRepository: OrdersRepository;
    ordersService: OrdersService;
    orderEventHandlers: EventHandlerMap;
  }
}

/** Event-fed read model of the orders each warehouse fulfils (W2.03, D-56 P3). */
export const ordersModule = defineModule({
  name: 'orders',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      ordersRepository: asClass(OrdersRepository).singleton(),
      ordersService: asClass(OrdersService).singleton(),
      orderEventHandlers: asFunction(createOrderEventHandlers).singleton(),
    });
  },
  routes: ordersRoutes,
});
