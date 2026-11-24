import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { DispatchRepository } from './dispatch.repository.js';
import { dispatchRoutes } from './dispatch.routes.js';
import { DispatchService } from './dispatch.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    dispatchRepository: DispatchRepository;
    dispatchService: DispatchService;
  }
}

/** D-57b dispatch (routes, fleet, trips, W3.08, W3.19): warehouse panel `/wms/*`. */
export const dispatchModule = defineModule({
  name: 'dispatch',
  prefix: '/wms',
  register: (container) => {
    container.register({
      dispatchRepository: asClass(DispatchRepository).singleton(),
      dispatchService: asClass(DispatchService).singleton(),
    });
  },
  routes: dispatchRoutes('panel'),
});

/** Same handlers on the admin panel (`/admin/wms/*`, GLOBAL). */
export const dispatchAdminModule = defineModule({
  name: 'dispatch-admin',
  prefix: '/admin/wms',
  routes: dispatchRoutes('admin'),
});
