import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { BannersController } from './banners.controller.js';
import { BannersRepository } from './banners.repository.js';
import { bannersAdminRoutes, bannersRoutes, placementsAdminRoutes } from './banners.routes.js';
import { BannersService } from './banners.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    bannersRepository: BannersRepository;
    bannersService: BannersService;
    bannersController: BannersController;
  }
}

export const bannersModule = defineModule({
  name: 'banners',
  prefix: '/catalog/banners',
  register: (container) => {
    container.register({
      bannersRepository: asClass(BannersRepository).singleton(),
      // Singleton: holds the in-process banner snapshot.
      bannersService: asClass(BannersService).singleton(),
      bannersController: asClass(BannersController).singleton(),
    });
  },
  routes: bannersRoutes,
});

export const bannersAdminModule = defineModule({
  name: 'banners-admin',
  prefix: '/admin/catalog/banners',
  routes: bannersAdminRoutes,
});

export const bannerPlacementsAdminModule = defineModule({
  name: 'banner-placements-admin',
  prefix: '/admin/catalog/banner-placements',
  routes: placementsAdminRoutes,
});
