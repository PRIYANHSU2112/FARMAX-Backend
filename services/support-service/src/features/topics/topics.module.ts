import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { TopicsRepository } from './topics.repository.js';
import { topicsRoutes } from './topics.routes.js';
import { TopicsService } from './topics.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    topicsRepository: TopicsRepository;
    topicsService: TopicsService;
  }
}

/** Help home config, ticket topics, priority rules, SLA policies. */
export const topicsModule = defineModule({
  name: 'topics',
  prefix: '/support',
  register: (container) => {
    container.register({
      topicsRepository: asClass(TopicsRepository).singleton(),
      topicsService: asClass(TopicsService).singleton(),
    });
  },
  routes: topicsRoutes,
});
