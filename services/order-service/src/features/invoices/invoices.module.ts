import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { InvoicesRepository } from './invoices.repository.js';
import { invoicesAdminRoutes, invoicesRoutes } from './invoices.routes.js';
import { InvoicesService } from './invoices.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    invoicesRepository: InvoicesRepository;
    invoicesService: InvoicesService;
  }
}

/**
 * GST tax documents (D-48, D-61): issued per shipment before gate-out (warehouse → internal
 * orders route), credit notes, customer downloads under `/orders/:id/invoices`.
 */
export const invoicesModule = defineModule({
  name: 'invoices',
  prefix: '/orders',
  register: (container) => {
    container.register({
      invoicesRepository: asClass(InvoicesRepository).singleton(),
      invoicesService: asClass(InvoicesService).singleton(),
    });
  },
  routes: invoicesRoutes,
});

/** Invoice register for finance / ops staff (`/admin/invoices`). */
export const invoicesAdminModule = defineModule({
  name: 'invoices-admin',
  prefix: '/admin/invoices',
  routes: invoicesAdminRoutes,
});
