import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { TeamRepository } from './team.repository.js';
import { teamRoutes } from './team.routes.js';
import { TeamService } from './team.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    teamRepository: TeamRepository;
    teamService: TeamService;
  }
}

/** Warehouse team (W2.06, D-56): invite-only staff via auth-service + warehouse facts. */
export const teamModule = defineModule({
  name: 'team',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      teamRepository: asClass(TeamRepository).singleton(),
      teamService: asClass(TeamService).singleton(),
    });
  },
  routes: teamRoutes,
});
