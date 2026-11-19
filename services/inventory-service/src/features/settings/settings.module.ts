import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { SettingsRepository } from './settings.repository.js';
import { settingsRoutes } from './settings.routes.js';
import { SettingsService } from './settings.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    settingsRepository: SettingsRepository;
    settingsService: SettingsService;
  }
}

export const settingsModule = defineModule({
  name: 'settings',
  prefix: '/admin/inventory/settings',
  register: (container) => {
    container.register({
      settingsRepository: asClass(SettingsRepository).singleton(),
      settingsService: asClass(SettingsService).singleton(),
    });
  },
  routes: settingsRoutes,
});
