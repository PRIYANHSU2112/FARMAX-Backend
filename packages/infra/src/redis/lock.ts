import { randomBytes } from 'node:crypto';

import type { Logger } from '@farmx/common/logger';
import type { Redis } from 'ioredis';

export type LockClient = Pick<Redis, 'set' | 'eval'>;

/** Delete the key only if it still holds our token (never release someone else's lock). */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export interface Lock {
  readonly key: string;
  readonly token: string;
  /** `true` if we still held the lock and released it; `false` if it had expired or was taken. */
  release: () => Promise<boolean>;
}

/**
 * Acquires an *advisory* lease with `SET key token NX PX ttlMs`.
 *
 * This is an efficiency lock (avoid duplicate work), NOT a guarantee of mutual exclusion:
 * after the lease expires (slow holder, GC pause, Redis failover) another process may
 * acquire it while the first is still running. Anything that must be exclusive also needs
 * a database constraint or fencing token.
 *
 * Returns `null` when the lock is held by someone else.
 */
export async function acquireLock(
  client: LockClient,
  key: string,
  ttlMs: number,
): Promise<Lock | null> {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) throw new Error('ttlMs must be a positive integer');
  const token = randomBytes(16).toString('hex'); // 128-bit, cryptographically random
  const result = await client.set(key, token, 'PX', ttlMs, 'NX');
  if (result !== 'OK') return null;
  return {
    key,
    token,
    release: async () => (await client.eval(RELEASE_SCRIPT, 1, key, token)) === 1,
  };
}

/** Runs `fn` while holding the lease; returns `null` if the lock was not acquired. */
export async function withLock<T>(
  client: LockClient,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
  logger?: Logger,
): Promise<{ value: T } | null> {
  const lock = await acquireLock(client, key, ttlMs);
  if (!lock) return null;
  try {
    return { value: await fn() };
  } finally {
    try {
      if (!(await lock.release())) logger?.warn({ key }, 'lock lease expired before release');
    } catch (err) {
      logger?.warn({ err, key }, 'lock release failed');
    }
  }
}
