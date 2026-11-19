import { describe, expect, it, vi } from 'vitest';

import {
  type CacheClient,
  type HealthClient,
  type LockClient,
  acquireLock,
  authKeys,
  createCache,
  createKeyspace,
  createRedisHealthCheck,
  gatewayKeys,
  redisHealth,
} from '../index.js';

/** Minimal in-memory stand-in for the ioredis methods we use. Ignores TTL expiry. */
class FakeRedis {
  store = new Map<string, string>();
  setCalls: unknown[][] = [];
  failGet = false;

  get = vi.fn((key: string) => {
    if (this.failGet) return Promise.reject(new Error('down'));
    return Promise.resolve(this.store.get(key) ?? null);
  });

  set = vi.fn((...args: unknown[]) => {
    this.setCalls.push(args);
    const [key, value, ...flags] = args as [string, string, ...string[]];
    if (flags.includes('NX') && this.store.has(key)) return Promise.resolve(null);
    this.store.set(key, value);
    return Promise.resolve('OK');
  });

  del = vi.fn((...keys: string[]) => {
    let n = 0;
    for (const key of keys) n += this.store.delete(key) ? 1 : 0;
    return Promise.resolve(n);
  });

  // Emulates the compare-and-delete release script.
  eval = vi.fn((_script: string, _n: number, key: string, token: string) => {
    if (this.store.get(key) === token) {
      this.store.delete(key);
      return Promise.resolve(1);
    }
    return Promise.resolve(0);
  });

  ping = vi.fn(() => Promise.resolve('PONG'));
}

const asClient = (fake: FakeRedis) => fake as unknown as CacheClient & LockClient;
const asHealth = (client: { ping: () => Promise<string> }) => client as unknown as HealthClient;

describe('keys', () => {
  it('builds versioned, service-scoped keys', () => {
    expect(authKeys.user('123')).toBe('farmx:auth:v1:user:123');
    expect(authKeys.session('abc')).toBe('farmx:auth:v1:session:abc');
    expect(authKeys.lock('refresh')).toBe('farmx:auth:v1:lock:refresh');
    expect(gatewayKeys.rateLimit('123', 'login')).toBe('farmx:gateway:v1:ratelimit:login:123');
  });

  it('keeps cache version separate per keyspace', () => {
    expect(createKeyspace({ service: 'auth', version: 'v2' }).key('user', 1)).toBe(
      'farmx:auth:v2:user:1',
    );
  });

  it('rejects unsafe parts and bad versions', () => {
    const ks = createKeyspace({ service: 'auth', version: 'v1' });
    expect(() => ks.key('user', 'a:b')).toThrow();
    expect(() => ks.key('user', '*')).toThrow();
    expect(() => ks.key('')).toThrow();
    expect(() => ks.key()).toThrow();
    expect(() => createKeyspace({ service: 'auth', version: '1.0.0' })).toThrow();
  });
});

