import { routeDocs } from '@farmx/common/server';
import type { FastifyPluginAsync } from 'fastify';

import { TOKENS_DOCS } from './tokens.docs.js';

/** `/.well-known/jwks.json` — the raw JWK Set (standard format, not wrapped in the envelope). */
export const tokensRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/.well-known/jwks.json',
    { schema: routeDocs(TOKENS_DOCS.jwks), logLevel: 'warn' },
    async (request, reply) => {
      void reply.header('cache-control', 'public, max-age=300');
      return request.diScope.resolve('tokensService').getJwks();
    },
  );
};
