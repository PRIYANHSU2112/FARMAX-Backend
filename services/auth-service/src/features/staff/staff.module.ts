import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import { staffInternalRoutes } from './staff.internal.routes.js';
import { StaffService } from './staff.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    staffService: StaffService;
  }
}

/**
 * Invite-only warehouse staff (D-56): `/internal/staff/*` for warehouse-service. The public half
 * (accepting an invitation) lives in the auth feature: `POST /auth/invitations/accept`.
 */
export const staffInternalModule = defineModule({
  name: 'staff-internal',
  prefix: '/internal/staff',
  register: (container) => {
    container.register({ staffService: asClass(StaffService).singleton() });
  },
  routes: staffInternalRoutes,
});
