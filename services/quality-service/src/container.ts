import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Redis, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { EventsRuntime } from './adapters/events.js';
import { JobsRuntime } from './adapters/jobs.js';
import { MediaClient } from './adapters/media-client.js';
import { ProductClient } from './adapters/product-client.js';
import { WarehouseClient } from './adapters/warehouse-client.js';
import type { QualityConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<QualityConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories / services only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (auth), rate limits. */
    redis: Redis;
    accessClient: AccessClient;
    mediaClient: MediaClient;
    productClient: ProductClient;
    warehouseClient: WarehouseClient;
    tokenVerifier: TokenVerifier;
    /** Outbox relay + warehouse event consumer (started by server.ts when EVENTS_ENABLED). */
    eventsRuntime: EventsRuntime;
    /** BullMQ jobs (started by server.ts when JOBS_ENABLED). */
    jobsRuntime: JobsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<QualityConfig>;
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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'quality-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    accessClient: asFunction(
      (cradle: Cradle) =>
        new AccessClient({
          config: cradle.config,
          logger: cradle.logger,
          redis: () => cradle.redis,
        }),
    ).singleton(),
    mediaClient: asFunction(
      (cradle: Cradle) => new MediaClient({ config: cradle.config, logger: cradle.logger }),
    ).singleton(),
    productClient: asFunction(
      (cradle: Cradle) => new ProductClient({ config: cradle.config, logger: cradle.logger }),
    ).singleton(),
    warehouseClient: asFunction(
      (cradle: Cradle) => new WarehouseClient({ config: cradle.config, logger: cradle.logger }),
    ).singleton(),
    tokenVerifier: asFunction((cradle: Cradle) =>
      buildTokenVerifier(cradle.config, cradle.logger, () => cradle.redis),
    ).singleton(),
    eventsRuntime: asFunction((cradle: Cradle) => new EventsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
    jobsRuntime: asFunction((cradle: Cradle) => new JobsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
  });
  return container;
}
