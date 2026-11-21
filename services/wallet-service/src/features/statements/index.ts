// Public API of the statements feature ("Download statement" PDFs).
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { statementsRoutes } from './statements.routes.js';
import { StatementsService } from './statements.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    statementsService: StatementsService;
  }
}

export const statementsModule = defineModule({
  name: 'statements',
  prefix: '/wallet/statement',
  register: (container) => {
    container.register({ statementsService: asClass(StatementsService).singleton() });
  },
  routes: statementsRoutes,
});
