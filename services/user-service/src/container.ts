import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Cache, type Redis, createCache, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { CatalogClient } from './adapters/catalog-client.js';
import { FarmClient } from './adapters/farm-client.js';
import { OrderClient } from './adapters/order-client.js';
import { ProductClient } from './adapters/product-client.js';
import type { UserConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<UserConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (written by auth), product cards, rate limits. */
    redis: Redis;
    /** Read-through cache with single-flight loading and TTL jitter. */
    cache: Cache;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    /** product-service internal API (wishlist product cards), Redis-cached; public list for home. */
    productClient: ProductClient;
    /** catalog-service public API (home: banners, categories, brand ref check). */
    catalogClient: CatalogClient;
    /** farm-service customer API with the caller's token (home: farm context, news feed). */
    farmClient: FarmClient;
    /** order-service customer API with the caller's token (home: ORDER_LIVE feed). */
    orderClient: OrderClient;
  }
}

export interface ContainerDeps {
  config: Readonly<UserConfig>;
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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'user-service-cache' }),
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
      (cradle: Cradle) =>
        new ProductClient({
          config: cradle.config,
          logger: cradle.logger,
          redis: () => cradle.redis,
        }),
    ).singleton(),
    catalogClient: asFunction(
      (cradle: Cradle) => new CatalogClient({ config: cradle.config }),
    ).singleton(),
    farmClient: asFunction(
      (cradle: Cradle) => new FarmClient({ config: cradle.config }),
    ).singleton(),
    orderClient: asFunction(
      (cradle: Cradle) => new OrderClient({ config: cradle.config }),
    ).singleton(),
  });

  return container;
}
