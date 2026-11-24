import type { AvailabilityChangedV1 } from '@farmx/infra/events';
import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { AtpRepository } from './atp.repository.js';
import { atpRoutes } from './atp.routes.js';
import { AtpService } from './atp.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    atpRepository: AtpRepository;
    atpService: AtpService;
    atpEventHandlers: EventHandlerMap;
  }
}

/** D-57b W3.13 Available-to-Promise: warehouse panel `/wms/atp/*`. */
export const atpModule = defineModule({
  name: 'atp',
  prefix: '/wms',
  register: (container) => {
    container.register({
      atpRepository: asClass(AtpRepository).singleton(),
      atpService: asClass(AtpService).singleton(),
      // Storefront sync: what the app shows (inventory.availability_changed.v1).
      atpEventHandlers: asFunction(
        ({ atpService }: { atpService: AtpService }): EventHandlerMap => ({
          'inventory.availability_changed.v1': (e, tx) =>
            atpService.applyAvailability(
              tx,
              e.data as AvailabilityChangedV1,
              new Date(e.occurredAt),
            ),
        }),
      ).singleton(),
    });
  },
  routes: atpRoutes('panel'),
});

/** Admin panel: same reads + settings write. */
export const atpAdminModule = defineModule({
  name: 'atp-admin',
  prefix: '/admin/wms',
  routes: atpRoutes('admin'),
});
