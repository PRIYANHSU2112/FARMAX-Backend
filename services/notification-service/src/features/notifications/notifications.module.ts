import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { NotificationsAdminRepository } from './notifications.admin.repository.js';
import { adminRoutes } from './notifications.admin.routes.js';
import { NotificationsAdminService } from './notifications.admin.service.js';
import { DeliveriesRepository } from './notifications.deliveries.repository.js';
import { DeliveryService } from './notifications.delivery.service.js';
import { InboxService } from './notifications.inbox.service.js';
import { NotificationsRepository } from './notifications.repository.js';
import { inboxRoutes } from './notifications.routes.js';
import { NotificationsService } from './notifications.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    notificationsRepository: NotificationsRepository;
    notificationsService: NotificationsService;
    inboxService: InboxService;
    deliveriesRepository: DeliveriesRepository;
    deliveryService: DeliveryService;
    notificationsAdminRepository: NotificationsAdminRepository;
    notificationsAdminService: NotificationsAdminService;
  }
}

/** Notification creation + fan-out, and the user inbox at `/notifications`. */
export const notificationsModule = defineModule({
  name: 'notifications',
  prefix: '/notifications',
  register: (container) => {
    container.register({
      notificationsRepository: asClass(NotificationsRepository).singleton(),
      notificationsService: asClass(NotificationsService).singleton(),
      inboxService: asClass(InboxService).singleton(),
      deliveriesRepository: asClass(DeliveriesRepository).singleton(),
      deliveryService: asClass(DeliveryService).singleton(),
      notificationsAdminRepository: asClass(NotificationsAdminRepository).singleton(),
      notificationsAdminService: asClass(NotificationsAdminService).singleton(),
    });
  },
  routes: inboxRoutes,
});

/** Staff: send / schedule / cancel, deliveries + retry, analytics at `/admin/notifications`. */
export const notificationsAdminModule = defineModule({
  name: 'notifications-admin',
  prefix: '/admin/notifications',
  routes: adminRoutes,
});
