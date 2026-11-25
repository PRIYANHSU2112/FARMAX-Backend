import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createReleaseEventHandlers } from './release.events.js';
import { ReleaseRepository } from './release.repository.js';
import { releaseRoutes } from './release.routes.js';
import { ReleaseService } from './release.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    releaseRepository: ReleaseRepository;
    releaseService: ReleaseService;
    releaseEventHandlers: EventHandlerMap;
  }
}

/** W16.07 quality release: warehouse panel `/quality/batches/*`, `/quality/decisions/*`. */
export const releaseModule = defineModule({
  name: 'release',
  prefix: '/quality',
  register: (container) => {
    container.register({
      releaseRepository: asClass(ReleaseRepository).singleton(),
      releaseService: asClass(ReleaseService).singleton(),
      releaseEventHandlers: asFunction(createReleaseEventHandlers).singleton(),
    });
  },
  routes: releaseRoutes('panel'),
});

/** Same handlers on the admin panel. */
export const releaseAdminModule = defineModule({
  name: 'release-admin',
  prefix: '/admin/quality',
  routes: releaseRoutes('admin'),
});
