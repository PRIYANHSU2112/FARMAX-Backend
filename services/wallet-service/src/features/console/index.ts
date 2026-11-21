// Public API of the console feature (staff: wallets, journals, freeze, settings).
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { consoleRoutes } from './console.routes.js';
import { ConsoleService } from './console.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    consoleService: ConsoleService;
  }
}

export const consoleModule = defineModule({
  name: 'console',
  prefix: '/admin/wallet',
  register: (container) => {
    container.register({ consoleService: asClass(ConsoleService).singleton() });
  },
  routes: consoleRoutes,
});
