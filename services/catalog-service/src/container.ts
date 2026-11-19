import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Cache, type Redis, createCache, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { EventsRuntime } from './adapters/events.js';
import { ProductClient } from './adapters/product-client.js';
import type { CatalogConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<CatalogConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (written by auth), category tree, rate limits. */
    redis: Redis;
    /** Read-through cache with single-flight loading and TTL jitter (no stampedes). */
    cache: Cache;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    /** product-service internal API (safe category/brand delete). */
    productClient: ProductClient;
    /** Outbox relay (started by server.ts when EVENTS_ENABLED). */
    eventsRuntime: EventsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<CatalogConfig>;
  logger: Logger;
}

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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'catalog-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    cache: asFunction(({ redis, logger: log }: Cradle) =>
      createCache(redis, { logger: log }),
    ).singleton(),
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
    productClient: asFunction(
      (cradle: Cradle) => new ProductClient({ config: cradle.config, logger: cradle.logger }),
    ).singleton(),
    eventsRuntime: asFunction((cradle: Cradle) => new EventsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
  });

  return container;
}
