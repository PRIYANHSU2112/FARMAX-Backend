import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { TransactionsRepository } from './transactions.repository.js';
import { TransactionsService } from './transactions.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    transactionsRepository: TransactionsRepository;
    transactionsService: TransactionsService;
  }
}

/** Order money ledger (routes live in the orders feature, which checks ownership). */
export const transactionsModule = defineModule({
  name: 'transactions',
  register: (container) => {
    container.register({
      transactionsRepository: asClass(TransactionsRepository).singleton(),
      transactionsService: asClass(TransactionsService).singleton(),
    });
  },
});
