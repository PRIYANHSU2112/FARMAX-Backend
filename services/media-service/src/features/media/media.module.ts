import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { MediaController } from './media.controller.js';
import { mediaInternalRoutes } from './media.internal.routes.js';
import { mediaRoutes } from './media.routes.js';
import { MediaService } from './media.service.js';
import { SupportUploads } from './media.support.js';

declare module '@fastify/awilix' {
  interface Cradle {
    mediaService: MediaService;
    mediaController: MediaController;
    supportUploads: SupportUploads;
  }
}

/** Upload + compression to DigitalOcean Spaces. Routes: `POST /upload`. */
export const mediaModule = defineModule({
  name: 'media',
  register: (container) => {
    container.register({
      mediaService: asClass(MediaService).singleton(),
      mediaController: asClass(MediaController).singleton(),
      supportUploads: asClass(SupportUploads).singleton(),
    });
  },
  routes: async (app) => {
    await app.register(mediaRoutes);
    await app.register(mediaInternalRoutes, { prefix: '/internal/media' });
  },
});
