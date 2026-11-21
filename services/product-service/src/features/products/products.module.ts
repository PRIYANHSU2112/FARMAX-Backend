import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { DiseasesController } from './diseases.controller.js';
import { DiseasesRepository } from './diseases.repository.js';
import { diseasesAdminRoutes, diseasesRoutes } from './diseases.routes.js';
import { DiseasesService } from './diseases.service.js';
import { LookupsController } from './lookups.controller.js';
import { LookupsRepository } from './lookups.repository.js';
import { lookupsAdminRoutes, lookupsRoutes } from './lookups.routes.js';
import { LookupsService } from './lookups.service.js';
import { ProductsController } from './products.controller.js';
import { createProductEventHandlers } from './products.events.js';
import { ProductsRepository } from './products.repository.js';
import { productsAdminRoutes, productsInternalRoutes, productsRoutes } from './products.routes.js';
import { ProductsService } from './products.service.js';
import { StorefrontService } from './products.storefront.js';

declare module '@fastify/awilix' {
  interface Cradle {
    diseasesRepository: DiseasesRepository;
    diseasesService: DiseasesService;
    diseasesController: DiseasesController;
    lookupsRepository: LookupsRepository;
    lookupsService: LookupsService;
    lookupsController: LookupsController;
    productsRepository: ProductsRepository;
    productsService: ProductsService;
    storefrontService: StorefrontService;
    productsController: ProductsController;
    /** Inbox handlers by routing key (catalog / pricing / inventory events). */
    productEventHandlers: EventHandlerMap;
  }
}

export const productsModule = defineModule({
  name: 'products',
  prefix: '/catalog/products',
  register: (container) => {
    container.register({
      diseasesRepository: asClass(DiseasesRepository).singleton(),
      diseasesService: asClass(DiseasesService).singleton(),
      diseasesController: asClass(DiseasesController).singleton(),
      lookupsRepository: asClass(LookupsRepository).singleton(),
      lookupsService: asClass(LookupsService).singleton(),
      lookupsController: asClass(LookupsController).singleton(),
      productsRepository: asClass(ProductsRepository).singleton(),
      productsService: asClass(ProductsService).singleton(),
      storefrontService: asClass(StorefrontService).singleton(),
      productsController: asClass(ProductsController).singleton(),
      productEventHandlers: asFunction(createProductEventHandlers).singleton(),
    });
  },
  routes: productsRoutes,
});

export const productsAdminModule = defineModule({
  name: 'products-admin',
  prefix: '/admin/catalog/products',
  routes: productsAdminRoutes,
});

export const productsInternalModule = defineModule({
  name: 'products-internal',
  prefix: '/internal/products',
  routes: productsInternalRoutes,
});

export const lookupsModule = defineModule({
  name: 'lookups',
  prefix: '/catalog/lookups',
  routes: lookupsRoutes,
});

export const lookupsAdminModule = defineModule({
  name: 'lookups-admin',
  prefix: '/admin/catalog/lookups',
  routes: lookupsAdminRoutes,
});

export const diseasesModule = defineModule({
  name: 'diseases',
  prefix: '/catalog/diseases',
  routes: diseasesRoutes,
});

export const diseasesAdminModule = defineModule({
  name: 'diseases-admin',
  prefix: '/admin/catalog/diseases',
  routes: diseasesAdminRoutes,
});
