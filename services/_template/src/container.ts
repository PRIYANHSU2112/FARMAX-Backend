import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import type { ServiceConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<ServiceConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool from @farmx/database). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** Verifies a Bearer access token for `requireAuth`. */
    tokenVerifier: TokenVerifier;
  }
}

export interface ContainerDeps {
  config: Readonly<ServiceConfig>;
  logger: Logger;
}

/** Fail-closed until access-token verification is wired in: protected routes answer 401. */
const tokenVerificationNotImplemented: TokenVerifier = () =>
  Promise.reject(new Error('Access-token verification is not configured'));

/**
 * Service-wide providers. Each feature registers its own providers in `<feature>.module.ts`.
 * Need Redis? Add `redis: createCacheClient(...)` like services/auth-service/src/container.ts.
 */
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
    tokenVerifier: asValue(tokenVerificationNotImplemented),
  });

  return container;
}
