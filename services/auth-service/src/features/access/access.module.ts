import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AccessController } from './access.controller.js';
import { AccessRepository } from './access.repository.js';
import { accessInternalRoutes } from './access.internal.routes.js';
import { accessRoutes } from './access.routes.js';
import { AccessService } from './access.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    accessRepository: AccessRepository;
    accessService: AccessService;
    accessController: AccessController;
  }
}

/** RBAC: fixed permissions (code), dynamic roles (DB). Routes: `/admin/roles`, `/admin/permissions`. */
export const accessModule = defineModule({
  name: 'access',
  prefix: '/admin',
  register: (container) => {
    container.register({
      accessRepository: asClass(AccessRepository).singleton(),
      accessService: asClass(AccessService).singleton(),
      accessController: asClass(AccessController).singleton(),
    });
  },
  routes: accessRoutes,
});

/** `/internal/access/:userId/permissions` for other services (internal token). */
export const accessInternalModule = defineModule({
  name: 'access-internal',
  prefix: '/internal/access',
  routes: accessInternalRoutes,
});
