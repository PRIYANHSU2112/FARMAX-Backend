import {
  ConflictError,
  ForbiddenError,
  RateLimitError,
  UnauthorizedError,
} from '@farmx/common/errors';
import { authenticate } from '@farmx/common/middleware';
import type { UserType } from '@farmx/common/types';
import { farmKeys, hitRateLimit } from '@farmx/infra/redis';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

/** Permission keys this service checks (must exist in auth's permissions.catalog.ts). */
export const FARM_PERMISSIONS = new Set([
  'customers.view',
  'customers.create',
  'customers.update',
  'customers.verify',
  'customers.merge',
  'customers.suspend',
  'territories.manage',
  'content.view',
  'content.manage',
  'content.review',
  'content.publish',
]);

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
  if (!FARM_PERMISSIONS.has(key)) throw new Error(`requirePermission: unknown permission "${key}"`);
  return async (request) => {
    if (request.user === null) throw new UnauthorizedError();
    const allowed = await request.diScope
      .resolve('accessClient')
      .hasPermission(request.user.id, key);
    if (!allowed) throw new ForbiddenError();
  };
};

/** Customer routes. */
export const customer = [requireAuth('CUSTOMER')];
/** Admin routes: INTERNAL staff, full (MFA) scope, permission key. */
export const admin = (permission: string) => [
  requireAuth('INTERNAL'),
  requirePermission(permission),
];

/**
 * preHandler: fixed-window limit per user (or IP for public routes), 1 atomic Redis round trip.
 * Redis down → allow (availability over limiting; auth itself already failed closed).
 */
export const rateLimit =
  (action: string, limit: number, windowSeconds: number): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const userId = request.user?.id;
    const key =
      userId === undefined
        ? farmKeys.rateLimit(action, 'ip', request.ip.replaceAll(':', '.'))
        : farmKeys.rateLimit(action, 'user', userId);
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
  const redisKey = farmKeys.idempotency(request.user.id, key);
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
