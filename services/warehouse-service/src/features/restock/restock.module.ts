import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';
import { RestockRepository } from './restock.repository.js';
import { restockRoutes } from './restock.routes.js';
import { RestockService } from './restock.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    restockRepository: RestockRepository;
    restockService: RestockService;
  }
}

/** D-57a W4.07 / W4.08 restock requests + transfers: warehouse panel `/wms/stock/*`. */
export const restockModule = defineModule({
  name: 'restock',
  prefix: '/wms',
  register: (container) => {
    container.register({
      restockRepository: asClass(RestockRepository).singleton(),
      restockService: asClass(RestockService).singleton(),
    });
  },
  routes: restockRoutes('panel'),
});

/** Same handlers for the admin panel (`/admin/wms/stock/*`) + approve / reject. */
export const restockAdminModule = defineModule({
  name: 'restock-admin',
  prefix: '/admin/wms',
  routes: restockRoutes('admin'),
});
