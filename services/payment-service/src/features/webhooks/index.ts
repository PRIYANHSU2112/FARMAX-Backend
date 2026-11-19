// Public API of the webhooks feature.
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { WebhooksRepository } from './webhooks.repository.js';
import { webhooksRoutes } from './webhooks.routes.js';
import { WebhooksService } from './webhooks.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    webhooksRepository: WebhooksRepository;
    webhooksService: WebhooksService;
  }
}

export const webhooksModule = defineModule({
  name: 'webhooks',
  prefix: '/webhooks',
  register: (container) => {
    container.register({
      webhooksRepository: asClass(WebhooksRepository).singleton(),
      webhooksService: asClass(WebhooksService).singleton(),
    });
  },
  routes: webhooksRoutes,
});

export type { WebhooksService } from './webhooks.service.js';
export { WEBHOOKS_TAG } from './webhooks.docs.js';