describe('locks', () => {
  it('acquires with SET NX PX and a random token, and excludes a second holder', async () => {
    const fake = new FakeRedis();
    const first = await acquireLock(asClient(fake), 'k', 5_000);
    expect(first).not.toBeNull();
    expect(fake.setCalls[0]).toEqual(['k', first?.token, 'PX', 5_000, 'NX']);
    expect(first?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(await acquireLock(asClient(fake), 'k', 5_000)).toBeNull();
  });

  it('release only deletes when the token still matches', async () => {
    const fake = new FakeRedis();
    const lock = await acquireLock(asClient(fake), 'k', 5_000);
    fake.store.set('k', 'someone-else'); // lease expired and was re-taken
    expect(await lock?.release()).toBe(false);
    expect(fake.store.get('k')).toBe('someone-else');

    fake.store.delete('k');
    const again = await acquireLock(asClient(fake), 'k', 5_000);
    expect(await again?.release()).toBe(true);
    expect(fake.store.has('k')).toBe(false);
  });

  it('rejects invalid ttl', async () => {
    await expect(acquireLock(asClient(new FakeRedis()), 'k', 0)).rejects.toThrow();
  });
});

describe('cache', () => {
  it('returns cached JSON without calling the loader', async () => {
    const fake = new FakeRedis();
    fake.store.set('a', JSON.stringify({ n: 1 }));
    const fn = vi.fn(() => Promise.resolve({ n: 2 }));
    expect(await createCache(asClient(fake)).getOrSet('a', 60, fn)).toEqual({ n: 1 });
    expect(fn).not.toHaveBeenCalled();
  });

  it('loads on miss, stores JSON with jittered TTL, and releases its lock', async () => {
    const fake = new FakeRedis();
    const cache = createCache(asClient(fake), { jitterRatio: 0.1, random: () => 1 });
    expect(await cache.getOrSet('a', 100, () => Promise.resolve({ n: 2 }))).toEqual({ n: 2 });
    expect(fake.store.get('a')).toBe('{"n":2}');
    expect(fake.setCalls.at(-1)).toEqual(['a', '{"n":2}', 'EX', 110]);
    expect(fake.store.has('a:loading')).toBe(false);
  });

  it('keeps jitter within bounds', async () => {
    const fake = new FakeRedis();
    for (const r of [0, 0.5, 0.999]) {
      const cache = createCache(asClient(fake), { jitterRatio: 0.2, random: () => r });
      await cache.set('k', 1, 100);
      const ttl = fake.setCalls.at(-1)?.[3] as number;
      expect(ttl).toBeGreaterThanOrEqual(80);
      expect(ttl).toBeLessThanOrEqual(120);
    }
  });

  it('runs the loader once for concurrent misses (stampede protection)', async () => {
    const fake = new FakeRedis();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fn = vi.fn(async () => {
      await gate;
      return { v: 1 };
    });
    const cache = createCache(asClient(fake), { pollMs: 1, maxWaitMs: 1_000 });
    const calls = Array.from({ length: 10 }, () => cache.getOrSet('hot', 60, fn));
    await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    const results = await Promise.all(calls);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(results).toEqual(Array.from({ length: 10 }, () => ({ v: 1 })));
  });

  it('bounds the wait: falls back to loading when the holder never fills the cache', async () => {
    const fake = new FakeRedis();
    fake.store.set('slow:loading', 'other-holder');
    const fn = vi.fn(() => Promise.resolve('mine'));
    const sleep = vi.fn(() => Promise.resolve());
    const cache = createCache(asClient(fake), { maxWaitMs: 200, pollMs: 50, sleep });
    expect(await cache.getOrSet('slow', 60, fn)).toBe('mine');
    expect(sleep).toHaveBeenCalledTimes(4);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('degrades to the loader when Redis is failing', async () => {
    const fake = new FakeRedis();
    fake.failGet = true;
    fake.set.mockRejectedValue(new Error('down'));
    const fn = vi.fn(() => Promise.resolve(7));
    expect(await createCache(asClient(fake)).getOrSet('x', 60, fn)).toBe(7);
  });

  it('does not cache undefined, and invalidates explicitly', async () => {
    const fake = new FakeRedis();
    const cache = createCache(asClient(fake));
    const none = await cache.getOrSet<string | undefined>('u', 60, () =>
      Promise.resolve(undefined),
    );
    expect(none).toBeUndefined();
    expect(fake.store.has('u')).toBe(false);

    await cache.set('a', 1, 60);
    await cache.set('b', 2, 60);
    await cache.invalidate('a', 'b');
    expect(fake.store.has('a') || fake.store.has('b')).toBe(false);
  });
});

describe('health', () => {
  it('reports 200 on PONG', async () => {
    expect((await redisHealth(asHealth(new FakeRedis()))).status).toBe(200);
  });

  it('reports 503 on error and on timeout', async () => {
    const failing = { ping: () => Promise.reject(new Error('refused')) };
    const failed = await redisHealth(asHealth(failing));
    expect(failed).toMatchObject({ status: 503, error: 'refused' });

    const hanging = { ping: () => new Promise<string>(() => undefined) };
    expect((await redisHealth(asHealth(hanging), 20)).status).toBe(503);
  });

  it('readiness check throws when unhealthy', async () => {
    await expect(
      createRedisHealthCheck(asHealth({ ping: () => Promise.reject(new Error('x')) }))(),
    ).rejects.toThrow('x');
    await expect(createRedisHealthCheck(asHealth(new FakeRedis()))()).resolves.toBeUndefined();
  });
});
