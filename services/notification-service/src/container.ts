import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Redis, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { AuthDirectory } from './adapters/auth-directory.js';
import { EventsRuntime } from './adapters/events.js';
import { FarmDirectory } from './adapters/farm-directory.js';
import { JobsRuntime } from './adapters/jobs.js';
import { LiveHub } from './adapters/live.js';
import { Metrics } from './adapters/metrics.js';
import { type Providers, buildProviders } from './adapters/providers/index.js';
import { Queues } from './adapters/queues.js';
import type { NotificationConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<NotificationConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (auth), rate limits, SSE pub/sub. */
    redis: Redis;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    /** auth-service internal directory: contacts, staff and app audiences. */
    authDirectory: AuthDirectory;
    farmDirectory: FarmDirectory;
    metrics: Metrics;
    /** Live inbox updates (Redis pub/sub → SSE streams on this replica). */
    liveHub: LiveHub;
    /** Push / email / SMS providers chosen by config (null = channel off). */
    providers: Providers;
    /** BullMQ producers (lazy). */
    queues: Queues;
    /** Event consumer (started by server.ts when EVENTS_ENABLED). */
    eventsRuntime: EventsRuntime;
    /** BullMQ worker + schedulers (started by server.ts when JOBS_ENABLED). */
    jobsRuntime: JobsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<NotificationConfig>;
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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'notification-service-cache' }),
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
    tokenVerifier: asFunction((cradle: Cradle) =>
      buildTokenVerifier(cradle.config, cradle.logger, () => cradle.redis),
    ).singleton(),
    authDirectory: asFunction(
      ({ config: cfg, logger: log }: Cradle) => new AuthDirectory({ config: cfg, logger: log }),
    ).singleton(),
    farmDirectory: asFunction(
      ({ config: cfg, logger: log }: Cradle) => new FarmDirectory({ config: cfg, logger: log }),
    ).singleton(),
    metrics: asFunction(({ config: cfg }: Cradle) => new Metrics(cfg.SERVICE_NAME)).singleton(),
    liveHub: asFunction(
      (cradle: Cradle) =>
        new LiveHub({ redis: () => cradle.redis, logger: cradle.logger, metrics: cradle.metrics }),
    )
      .singleton()
      .disposer((hub) => hub.close()),
    providers: asFunction(({ config: cfg, logger: log }: Cradle) => buildProviders(cfg, log))
      .singleton()
      .disposer((providers) => providers.email?.close?.()),
    queues: asFunction(
      ({ config: cfg, logger: log }: Cradle) => new Queues({ config: cfg, logger: log }),
    )
      .singleton()
      .disposer((queues) => queues.close()),
    eventsRuntime: asFunction((cradle: Cradle) => new EventsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
    jobsRuntime: asFunction((cradle: Cradle) => new JobsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
  });

  return container;
}
