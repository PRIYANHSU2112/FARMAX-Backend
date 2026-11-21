// Public API of the ledger feature. Other features import ONLY from here.
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { LedgerRepository } from './ledger.repository.js';
import { ledgerRoutes } from './ledger.routes.js';
import { LedgerService } from './ledger.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    ledgerRepository: LedgerRepository;
    ledgerService: LedgerService;
  }
}

export const ledgerModule = defineModule({
  name: 'ledger',
  prefix: '/wallet',
  register: (container) => {
    container.register({
      ledgerRepository: asClass(LedgerRepository).singleton(),
      ledgerService: asClass(LedgerService).singleton(),
    });
  },
  routes: ledgerRoutes,
});

export type { LedgerService } from './ledger.service.js';
export { WALLET_TAG } from './ledger.docs.js';
export type * from './ledger.types.js';
export { rupees, STATUS_LABEL } from './ledger.types.js';
export { CATEGORIES, KINDS } from './ledger.validation.js';
