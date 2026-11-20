import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { PreferencesRepository } from './preferences.repository.js';
import { preferencesRoutes } from './preferences.routes.js';
import { PreferencesService } from './preferences.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    preferencesRepository: PreferencesRepository;
    preferencesService: PreferencesService;
  }
}

/** Per-user channel choices per category, at `/notifications/preferences`. */
export const preferencesModule = defineModule({
  name: 'preferences',
  prefix: '/notifications/preferences',
  register: (container) => {
    container.register({
      preferencesRepository: asClass(PreferencesRepository).singleton(),
      preferencesService: asClass(PreferencesService).singleton(),
    });
  },
  routes: preferencesRoutes,
});
