import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AgentsRepository } from './agents.repository.js';
import { agentsRoutes } from './agents.routes.js';
import { AgentsService } from './agents.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    agentsRepository: AgentsRepository;
    agentsService: AgentsService;
  }
}

/** Agents, availability, presence, auto-assign, canned replies (`/support/admin/agents|canned-replies`). */
export const agentsModule = defineModule({
  name: 'agents',
  prefix: '/support/admin',
  register: (container) => {
    container.register({
      agentsRepository: asClass(AgentsRepository).singleton(),
      agentsService: asClass(AgentsService).singleton(),
    });
  },
  routes: agentsRoutes,
});
