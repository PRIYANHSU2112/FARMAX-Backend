import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { SessionsRepository } from './sessions.repository.js';
import { sessionsRoutes } from './sessions.routes.js';
import { SessionsService } from './sessions.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    sessionsRepository: SessionsRepository;
    sessionsService: SessionsService;
  }
}

/** Refresh-token sessions: rotation, reuse detection, revocation. Routes: `/me/sessions`. */
export const sessionsModule = defineModule({
  name: 'sessions',
  prefix: '/me/sessions',
  register: (container) => {
    container.register({
      sessionsRepository: asClass(SessionsRepository).singleton(),
      sessionsService: asClass(SessionsService).singleton(),
    });
  },
  routes: sessionsRoutes,
});
