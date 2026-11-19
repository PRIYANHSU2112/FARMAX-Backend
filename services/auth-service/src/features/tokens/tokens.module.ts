import { defineModule } from '@farmx/common/server';
import { asClass } from 'awilix';

import type { JwtKeys } from '@farmx/common/auth';
import { tokensRoutes } from './tokens.routes.js';
import { TokensService } from './tokens.service.js';

declare module '@fastify/awilix' {
  interface Cradle {
    /** Ed25519 signing keys (from env; ephemeral only in local/test). Registered in container.ts. */
    jwtKeys: JwtKeys;
    tokensService: TokensService;
  }
}

export const tokensModule = defineModule({
  name: 'tokens',
  register: (container) => {
    container.register({ tokensService: asClass(TokensService).singleton() });
  },
  routes: tokensRoutes,
});
