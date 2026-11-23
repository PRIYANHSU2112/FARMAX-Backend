import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Redis, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import { AuthClient } from './adapters/auth-client.js';
import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { CatalogClient } from './adapters/catalog-client.js';
import { MediaClient } from './adapters/media-client.js';
import { EventsRuntime } from './adapters/events.js';
import { InventoryClient } from './adapters/inventory-client.js';
import { JobsRuntime } from './adapters/jobs.js';
import type { WarehouseConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<WarehouseConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (auth), rate limits, contact cache. */
    redis: Redis;
    accessClient: AccessClient;
    authClient: AuthClient;
    catalogClient: CatalogClient;
    mediaClient: MediaClient;
    inventoryClient: InventoryClient;
    tokenVerifier: TokenVerifier;
    /** Outbox relay + order event consumer (started by server.ts when EVENTS_ENABLED). */
    eventsRuntime: EventsRuntime;
    /** BullMQ stats refresh (started by server.ts when JOBS_ENABLED). */
    jobsRuntime: JobsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<WarehouseConfig>;
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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'warehouse-service-cache' }),
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
    authClient: asFunction(
      (cradle: Cradle) =>
        new AuthClient({ config: cradle.config, logger: cradle.logger, redis: () => cradle.redis }),
    ).singleton(),
    catalogClient: asFunction(
      (cradle: Cradle) =>
        new CatalogClient({
          config: cradle.config,
          logger: cradle.logger,
          redis: () => cradle.redis,
        }),
    ).singleton(),
    mediaClient: asFunction(
      (cradle: Cradle) => new MediaClient({ config: cradle.config, logger: cradle.logger }),
    ).singleton(),
    inventoryClient: asFunction(
      (cradle: Cradle) => new InventoryClient({ config: cradle.config, logger: cradle.logger }),
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
