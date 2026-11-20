import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { DevicesRepository } from './devices.repository.js';
import { devicesRoutes } from './devices.routes.js';
import { DevicesService } from './devices.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    devicesRepository: DevicesRepository;
    devicesService: DevicesService;
  }
}

/** FCM device tokens at `/notifications/devices`. */
export const devicesModule = defineModule({
  name: 'devices',
  prefix: '/notifications/devices',
  register: (container) => {
    container.register({
      devicesRepository: asClass(DevicesRepository).singleton(),
      devicesService: asClass(DevicesService).singleton(),
    });
  },
  routes: devicesRoutes,
});
