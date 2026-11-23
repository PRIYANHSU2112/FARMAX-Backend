import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { StorageRepository } from './storage.repository.js';
import { storageRoutes } from './storage.routes.js';
import { StorageService } from './storage.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    storageRepository: StorageRepository;
    storageService: StorageService;
  }
}

/** Zones, racks and bins (W2.05, D-56): `/admin/warehouses/:id/zones|racks|bins|storage/layout`. */
export const storageModule = defineModule({
  name: 'storage',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      storageRepository: asClass(StorageRepository).singleton(),
      storageService: asClass(StorageService).singleton(),
    });
  },
  routes: storageRoutes,
});
