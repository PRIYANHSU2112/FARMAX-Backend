import {
  ConflictError,
  ForbiddenError,
  RateLimitError,
  UnauthorizedError,
  isAppError,
} from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import type { UserType } from '@farmx/common/types';
import { userKeys, hitRateLimit } from '@farmx/infra/redis';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

/** Permission keys this service checks (must exist in auth's permissions.catalog.ts). */
export const USER_PERMISSIONS = new Set([
  'customers.view',
  'home_layout.view',
  'home_layout.manage',
  'home_layout.publish',
]);

/**
 * How the caller's token looked on an optional-auth route (home): `none` = no token, `ok` = valid,
 * `expired` = invalid or expired (served as a guest; the app refreshes quietly),
 * `unavailable` = could not be checked (revocation store down; served as a guest).
 */
export type AuthState = 'none' | 'ok' | 'expired' | 'unavailable';

const authStates = new WeakMap<FastifyRequest, AuthState>();

export const authStateOf = (request: FastifyRequest): AuthState =>
  authStates.get(request) ?? 'none';

/** The raw bearer token (to forward to another service on the caller's behalf). */
export const bearerOf = (request: FastifyRequest): string | undefined => {
  const header = request.headers.authorization;
  if (header === undefined) return undefined;
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token !== undefined && token !== ''
    ? token
    : undefined;
};

/**
 * preHandler for routes that must never fail on auth (home): a valid full-scope token sets
 * `request.user`; anything else leaves the caller a guest and records why (`authStateOf`).
 */
export const optionalAuth: preHandlerAsyncHookHandler = async (request) => {
  const token = bearerOf(request);
  if (token === undefined) {
    authStates.set(request, 'none');
    return;
  }
  try {
    const user = await request.diScope.resolve('tokenVerifier')(token);
    if (user.scope === 'full') request.user = user;
    authStates.set(request, user.scope === 'full' ? 'ok' : 'none');
  } catch (err) {
    authStates.set(request, isAppError(err) && err.statusCode >= 500 ? 'unavailable' : 'expired');
  }
};

/** preHandler: valid, non-revoked access token with FULL scope; optionally a persona. */
export const requireAuth = (...userTypes: UserType[]): preHandlerAsyncHookHandler =>
  async function (request, reply) {
    const verify = request.diScope.resolve('tokenVerifier');
    await authenticate(verify).call(this, request, reply);
    const user = request.user;
    if (user?.scope !== 'full') throw new ForbiddenError('Finish MFA enrolment first');
    if (userTypes.length > 0 && !userTypes.includes(user.userType)) throw new ForbiddenError();
  };

/** preHandler (after requireAuth): default deny. Unknown keys throw at registration. */
export const requirePermission = (key: string): preHandlerAsyncHookHandler => {
  if (!USER_PERMISSIONS.has(key)) throw new Error(`requirePermission: unknown permission "${key}"`);
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope
      .resolve('accessClient')
      .hasPermission(request.user.id, key);
    if (!allowed) throw new ForbiddenError();
  };
};

/** Customer self-service routes (`/me/*`). */
export const customer = [requireAuth('CUSTOMER')];

/** Admin routes: INTERNAL staff, full (MFA) scope, permission key. */
export const admin = (permission: string) => [
  requireAuth('INTERNAL'),
  requirePermission(permission),
];

/**
 * preHandler: fixed-window limit per user (or IP for public routes), 1 atomic Redis round trip.
 * Redis down → allow (availability over limiting).
 */
export const rateLimit =
  (action: string, limit: number, windowSeconds: number): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const userId = request.user?.id;
    const key =
      userId === undefined
        ? userKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : userKeys.rateLimit(action, 'user', userId);
    let result;
    try {
      result = await hitRateLimit(request.diScope.resolve('redis'), key, limit, windowSeconds);
    } catch (err) {
      request.log.warn({ err }, 'rate limit store unavailable; allowing');
      return;
    }
    if (!result.allowed) {
      void reply.header('retry-after', String(result.retryAfterSeconds));
      throw new RateLimitError(result.retryAfterSeconds);
    }
  };

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._-]{8,64}$/;

/**
 * Replays the stored response of a POST retried with the same `Idempotency-Key` (24 h, per user).
 * A concurrent duplicate while the first is still running gets 409.
 */
export async function idempotent<T>(
  request: FastifyRequest,
  work: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T }> {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || request.user === null || !IDEMPOTENCY_KEY.test(key)) return work();

  const redis = request.diScope.resolve('redis');
  const redisKey = userKeys.idempotency(request.user.id, key);
  const existing = await redis.get(redisKey).catch(() => null);
  if (existing !== null) {
    if (existing === 'pending')
      throw new ConflictError('A request with this Idempotency-Key is in progress');
    return JSON.parse(existing) as { status: number; body: T };
  }
  const claimed = await redis.set(redisKey, 'pending', 'EX', 60, 'NX').catch(() => 'OK');
  if (claimed !== 'OK')
    throw new ConflictError('A request with this Idempotency-Key is in progress');
  try {
    const result = await work();
    await redis.set(redisKey, JSON.stringify(result), 'EX', 86_400).catch(() => undefined);
    return result;
  } catch (error) {
    await redis.del(redisKey).catch(() => undefined);
    throw error;
  }
}
