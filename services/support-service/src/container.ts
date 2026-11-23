import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { ConnectTokens, RealtimeHub } from '@farmx/infra/realtime';
import {
  type Cache,
  type Redis,
  createCache,
  createCacheClient,
  supportKeys,
} from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asClass, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { CacheGen } from './adapters/cache-gen.js';
import { EventsRuntime } from './adapters/events.js';
import { JobsRuntime } from './adapters/jobs.js';
import { AuthDirectory, MediaClient, OrderClient } from './adapters/upstreams.js';
import type { SupportConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<SupportConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: caches, limits, WebSocket tokens + fan-out, presence. */
    redis: Redis;
    cache: Cache;
    cacheGen: CacheGen;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    authDirectory: AuthDirectory;
    orderClient: OrderClient;
    mediaClient: MediaClient;
    /** Cross-replica realtime rooms (publish AFTER commit). */
    realtimeHub: RealtimeHub;
    /** Single-use WebSocket connect tokens (audience `support-ws`). */
    wsTokens: ConnectTokens;
    eventsRuntime: EventsRuntime;
    jobsRuntime: JobsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<SupportConfig>;
  logger: Logger;
}

/** Service-wide providers. Each feature registers its own in `<feature>.module.ts`. */
export function createAppContainer({ config, logger }: ContainerDeps): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>({ strict: true });

  container.register({
    config: asValue(config),
    logger: asValue(logger),
    db: asFunction(({ config: cfg, logger: log }: Cradle) =>
      getDatabase({ url: cfg.DATABASE_URL, logger: log, poolSize: cfg.DB_POOL_SIZE }),
    )
      .singleton()
      .disposer(() => closeDatabase()),
    runInTransaction: asFunction(({ db }: Cradle) => createTransactionRunner(db)).singleton(),
    redis: asFunction(({ config: cfg, logger: log }: Cradle) =>
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'support-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    cache: asFunction(({ redis, logger: log }: Cradle) =>
      createCache(redis, { logger: log }),
    ).singleton(),
    cacheGen: asClass(CacheGen).singleton(),
    accessClient: asFunction(
      (cradle: Cradle) =>
        new AccessClient({
          config: cradle.config,
          logger: cradle.logger,
          redis: () => cradle.redis,
        }),
    ).singleton(),
    tokenVerifier: asFunction((cradle: Cradle) =>
      buildTokenVerifier(cradle.config, cradle.logger, () => cradle.redis),
    ).singleton(),
    authDirectory: asClass(AuthDirectory).singleton(),
    orderClient: asClass(OrderClient).singleton(),
    mediaClient: asClass(MediaClient).singleton(),
    realtimeHub: asFunction(
      (cradle: Cradle) =>
        new RealtimeHub({
          redis: () => cradle.redis,
          channel: supportKeys.wsChannel(),
          logger: cradle.logger,
        }),
    )
      .singleton()
      .disposer((hub) => hub.close()),
    wsTokens: asFunction(
      (cradle: Cradle) =>
        new ConnectTokens({
          redis: () => cradle.redis,
          key: supportKeys.wsToken,
          audience: 'support-ws',
        }),
    ).singleton(),
    eventsRuntime: asFunction((cradle: Cradle) => new EventsRuntime(cradle))
      .singleton()
      .disposer((r) => r.stop()),
    jobsRuntime: asFunction((cradle: Cradle) => new JobsRuntime(cradle))
      .singleton()
      .disposer((r) => r.stop()),
  });

  return container;
}
