import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { DocksRepository } from './docks.repository.js';
import { docksRoutes } from './docks.routes.js';
import { DocksService } from './docks.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    docksRepository: DocksRepository;
    docksService: DocksService;
  }
}

/** Dock doors, bookings, staging areas and yard slots (W2.07, D-56). */
export const docksModule = defineModule({
  name: 'docks',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      docksRepository: asClass(DocksRepository).singleton(),
      docksService: asClass(DocksService).singleton(),
    });
  },
  routes: docksRoutes,
});
