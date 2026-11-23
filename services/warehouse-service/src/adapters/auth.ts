import { loadJwtPublicKey, parseAccessClaims, toAuthUser, verifyJwt } from '@farmx/common/auth';
import { ServiceUnavailableError } from '@farmx/common/errors';
import type { Logger } from '@farmx/common/logger';
import { INTERNAL_TOKEN_HEADER, type TokenVerifier } from '@farmx/common/middleware';
import { type Redis, authKeys } from '@farmx/infra/redis';

import type { WarehouseConfig } from '../config/index.js';

/**
 * Verifies auth-service access tokens with its PUBLIC key, then checks the logout / session
 * revocation flags in one Redis round trip (MGET). Fails closed when Redis is down.
 */
export function buildTokenVerifier(
  config: WarehouseConfig,
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

/** A user's effective permissions: GLOBAL, plus extra grants per warehouse (D-56). */
export interface Grants {
  permissions: readonly string[];
  warehouses: Readonly<Record<string, readonly string[]>>;
}

const NONE: Grants = { permissions: [], warehouses: {} };

/** Shape written by auth-service (`s: 2` carries `warehouses`). */
interface CachedAccess {
  v: string;
  s?: number;
  permissions: string[];
  warehouses?: Record<string, string[]>;
}

/**
 * Default-deny, warehouse-aware permission lookup: auth-service's cached access summary in
 * redis-cache (1 MGET, valid while `v` = RBAC version and the entry has the scoped shape), else
 * `/internal/access/:userId/permissions`. Any failure denies (no grants).
 */
export class AccessClient {
  constructor(
    private readonly deps: { config: WarehouseConfig; logger: Logger; redis: () => Redis },
  ) {}

  async grants(userId: string): Promise<Grants> {
    const { redis, logger, config } = this.deps;
    try {
      const [version, raw] = await redis().mget(
        authKeys.rbacVersion(),
        authKeys.permissions(userId),
      );
      if (typeof raw === 'string') {
        const cached = JSON.parse(raw) as CachedAccess;
        if (cached.v === (version ?? '0') && cached.s === 2 && cached.warehouses !== undefined)
          return { permissions: cached.permissions, warehouses: cached.warehouses };
      }
    } catch (err) {
      logger.warn({ err }, 'permission cache unavailable; asking auth-service');
    }
    if (config.INTERNAL_SERVICE_TOKEN === undefined) return NONE;
    try {
      const res = await fetch(`${config.AUTH_SERVICE_URL}/internal/access/${userId}/permissions`, {
        headers: { [INTERNAL_TOKEN_HEADER]: config.INTERNAL_SERVICE_TOKEN },
        signal: AbortSignal.timeout(1_500),
      });
      if (!res.ok) return NONE;
      const body = (await res.json()) as { data?: Partial<Grants> };
      return {
        permissions: body.data?.permissions ?? [],
        warehouses: body.data?.warehouses ?? {},
      };
    } catch (err) {
      logger.warn({ err }, 'auth-service permission lookup failed; denying');
      return NONE;
    }
  }
}
