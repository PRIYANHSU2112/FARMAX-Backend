import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { OptionsRepository } from './options.repository.js';
import { optionsAdminRoutes } from './options.routes.js';
import { OptionsService } from './options.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    optionsRepository: OptionsRepository;
    optionsService: OptionsService;
  }
}

/** Booking chips + rules (`/calls/admin/options`, `/calls/admin/settings`). */
export const optionsModule = defineModule({
  name: 'options',
  prefix: '/calls/admin',
  register: (container) => {
    container.register({
      optionsRepository: asClass(OptionsRepository).singleton(),
      optionsService: asClass(OptionsService).singleton(),
    });
  },
  routes: optionsAdminRoutes,
});
