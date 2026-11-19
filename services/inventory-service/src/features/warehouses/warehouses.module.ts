import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { WarehousesRepository } from './warehouses.repository.js';
import { warehousesRoutes } from './warehouses.routes.js';
import { WarehousesService } from './warehouses.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    warehousesRepository: WarehousesRepository;
    warehousesService: WarehousesService;
  }
}

export const warehousesModule = defineModule({
  name: 'warehouses',
  prefix: '/admin/inventory/warehouses',
  register: (container) => {
    container.register({
      warehousesRepository: asClass(WarehousesRepository).singleton(),
      warehousesService: asClass(WarehousesService).singleton(),
    });
  },
  routes: warehousesRoutes,
});
