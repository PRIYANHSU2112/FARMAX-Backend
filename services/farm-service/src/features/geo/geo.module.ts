import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { GeoRepository } from './geo.repository.js';
import { geoAdminRoutes, geoRoutes } from './geo.routes.js';
import { GeoService } from './geo.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    geoRepository: GeoRepository;
    geoService: GeoService;
  }
}

export const geoModule = defineModule({
  name: 'geo',
  prefix: '/farms/geo',
  register: (container) => {
    container.register({
      geoRepository: asClass(GeoRepository).singleton(),
      geoService: asClass(GeoService).singleton(),
    });
  },
  routes: geoRoutes,
});

export const geoAdminModule = defineModule({
  name: 'geo-admin',
  prefix: '/admin/farms/geo',
  routes: geoAdminRoutes,
});
