import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { FaqsRepository } from './faqs.repository.js';
import { faqsRoutes } from './faqs.routes.js';
import { FaqsService } from './faqs.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    faqsRepository: FaqsRepository;
    faqsService: FaqsService;
  }
}

/** FAQ categories + items, search, suggestions, votes (`/faqs/*`, `/support/suggestions`). */
export const faqsModule = defineModule({
  name: 'faqs',
  register: (container) => {
    container.register({
      faqsRepository: asClass(FaqsRepository).singleton(),
      faqsService: asClass(FaqsService).singleton(),
    });
  },
  routes: faqsRoutes,
});
