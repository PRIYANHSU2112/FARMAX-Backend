import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { portalRoutes } from './portal.routes.js';
import { PortalService } from './portal.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    portalService: PortalService;
  }
}

/** Warehouse portal shell (D-56): `/admin/wms/me`, `/admin/wms/search`. */
export const portalModule = defineModule({
  name: 'portal',
  prefix: '/admin/wms',
  register: (container) => {
    container.register({ portalService: asClass(PortalService).singleton() });
  },
  routes: portalRoutes,
});
