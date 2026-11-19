import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createProjectionEventHandlers } from './projections.events.js';
import { ProjectionsRepository } from './projections.repository.js';
import { ProjectionsService } from './projections.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    projectionsRepository: ProjectionsRepository;
    projectionsService: ProjectionsService;
    projectionEventHandlers: EventHandlerMap;
  }
}

/** Read models of variants, prices and farms (no routes; fed by events). */
export const projectionsModule = defineModule({
  name: 'projections',
  register: (container) => {
    container.register({
      projectionsRepository: asClass(ProjectionsRepository).singleton(),
      projectionsService: asClass(ProjectionsService).singleton(),
      projectionEventHandlers: asFunction(createProjectionEventHandlers).singleton(),
    });
  },
});
