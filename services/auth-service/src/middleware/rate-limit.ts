import { createHash } from 'node:crypto';

import { RateLimitError } from '@farmx/common/errors';
import { authKeys, hitRateLimit } from '@farmx/infra/redis';
import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';

export interface RateLimitRule {
  /** Counter name, e.g. `otp-send`. */
  action: string;
  dimension: 'ip' | 'id' | 'dest' | 'user';
  /** Value to count by (IP, phone, identifier, user id). `undefined` skips the rule. */
  value: (request: FastifyRequest) => string | undefined;
  limit: number;
  windowSeconds: number;
}

/** Values are hashed: no raw phone numbers or IPs (IPv6 has ':') in Redis keys. */
const keyPart = (value: string): string =>
  createHash('sha256').update(value.trim().toLowerCase()).digest('hex').slice(0, 32);

/**
 * preHandler: fixed-window limits on redis-cache, one atomic round trip per rule. Exceeding any
 * rule → 429 with `Retry-After`. If Redis is down the request is refused with 503 (fail closed),
 * since these guard authentication endpoints.
 */
export const rateLimit =
  (...rules: RateLimitRule[]): preHandlerAsyncHookHandler =>
  async (request, reply) => {
    const redis = request.diScope.resolve('redis');
    for (const rule of rules) {
      const value = rule.value(request);
      if (value === undefined || value === '') continue;
      const key = authKeys.rateLimit(rule.action, rule.dimension, keyPart(value));
      const result = await hitRateLimit(redis, key, rule.limit, rule.windowSeconds);
      if (!result.allowed) {
        void reply.header('retry-after', String(result.retryAfterSeconds));
        throw new RateLimitError(result.retryAfterSeconds);
      }
    }
  };

/** Rule value helpers. */
export const byIp = (request: FastifyRequest): string => request.ip;
export const byBodyField =
  (field: string) =>
  (request: FastifyRequest): string | undefined => {
    const body = request.body as Record<string, unknown> | undefined;
    const value = body?.[field];
    return typeof value === 'string' ? value : undefined;
  };
