import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { RoutingRepository } from './routing.repository.js';
import { routingRoutes } from './routing.routes.js';
import { RoutingService } from './routing.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    routingRepository: RoutingRepository;
    routingService: RoutingService;
  }
}

/** D-57b W3.12 routing rules: warehouse panel `/wms/routing/*` (reads + simulation). */
export const routingModule = defineModule({
  name: 'routing',
  prefix: '/wms',
  register: (container) => {
    container.register({
      routingRepository: asClass(RoutingRepository).singleton(),
      routingService: asClass(RoutingService).singleton(),
    });
  },
  routes: routingRoutes('panel'),
});

/** Admin panel: same reads + every rule / fallback / throttle write (GLOBAL `routing.manage`). */
export const routingAdminModule = defineModule({
  name: 'routing-admin',
  prefix: '/admin/wms',
  routes: routingRoutes('admin'),
});
