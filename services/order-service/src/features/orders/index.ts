// Public API of the orders feature.
import { defineModule } from '@farmx/common/server';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { AddressClient, InventoryClient, PaymentClient } from '../../adapters/internal-clients.js';
import { ordersAdminRoutes } from './orders.admin.routes.js';
import { OrdersAdminService } from './orders.admin.service.js';
import { OrderCancelService } from './orders.cancel.service.js';
import { createOrderEventHandlers } from './orders.events.js';
import { OrderLifecycle } from './orders.lifecycle.js';
import { OrdersRepository } from './orders.repository.js';
import { ordersInternalRoutes, ordersRoutes } from './orders.routes.js';
import { OrdersService } from './orders.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    ordersRepository: OrdersRepository;
    ordersService: OrdersService;
    ordersAdminService: OrdersAdminService;
    orderCancelService: OrderCancelService;
    orderLifecycle: OrderLifecycle;
    orderEventHandlers: EventHandlerMap;
    inventoryClient: InventoryClient;
    paymentClient: PaymentClient;
    addressClient: AddressClient;
  }
}

const client = <T>(Ctor: new (deps: Pick<Cradle, 'config' | 'logger'>) => T) =>
  asFunction((c: Cradle) => new Ctor({ config: c.config, logger: c.logger })).singleton();

export const ordersModule = defineModule({
  name: 'orders',
  prefix: '/orders',
  register: (container) => {
    container.register({
      ordersRepository: asClass(OrdersRepository).singleton(),
      ordersService: asClass(OrdersService).singleton(),
      ordersAdminService: asClass(OrdersAdminService).singleton(),
      orderCancelService: asClass(OrderCancelService).singleton(),
      orderLifecycle: asClass(OrderLifecycle).singleton(),
      orderEventHandlers: asFunction(createOrderEventHandlers).singleton(),
      inventoryClient: client(InventoryClient),
      paymentClient: client(PaymentClient),
      addressClient: client(AddressClient),
    });
  },
  routes: ordersRoutes,
});

export const ordersAdminModule = defineModule({
  name: 'orders-admin',
  prefix: '/admin/orders',
  routes: ordersAdminRoutes,
});

export const ordersInternalModule = defineModule({
  name: 'orders-internal',
  prefix: '/internal/orders',
  routes: ordersInternalRoutes,
});

export { ORDERS_TAG } from './orders.docs.js';
export { ADMIN_ORDERS_TAG } from './orders.admin.routes.js';
