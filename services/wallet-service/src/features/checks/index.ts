// Public API of the checks feature (ledger reconciliation).
import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { ChecksRepository } from './checks.repository.js';
import { checksRoutes } from './checks.routes.js';
import { ChecksService } from './checks.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    checksRepository: ChecksRepository;
    checksService: ChecksService;
  }
}

export const checksModule = defineModule({
  name: 'checks',
  prefix: '/admin/wallet/ledger-checks',
  register: (container) => {
    container.register({
      checksRepository: asClass(ChecksRepository).singleton(),
      checksService: asClass(ChecksService).singleton(),
    });
  },
  routes: checksRoutes,
});
