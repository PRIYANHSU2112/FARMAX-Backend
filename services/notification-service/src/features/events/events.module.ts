import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { EventsService } from './events.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    eventsService: EventsService;
  }
}

/** Business events → notifications (consumer: adapters/events.ts). */
export const eventsModule = defineModule({
  name: 'events',
  register: (container) => {
    container.register({ eventsService: asClass(EventsService).singleton() });
  },
});
