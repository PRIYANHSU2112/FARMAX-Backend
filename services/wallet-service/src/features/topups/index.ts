// Public API of the topups feature. Other features import ONLY from here.
import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createTopupEventHandlers } from './topups.events.js';
import { TopupsRepository } from './topups.repository.js';
import { topupsRoutes } from './topups.routes.js';
import { TopupsService } from './topups.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    topupsRepository: TopupsRepository;
    topupsService: TopupsService;
    topupEventHandlers: EventHandlerMap;
  }
}

export const topupsModule = defineModule({
  name: 'topups',
  prefix: '/wallet/topups',
  register: (container) => {
    container.register({
      topupsRepository: asClass(TopupsRepository).singleton(),
      topupsService: asClass(TopupsService).singleton(),
      topupEventHandlers: asFunction(createTopupEventHandlers).singleton(),
    });
  },
  routes: topupsRoutes,
});

export type { TopupsService } from './topups.service.js';
export { TOPUPS_TAG } from './topups.docs.js';
export type { TopupRow } from './topups.types.js';
