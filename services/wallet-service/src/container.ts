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
import { PaymentClient } from './adapters/payment-client.js';
import { createWalletTransactionRunner } from './adapters/transaction.js';
import type { WalletConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<WalletConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (auth) and rate limits. Never balances. */
    redis: Redis;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    /** payment-service /internal/payments (top-up payments, live status). */
    paymentClient: PaymentClient;
    /** Outbox relay + event consumer (started by server.ts when EVENTS_ENABLED). */
    eventsRuntime: EventsRuntime;
    /** BullMQ schedulers + worker (started by server.ts when JOBS_ENABLED). */
    jobsRuntime: JobsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<WalletConfig>;
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
    runInTransaction: asFunction(({ db }: Cradle) =>
      createWalletTransactionRunner(createTransactionRunner(db)),
    ).singleton(),
    redis: asFunction(({ config: cfg, logger: log }: Cradle) =>
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'wallet-service-cache' }),
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
    paymentClient: asFunction(
      (cradle: Cradle) => new PaymentClient({ config: cradle.config, logger: cradle.logger }),
    ).singleton(),
    jobsRuntime: asFunction((cradle: Cradle) => new JobsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
    eventsRuntime: asFunction((cradle: Cradle) => new EventsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
  });

  return container;
}
