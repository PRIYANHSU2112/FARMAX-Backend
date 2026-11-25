import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { PaymentsViewRepository } from './payments-view.repository.js';
import { paymentsViewRoutes } from './payments-view.routes.js';
import { PaymentsViewService } from './payments-view.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    paymentsViewRepository: PaymentsViewRepository;
    paymentsViewService: PaymentsViewService;
  }
}

/** D-57b W3.18 payment view (prepaid): warehouse panel `/wms/payments-view/*`. */
export const paymentsViewModule = defineModule({
  name: 'payments-view',
  prefix: '/wms',
  register: (container) => {
    container.register({
      paymentsViewRepository: asClass(PaymentsViewRepository).singleton(),
      paymentsViewService: asClass(PaymentsViewService).singleton(),
    });
  },
  routes: paymentsViewRoutes('panel'),
});

/** Admin panel: same reads, every warehouse. */
export const paymentsViewAdminModule = defineModule({
  name: 'payments-view-admin',
  prefix: '/admin/wms',
  routes: paymentsViewRoutes('admin'),
});
