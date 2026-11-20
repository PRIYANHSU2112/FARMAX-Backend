import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { InvoicesRepository } from './invoices.repository.js';
import { InvoicesService } from './invoices.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    invoicesRepository: InvoicesRepository;
    invoicesService: InvoicesService;
  }
}

/** GST tax documents (issued per shipment at dispatch: F1 calls the orders hook). */
export const invoicesModule = defineModule({
  name: 'invoices',
  register: (container) => {
    container.register({
      invoicesRepository: asClass(InvoicesRepository).singleton(),
      invoicesService: asClass(InvoicesService).singleton(),
    });
  },
});
