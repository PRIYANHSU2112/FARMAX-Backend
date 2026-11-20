import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { UsersController } from './users.controller.js';
import { usersInternalRoutes } from './users.internal.routes.js';
import { UsersRepository } from './users.repository.js';
import { meRoutes, usersRoutes } from './users.routes.js';
import { UsersService } from './users.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    usersRepository: UsersRepository;
    usersService: UsersService;
    usersController: UsersController;
  }
}

export const usersModule = defineModule({
  name: 'users',
  prefix: '/admin/users',
  register: (container) => {
    container.register({
      usersRepository: asClass(UsersRepository).singleton(),
      usersService: asClass(UsersService).singleton(),
      usersController: asClass(UsersController).singleton(),
    });
  },
  routes: usersRoutes,
});

/** `/me` (self-service profile). Providers are registered by `usersModule`. */
export const meModule = defineModule({ name: 'me', prefix: '/me', routes: meRoutes });

/** `/internal/users`: contact + active ids for notification-service (internal token). */
export const usersInternalModule = defineModule({
  name: 'users-internal',
  prefix: '/internal/users',
  routes: usersInternalRoutes,
});
