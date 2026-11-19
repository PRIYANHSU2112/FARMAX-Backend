import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { BrandsController } from './brands.controller.js';
import { BrandsRepository } from './brands.repository.js';
import { brandsInternalRoutes } from './brands.internal.routes.js';
import { brandsAdminRoutes, brandsRoutes } from './brands.routes.js';
import { BrandsService } from './brands.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    brandsRepository: BrandsRepository;
    brandsService: BrandsService;
    brandsController: BrandsController;
  }
}

export const brandsModule = defineModule({
  name: 'brands',
  prefix: '/catalog/brands',
  register: (container) => {
    container.register({
      brandsRepository: asClass(BrandsRepository).singleton(),
      // Singleton: holds the in-process brand snapshot.
      brandsService: asClass(BrandsService).singleton(),
      brandsController: asClass(BrandsController).singleton(),
    });
  },
  routes: brandsRoutes,
});

export const brandsAdminModule = defineModule({
  name: 'brands-admin',
  prefix: '/admin/catalog/brands',
  routes: brandsAdminRoutes,
});

export const brandsInternalModule = defineModule({
  name: 'brands-internal',
  prefix: '/internal/catalog/brands',
  routes: brandsInternalRoutes,
});
