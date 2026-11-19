import { defineModule } from '@farmx/common/server';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { OrdersClient } from '../../adapters/orders-client.js';
import { createReservationEventHandlers } from './reservations.events.js';
import { ReservationsRepository } from './reservations.repository.js';
import { reservationsInternalRoutes, reservationsRoutes } from './reservations.routes.js';
import { ReservationsService } from './reservations.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    reservationsRepository: ReservationsRepository;
    reservationsService: ReservationsService;
    reservationEventHandlers: EventHandlerMap;
    ordersClient: OrdersClient;
  }
}

export const reservationsModule = defineModule({
  name: 'reservations',
  prefix: '/admin/inventory/reservations',
  register: (container) => {
    container.register({
      reservationsRepository: asClass(ReservationsRepository).singleton(),
      reservationsService: asClass(ReservationsService).singleton(),
      reservationEventHandlers: asFunction(createReservationEventHandlers).singleton(),
      ordersClient: asFunction(
        (c: Cradle) => new OrdersClient({ config: c.config, logger: c.logger }),
      ).singleton(),
    });
  },
  routes: reservationsRoutes,
});

/** Service-to-service routes (registered by the module above). */
export const reservationsInternalModule = defineModule({
  name: 'reservations-internal',
  prefix: '/internal/inventory',
  routes: reservationsInternalRoutes,
});
