import { UnauthorizedError, isAppError } from '../errors/index.js';
import type { AuthUser } from '../types/index.js';
import type { FastifyPluginCallback, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import fp from 'fastify-plugin';

import { setContextUser } from './request-context.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by `authenticate`; `null` on public routes. */
    user: AuthUser | null;
  }
}

/**
 * Verifies an access token and returns the caller. Throws on invalid/expired tokens.
 * The JWT (EdDSA + JWKS) implementation is provided by auth features later.
 */
export type TokenVerifier = (token: string) => Promise<AuthUser>;

const plugin: FastifyPluginCallback = (app, _opts, done) => {
  app.decorateRequest('user', null);
  done();
};

/** Declares `request.user` (once per app, for V8 shape stability). */
export const authContextPlugin = fp(plugin, { name: '@farmx/auth-context' });

const extractBearer = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
};

/** preHandler: requires a valid `Authorization: Bearer <token>`. */
export const authenticate =
  (verify: TokenVerifier): preHandlerAsyncHookHandler =>
  async (request) => {
    const token = extractBearer(request);
    if (token === undefined) throw new UnauthorizedError();

    try {
      request.user = await verify(token);
    } catch (error) {
      // Infrastructure failures (e.g. revocation store down) surface as 5xx, not as "bad token".
      if (isAppError(error) && error.statusCode >= 500) throw error;
      throw new UnauthorizedError('Invalid or expired token', { cause: error });
    }
    setContextUser(request.user.id);
  };
