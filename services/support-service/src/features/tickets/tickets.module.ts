import { defineModule } from '@farmx/common/server';
import type { Cradle } from '@fastify/awilix';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { TicketsAdminService } from './tickets.admin.service.js';
import { createTicketEventHandlers } from './tickets.events.js';
import { TicketsJobs } from './tickets.jobs.js';
import { TicketsRepository } from './tickets.repository.js';
import { ticketsAdminRoutes } from './tickets.admin.routes.js';
import { ticketsRoutes } from './tickets.routes.js';
import { TicketsService } from './tickets.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    ticketsRepository: TicketsRepository;
    ticketsService: TicketsService;
    ticketsAdminService: TicketsAdminService;
    ticketsJobs: TicketsJobs;
    ticketEventHandlers: EventHandlerMap;
  }
}

/** Tickets: requester routes (`/support/tickets`) + agent queue (`/support/admin/tickets`). */
export const ticketsModule = defineModule({
  name: 'tickets',
  prefix: '/support',
  register: (container) => {
    container.register({
      ticketsRepository: asClass(TicketsRepository).singleton(),
      ticketsService: asClass(TicketsService).singleton(),
      ticketsAdminService: asClass(TicketsAdminService).singleton(),
      ticketsJobs: asClass(TicketsJobs).singleton(),
      ticketEventHandlers: asFunction((cradle: Cradle) => createTicketEventHandlers(cradle)).singleton(),
    });
  },
  routes: async (app) => {
    await app.register(ticketsRoutes, { prefix: '/tickets' });
    await app.register(ticketsAdminRoutes, { prefix: '/admin/tickets' });
  },
});
