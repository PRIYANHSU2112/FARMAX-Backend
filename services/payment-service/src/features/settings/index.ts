// Public API of the settings feature.
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { SettingsRepository } from './settings.repository.js';
import { SettingsService } from './settings.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    settingsRepository: SettingsRepository;
    settingsService: SettingsService;
  }
}

export const settingsModule = defineModule({
  name: 'settings',
  register: (container) => {
    container.register({
      settingsRepository: asClass(SettingsRepository).singleton(),
      settingsService: asClass(SettingsService).singleton(),
    });
  },
});

export type { PaymentSettings, SettingsService } from './settings.service.js';
