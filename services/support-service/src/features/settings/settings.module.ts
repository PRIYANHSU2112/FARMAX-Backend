import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { SettingsRepository } from './settings.repository.js';
import { settingsAdminRoutes } from './settings.routes.js';
import { SettingsService } from './settings.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    settingsRepository: SettingsRepository;
    settingsService: SettingsService;
  }
}

/** Contacts, limits, chat switch, business-hours calendars (`/support/admin/settings|calendars`). */
export const settingsModule = defineModule({
  name: 'settings',
  prefix: '/support/admin',
  register: (container) => {
    container.register({
      settingsRepository: asClass(SettingsRepository).singleton(),
      settingsService: asClass(SettingsService).singleton(),
    });
  },
  routes: settingsAdminRoutes,
});
