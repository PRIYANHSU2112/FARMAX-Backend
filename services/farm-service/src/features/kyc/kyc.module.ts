import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { KycRepository } from './kyc.repository.js';
import { kycAdminRoutes, kycRoutes } from './kyc.routes.js';
import { KycService } from './kyc.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    kycRepository: KycRepository;
    kycService: KycService;
  }
}

export const kycModule = defineModule({
  name: 'kyc',
  prefix: '/farms',
  register: (container) => {
    container.register({
      kycRepository: asClass(KycRepository).singleton(),
      kycService: asClass(KycService).singleton(),
    });
  },
  routes: kycRoutes,
});

export const kycAdminModule = defineModule({
  name: 'kyc-admin',
  prefix: '/admin/farms',
  routes: kycAdminRoutes,
});
