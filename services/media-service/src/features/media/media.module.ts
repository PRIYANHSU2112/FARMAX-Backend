import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { MediaController } from './media.controller.js';
import { mediaRoutes } from './media.routes.js';
import { MediaService } from './media.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    mediaService: MediaService;
    mediaController: MediaController;
  }
}

/** Upload + compression to DigitalOcean Spaces. Routes: `POST /upload`. */
export const mediaModule = defineModule({
  name: 'media',
  register: (container) => {
    container.register({
      mediaService: asClass(MediaService).singleton(),
      mediaController: asClass(MediaController).singleton(),
    });
  },
  routes: mediaRoutes,
});
