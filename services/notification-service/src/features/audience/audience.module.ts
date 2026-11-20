import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { AudienceRepository } from './audience.repository.js';
import { AudienceService } from './audience.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    audienceRepository: AudienceRepository;
    audienceService: AudienceService;
  }
}

/** Audience resolution + the order → buyer projection (from order.placed.v1). */
export const audienceModule = defineModule({
  name: 'audience',
  register: (container) => {
    container.register({
      audienceRepository: asClass(AudienceRepository).singleton(),
      audienceService: asClass(AudienceService).singleton(),
    });
  },
});
