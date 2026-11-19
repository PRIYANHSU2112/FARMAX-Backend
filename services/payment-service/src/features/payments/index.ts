// Public API of the payments feature. Other features import ONLY from here.
import { defineModule } from '@farmx/common/server';
import { asClass, asFunction } from 'awilix';

import type { EventHandlerMap } from '../../adapters/events.js';
import { createPaymentEventHandlers } from './payments.events.js';
import { PaymentsRepository } from './payments.repository.js';
import { paymentsAdminRoutes, paymentsInternalRoutes, paymentsRoutes } from './payments.routes.js';
import { PaymentsService } from './payments.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    paymentsRepository: PaymentsRepository;
    paymentsService: PaymentsService;
    paymentEventHandlers: EventHandlerMap;
  }
}

export const paymentsModule = defineModule({
  name: 'payments',
  prefix: '/payments',
  register: (container) => {
    container.register({
      paymentsRepository: asClass(PaymentsRepository).singleton(),
      paymentsService: asClass(PaymentsService).singleton(),
      paymentEventHandlers: asFunction(createPaymentEventHandlers).singleton(),
    });
  },
  routes: paymentsRoutes,
});

export const paymentsAdminModule = defineModule({
  name: 'payments-admin',
  prefix: '/admin/payments',
  routes: paymentsAdminRoutes,
});

export const paymentsInternalModule = defineModule({
  name: 'payments-internal',
  prefix: '/internal/payments',
  routes: paymentsInternalRoutes,
});

export type { PaymentsService } from './payments.service.js';
export { newNumber } from './payments.service.js';
export type { PaymentRow } from './payments.types.js';
export { ADMIN_PAYMENTS_TAG, PAYMENTS_TAG } from './payments.docs.js';
