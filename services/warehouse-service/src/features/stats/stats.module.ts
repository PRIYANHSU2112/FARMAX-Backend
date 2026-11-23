import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { StatsRepository } from './stats.repository.js';
import { statsRoutes } from './stats.routes.js';
import { StatsService } from './stats.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    statsRepository: StatsRepository;
    statsService: StatsService;
  }
}

/** Stock snapshots from inventory-service + W2.03 overview / stock tab (D-56 P3). */
export const statsModule = defineModule({
  name: 'stats',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      statsRepository: asClass(StatsRepository).singleton(),
      statsService: asClass(StatsService).singleton(),
    });
  },
  routes: statsRoutes,
});
