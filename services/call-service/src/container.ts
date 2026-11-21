import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Cache, type Redis, createCache, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asClass, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { CacheGens } from './adapters/cache-gens.js';
import { AuthDirectory, CatalogClient, FarmClient, ProductClient } from './adapters/upstreams.js';
import type { CallConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<CallConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: auth flags + RBAC cache, availability caches, presence, idempotency, limits. */
    redis: Redis;
    /** JSON cache with stampede protection over `redis`. */
    cache: Cache;
    /** poolGen / dayGen availability cache generations. */
    gens: CacheGens;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    /** Upstreams: called only BEFORE a transaction opens (D-53). */
    productClient: ProductClient;
    catalogClient: CatalogClient;
    farmClient: FarmClient;
    authDirectory: AuthDirectory;
  }
}

export interface ContainerDeps {
  config: Readonly<CallConfig>;
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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'call-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    cache: asFunction(({ redis, logger: log }: Cradle) => createCache(redis, { logger: log })).singleton(),
    gens: asClass(CacheGens).singleton(),
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
    productClient: asClass(ProductClient).singleton(),
    catalogClient: asClass(CatalogClient).singleton(),
    farmClient: asClass(FarmClient).singleton(),
    authDirectory: asClass(AuthDirectory).singleton(),
  });

  return container;
}
