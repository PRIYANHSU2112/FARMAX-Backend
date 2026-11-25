import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { CertificatesRepository } from './certificates.repository.js';
import { certificatesRoutes, verifyRoutes } from './certificates.routes.js';
import { CertificatesService } from './certificates.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    certificatesRepository: CertificatesRepository;
    certificatesService: CertificatesService;
  }
}

/** Customer app: `/certificates/*` (own consignments and units only). */
export const certificatesModule = defineModule({
  name: 'certificates',
  prefix: '/certificates',
  register: (container) => {
    container.register({
      certificatesRepository: asClass(CertificatesRepository).singleton(),
      certificatesService: asClass(CertificatesService).singleton(),
    });
  },
  routes: certificatesRoutes,
});

/** Public verification (`/verify/:code`, verify.farmx.in): no login. */
export const verifyModule = defineModule({
  name: 'verify',
  prefix: '/verify',
  routes: verifyRoutes,
});
