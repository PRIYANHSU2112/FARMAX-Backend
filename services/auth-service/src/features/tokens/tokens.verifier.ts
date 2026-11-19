import { toAuthUser } from '@farmx/common/auth';
import { ServiceUnavailableError } from '@farmx/common/errors';
import type { TokenVerifier } from '@farmx/common/middleware';
import { authKeys } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';

/**
 * Access-token verifier used by `authenticate`: signature and claims (CPU only, < 1 ms), then ONE
 * Redis round trip for the logout blacklist (`revoked:jti`) and revoked sessions (`revoked:sid`).
 * Bad or revoked token → 401. Redis down → 503 (fail closed, never "allow").
 */
export const createTokenVerifier =
  ({ tokensService, redis }: Pick<Cradle, 'tokensService' | 'redis'>): TokenVerifier =>
  async (token) => {
    const claims = tokensService.verifyAccessToken(token);
    let flags: (string | null)[];
    try {
      flags = await redis.mget(authKeys.revokedJti(claims.jti), authKeys.revokedSid(claims.sid));
    } catch (error) {
      throw new ServiceUnavailableError('Session store unavailable', { cause: error });
    }
    const [jtiRevoked = null, sidRevoked = null] = flags;
    if (jtiRevoked !== null || sidRevoked !== null) throw new Error('token revoked');
    return toAuthUser(claims);
  };
