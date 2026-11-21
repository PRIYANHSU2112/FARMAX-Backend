import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ContentAdminService } from './content.admin.service.js';
import { ContentCounters } from './content.counters.js';
import { ContentJobs } from './content.jobs.js';
import { ContentRepository } from './content.repository.js';
import { contentAdminRoutes, contentInternalRoutes, contentRoutes } from './content.routes.js';
import { ContentService } from './content.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    contentRepository: ContentRepository;
    contentCounters: ContentCounters;
    contentService: ContentService;
    contentAdminService: ContentAdminService;
    contentJobs: ContentJobs;
  }
}

export const contentModule = defineModule({
  name: 'content',
  prefix: '/farms/content',
  register: (container) => {
    container.register({
      contentRepository: asClass(ContentRepository).singleton(),
      contentCounters: asClass(ContentCounters).singleton(),
      contentService: asClass(ContentService).singleton(),
      contentAdminService: asClass(ContentAdminService).singleton(),
      contentJobs: asClass(ContentJobs).singleton(),
    });
  },
  routes: contentRoutes,
});

export const contentAdminModule = defineModule({
  name: 'content-admin',
  prefix: '/admin/farms/content',
  routes: contentAdminRoutes,
});

export const contentInternalModule = defineModule({
  name: 'content-internal',
  prefix: '/internal/farms/content',
  routes: contentInternalRoutes,
});
