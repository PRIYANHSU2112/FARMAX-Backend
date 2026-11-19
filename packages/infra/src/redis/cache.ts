import type { Logger } from '@farmx/common/logger';
import type { Redis } from 'ioredis';

import { type Lock, acquireLock } from './lock.js';

export type CacheClient = Pick<Redis, 'get' | 'set' | 'del' | 'eval'>;

export interface CacheOptions {
  logger?: Logger;
  /** Fraction of the TTL randomised (±). Default 0.1 = ±10%. Spreads out expiries. */
  jitterRatio?: number;
  /** Lease for the single-loader lock. Default 10 s. */
  lockTtlMs?: number;
  /** Max time a non-loader waits for the loader's result before loading itself. Default 2 s. */
  maxWaitMs?: number;
  /** Poll interval while waiting. Default 50 ms. */
  pollMs?: number;
  /** Injectable for tests. */
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface Cache {
  get: <T>(key: string) => Promise<T | undefined>;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller states the cached type
  set: <T>(key: string, value: T, ttlSec: number) => Promise<void>;
  /**
   * Returns the cached value, or loads it with `fn` and caches it.
   * - Concurrent misses elect ONE loader through a lock; the others poll the cache for at
   *   most `maxWaitMs`, then load themselves (the wait is bounded).
   * - Redis errors never fail the request: they are logged and `fn`'s result is returned.
   * - `undefined` results are not cached.
   */
  getOrSet: <T>(key: string, ttlSec: number, fn: () => Promise<T>) => Promise<T>;
  /** Explicit invalidation of exact keys. */
  invalidate: (...keys: string[]) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function createCache(client: CacheClient, options: CacheOptions = {}): Cache {
  const log = options.logger?.child({ component: 'cache' });
  const jitterRatio = options.jitterRatio ?? 0.1;
  const lockTtlMs = options.lockTtlMs ?? 10_000;
  const maxWaitMs = options.maxWaitMs ?? 2_000;
  const pollMs = options.pollMs ?? 50;
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;

  const jittered = (ttlSec: number): number => {
    const delta = ttlSec * jitterRatio * (random() * 2 - 1);
    return Math.max(1, Math.round(ttlSec + delta));
  };

  const get = async <T>(key: string): Promise<T | undefined> => {
    try {
      const raw = await client.get(key);
      return raw === null ? undefined : (JSON.parse(raw) as T);
    } catch (err) {
      log?.warn({ err, key }, 'cache get failed');
      return undefined;
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- caller states the cached type
  const set = async <T>(key: string, value: T, ttlSec: number): Promise<void> => {
    if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new Error('ttlSec must be positive');
    try {
      await client.set(key, JSON.stringify(value), 'EX', jittered(ttlSec));
    } catch (err) {
      log?.warn({ err, key }, 'cache set failed');
    }
  };

  const store = async <T>(key: string, ttlSec: number, value: T): Promise<T> => {
    if (value !== undefined) await set(key, value, ttlSec);
    return value;
  };

  const getOrSet = async <T>(key: string, ttlSec: number, fn: () => Promise<T>): Promise<T> => {
    const hit = await get<T>(key);
    if (hit !== undefined) return hit;

    let lock: Lock | null;
    try {
      lock = await acquireLock(client, `${key}:loading`, lockTtlMs);
    } catch (err) {
      log?.warn({ err, key }, 'cache lock failed; loading without stampede protection');
      return store(key, ttlSec, await fn());
    }

    if (lock) {
      try {
        return await store(key, ttlSec, await fn());
      } finally {
        await lock.release().catch((err: unknown) => {
          log?.warn({ err, key }, 'cache lock release failed');
        });
      }
    }

    // Another caller is loading: wait a bounded time for its result.
    for (let waited = 0; waited < maxWaitMs; waited += pollMs) {
      await sleep(pollMs);
      const value = await get<T>(key);
      if (value !== undefined) return value;
    }
    log?.warn({ key, maxWaitMs }, 'cache wait exceeded; loading directly');
    return store(key, ttlSec, await fn());
  };

  const invalidate = async (...keys: string[]): Promise<void> => {
    if (keys.length === 0) return;
    await client.del(...keys);
  };

  return { get, set, getOrSet, invalidate };
}
