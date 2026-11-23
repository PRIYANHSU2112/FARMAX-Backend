import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { StorageRulesRepository } from './storage-rules.repository.js';
import { storageRulesRoutes } from './storage-rules.routes.js';
import { StorageRulesService } from './storage-rules.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    storageRulesRepository: StorageRulesRepository;
    storageRulesService: StorageRulesService;
  }
}

/** Storage compatibility rules (W2.08, D-56; not enforced until put-away). */
export const storageRulesModule = defineModule({
  name: 'storage-rules',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      storageRulesRepository: asClass(StorageRulesRepository).singleton(),
      storageRulesService: asClass(StorageRulesService).singleton(),
    });
  },
  routes: storageRulesRoutes,
});
