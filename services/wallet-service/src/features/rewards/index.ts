// Public API of the rewards feature (reward points). Other features import ONLY from here.
import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createRewardEventHandlers } from './rewards.events.js';
import { RewardsRepository } from './rewards.repository.js';
import { rewardsRoutes } from './rewards.routes.js';
import { RewardsService } from './rewards.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    rewardsRepository: RewardsRepository;
    rewardsService: RewardsService;
    rewardEventHandlers: EventHandlerMap;
  }
}

export const rewardsModule = defineModule({
  name: 'rewards',
  prefix: '/rewards',
  register: (container) => {
    container.register({
      rewardsRepository: asClass(RewardsRepository).singleton(),
      rewardsService: asClass(RewardsService).singleton(),
      rewardEventHandlers: asFunction(createRewardEventHandlers).singleton(),
    });
  },
  routes: rewardsRoutes,
});

export type { RewardsService } from './rewards.service.js';
export { REWARDS_TAG } from './rewards.docs.js';
