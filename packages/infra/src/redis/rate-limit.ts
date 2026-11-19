import type { Redis } from 'ioredis';

export type RateLimitClient = Pick<Redis, 'eval'>;

/** INCR + EXPIRE-on-first-hit + TTL in one atomic round trip (fixed window). */
const HIT_SCRIPT = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], ARGV[1]) end
local ttl = redis.call("TTL", KEYS[1])
if ttl < 0 then redis.call("EXPIRE", KEYS[1], ARGV[1]); ttl = tonumber(ARGV[1]) end
return { count, ttl }`;

export interface RateLimitResult {
  allowed: boolean;
  count: number;
  limit: number;
  remaining: number;
  /** Seconds until the window resets. */
  retryAfterSeconds: number;
}

/**
 * Fixed-window counter on redis-cache. Counts every hit (including refused ones), so a client
 * hammering a limited endpoint stays limited until the window ends.
 */
export async function hitRateLimit(
  client: RateLimitClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error('limit must be a positive integer');
  if (!Number.isInteger(windowSeconds) || windowSeconds <= 0) {
    throw new Error('windowSeconds must be a positive integer');
  }
  const [count, ttl] = (await client.eval(HIT_SCRIPT, 1, key, windowSeconds)) as [number, number];
  return {
    allowed: count <= limit,
    count,
    limit,
    remaining: Math.max(limit - count, 0),
    retryAfterSeconds: Math.max(ttl, 1),
  };
}
