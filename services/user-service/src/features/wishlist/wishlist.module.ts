import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { WishlistController } from './wishlist.controller.js';
import { WishlistRepository } from './wishlist.repository.js';
import { wishlistAdminRoutes, wishlistRoutes } from './wishlist.routes.js';
import { WishlistService } from './wishlist.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    wishlistRepository: WishlistRepository;
    wishlistService: WishlistService;
    wishlistController: WishlistController;
  }
}

export const wishlistModule = defineModule({
  name: 'wishlist',
  prefix: '/me/wishlist',
  register: (container) => {
    container.register({
      wishlistRepository: asClass(WishlistRepository).singleton(),
      wishlistService: asClass(WishlistService).singleton(),
      wishlistController: asClass(WishlistController).singleton(),
    });
  },
  routes: wishlistRoutes,
});

export const wishlistAdminModule = defineModule({
  name: 'wishlist-admin',
  prefix: '/admin/customers',
  routes: wishlistAdminRoutes,
});
