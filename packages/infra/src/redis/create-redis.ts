import type { Logger } from '@farmx/common/logger';
import { Redis, type RedisOptions } from 'ioredis';

export interface CreateRedisOptions {
  logger?: Logger;
  /** Connection name shown in `CLIENT LIST` and logs. */
  name?: string;
}

/**
 * Bounded retries for HTTP-facing clients: a request fails fast (after ~2 retries)
 * instead of hanging while Redis is down.
 */
const BOUNDED: RedisOptions = {
  maxRetriesPerRequest: 2,
  connectTimeout: 5_000,
  commandTimeout: 2_000,
  retryStrategy: (attempt) => Math.min(attempt * 200, 2_000),
};

const build = (url: string, role: string, extra: RedisOptions, options: CreateRedisOptions) => {
  // NOTE: never set ioredis `keyPrefix` — it breaks BullMQ and hides real key names.
  // Namespacing is done explicitly by the key builders in keys.ts.
  const client = new Redis(url, {
    connectionName: options.name ?? `farmx-${role}`,
    ...extra,
  });
  const log = options.logger?.child({ component: 'redis', role });
  client.on('error', (err) => log?.error({ err }, 'redis error'));
  client.on('ready', () => log?.info('redis ready'));
  client.on('close', () => log?.warn('redis connection closed'));
  return client;
};

/** HTTP-facing cache client: bounded retries, fails fast when Redis is down. */
export const createCacheClient = (url: string, options: CreateRedisOptions = {}): Redis =>
  build(url, 'cache', BOUNDED, options);

/**
 * BullMQ producer (Queue) connection used on request paths: bounded retries so an
 * enqueue fails fast instead of blocking the HTTP request.
 */
export const createQueueProducerClient = (url: string, options: CreateRedisOptions = {}): Redis =>
  build(url, 'queue-producer', BOUNDED, options);

/**
 * BullMQ Worker connection. BullMQ requires `maxRetriesPerRequest: null`
 * (blocking commands must wait indefinitely) and `enableReadyCheck: false`.
 */
export const createWorkerClient = (url: string, options: CreateRedisOptions = {}): Redis =>
  build(
    url,
    'queue-worker',
    {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
      retryStrategy: (attempt) => Math.min(attempt * 500, 10_000),
    },
    options,
  );
