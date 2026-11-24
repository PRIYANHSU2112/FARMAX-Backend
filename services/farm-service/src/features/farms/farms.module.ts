import { defineModule } from '@farmx/common/server';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlers } from '../../adapters/events.js';
import { FarmsController } from './farms.controller.js';
import { createFarmEventHandlers } from './farms.events.js';
import { FarmsRepository } from './farms.repository.js';
import { farmsAdminRoutes, farmsInternalRoutes, farmsRoutes } from './farms.routes.js';
import { FarmsService } from './farms.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    farmsRepository: FarmsRepository;
    farmsService: FarmsService;
    farmsController: FarmsController;
    farmEventHandlers: EventHandlers;
  }
}

export const farmsModule = defineModule({
  name: 'farms',
  prefix: '/farms',
  register: (container) => {
    container.register({
      farmsRepository: asClass(FarmsRepository).singleton(),
      farmsService: asClass(FarmsService).singleton(),
      farmsController: asClass(FarmsController).singleton(),
      farmEventHandlers: asFunction((cradle: Cradle) =>
        createFarmEventHandlers(cradle),
      ).singleton(),
    });
  },
  routes: farmsRoutes,
});

export const farmsAdminModule = defineModule({
  name: 'farms-admin',
  prefix: '/admin/farms',
  routes: farmsAdminRoutes,
});

export const farmsInternalModule = defineModule({
  name: 'farms-internal',
  prefix: '/internal/farms',
  routes: farmsInternalRoutes,
});
