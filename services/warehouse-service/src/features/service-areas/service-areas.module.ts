import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ServiceAreasRepository } from './service-areas.repository.js';
import { serviceAreasRoutes } from './service-areas.routes.js';
import { ServiceAreasService } from './service-areas.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    serviceAreasRepository: ServiceAreasRepository;
    serviceAreasService: ServiceAreasService;
  }
}

/** Districts + PINs per warehouse (D-56): `/admin/warehouses/:id/service-areas`, lookups, coverage. */
export const serviceAreasModule = defineModule({
  name: 'service-areas',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      serviceAreasRepository: asClass(ServiceAreasRepository).singleton(),
      serviceAreasService: asClass(ServiceAreasService).singleton(),
    });
  },
  routes: serviceAreasRoutes,
});
