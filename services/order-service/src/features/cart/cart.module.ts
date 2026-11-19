import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { CartRepository } from './cart.repository.js';
import { cartRoutes } from './cart.routes.js';
import { CartService } from './cart.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    cartRepository: CartRepository;
    cartService: CartService;
  }
}

/** Guest + customer carts (tables `carts`, `cart_items`), login merge, checkout hooks. */
export const cartModule = defineModule({
  name: 'cart',
  prefix: '/cart',
  register: (container) => {
    container.register({
      cartRepository: asClass(CartRepository).singleton(),
      cartService: asClass(CartService).singleton(),
    });
  },
  routes: cartRoutes,
});
