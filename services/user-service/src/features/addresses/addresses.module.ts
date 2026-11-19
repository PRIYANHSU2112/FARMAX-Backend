import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AddressesController } from './addresses.controller.js';
import { AddressesRepository } from './addresses.repository.js';
import {
  addressesAdminRoutes,
  addressesInternalRoutes,
  addressesRoutes,
} from './addresses.routes.js';
import { AddressesService } from './addresses.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    addressesRepository: AddressesRepository;
    addressesService: AddressesService;
    addressesController: AddressesController;
  }
}

export const addressesModule = defineModule({
  name: 'addresses',
  prefix: '/me/addresses',
  register: (container) => {
    container.register({
      addressesRepository: asClass(AddressesRepository).singleton(),
      addressesService: asClass(AddressesService).singleton(),
      addressesController: asClass(AddressesController).singleton(),
    });
  },
  routes: addressesRoutes,
});

export const addressesAdminModule = defineModule({
  name: 'addresses-admin',
  prefix: '/admin/customers',
  routes: addressesAdminRoutes,
});

export const addressesInternalModule = defineModule({
  name: 'addresses-internal',
  prefix: '/internal/users',
  routes: addressesInternalRoutes,
});
