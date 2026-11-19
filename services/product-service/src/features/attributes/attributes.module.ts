import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AttributesController } from './attributes.controller.js';
import { AttributesRepository } from './attributes.repository.js';
import { attributesAdminRoutes, complianceAdminRoutes } from './attributes.routes.js';
import { AttributesService } from './attributes.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    attributesRepository: AttributesRepository;
    attributesService: AttributesService;
    attributesController: AttributesController;
  }
}

export const attributesModule = defineModule({
  name: 'attributes',
  prefix: '/admin/catalog/product-attributes',
  register: (container) => {
    container.register({
      attributesRepository: asClass(AttributesRepository).singleton(),
      attributesService: asClass(AttributesService).singleton(),
      attributesController: asClass(AttributesController).singleton(),
    });
  },
  routes: attributesAdminRoutes,
});

export const complianceModule = defineModule({
  name: 'compliance-profiles',
  prefix: '/admin/catalog/compliance-profiles',
  routes: complianceAdminRoutes,
});
