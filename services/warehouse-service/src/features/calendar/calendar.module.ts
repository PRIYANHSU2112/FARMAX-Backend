import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { CalendarRepository } from './calendar.repository.js';
import { calendarRoutes } from './calendar.routes.js';
import { CalendarService } from './calendar.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    calendarRepository: CalendarRepository;
    calendarService: CalendarService;
  }
}

/** Weekly hours, shifts, holidays and order cut-offs (W2.09, D-56). */
export const calendarModule = defineModule({
  name: 'calendar',
  prefix: '/admin/warehouses',
  register: (container) => {
    container.register({
      calendarRepository: asClass(CalendarRepository).singleton(),
      calendarService: asClass(CalendarService).singleton(),
    });
  },
  routes: calendarRoutes,
});
