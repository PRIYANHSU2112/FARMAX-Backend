import { loadJwtPublicKey, parseAccessClaims, toAuthUser, verifyJwt } from '@farmx/common/auth';
import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER, type TokenVerifier } from '@farmx/common/middleware';
import { type Redis, authKeys } from '@farmx/infra/redis';

import type { PaymentConfig } from '../config/index.js';

/**
 * Verifies auth-service access tokens with its PUBLIC key, then checks the logout / session
 * revocation flags in one Redis round trip (MGET). Fails closed when Redis is down.
 */
export function buildTokenVerifier(
  config: PaymentConfig,
  logger: Logger,
  redis: () => Redis,
): TokenVerifier {
  if (config.JWT_PUBLIC_KEY === undefined) {
    logger.warn('JWT_PUBLIC_KEY not set: every protected route answers 401.');
    return () => Promise.reject(new Error('JWT_PUBLIC_KEY not configured'));
  }
  const key = loadJwtPublicKey(config.JWT_KEY_ID, config.JWT_PUBLIC_KEY);
  const options = { issuer: config.JWT_ISSUER, audience: config.JWT_AUDIENCE };
  return async (token) => {
    const claims = parseAccessClaims(verifyJwt(token, key, options));
    let flags: (string | null)[];
    try {
      flags = await redis().mget(authKeys.revokedJti(claims.jti), authKeys.revokedSid(claims.sid));
    } catch (error) {
      throw new ServiceUnavailableError('Session store unavailable', { cause: error });
    }
    if (flags.some((flag) => flag !== null)) throw new Error('token revoked');
    return toAuthUser(claims);
  };
}

interface CachedAccess {
  v: string;
  permissions: string[];
}

/**
 * Default-deny permission checks (D-23): auth-service's cached access summary in redis-cache
 * (1 MGET, valid while `v` = RBAC version), else `/internal/access/:userId/permissions`.
 * Any failure denies.
 */
export class AccessClient {
  constructor(private readonly deps: { config: PaymentConfig; logger: Logger; redis: () => Redis }) {}

  async hasPermission(userId: string, key: string): Promise<boolean> {
    return (await this.permissions(userId)).includes(key);
  }

  private async permissions(userId: string): Promise<readonly string[]> {
    const { redis, logger, config } = this.deps;
    try {
      const [version, raw] = await redis().mget(
        authKeys.rbacVersion(),
        authKeys.permissions(userId),
      );
      if (typeof raw === 'string') {
        const cached = JSON.parse(raw) as CachedAccess;
        if (cached.v === (version ?? '0')) return cached.permissions;
      }
    } catch (err) {
      logger.warn({ err }, 'permission cache unavailable; asking auth-service');
    }
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return [];
    try {
      const res = await fetch(`${config.AUTH_SERVICE_URL}/internal/access/${userId}/permissions`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: { permissions?: string[] } };
      return body.data?.permissions ?? [];
    } catch (err) {
      logger.warn({ err }, 'auth-service permission lookup failed; denying');
      return [];
    }
  }
}
