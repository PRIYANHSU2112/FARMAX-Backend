import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Cache, type Redis, createCache, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asClass, asFunction, asValue, createContainer } from 'awilix';

import { AccessClient, buildTokenVerifier } from './adapters/auth.js';
import { JobsRuntime } from './adapters/jobs.js';
import {
  type AadhaarProvider,
  FakeAadhaarProvider,
  FakeGstProvider,
  type GstProvider,
} from './adapters/kyc-providers.js';
import { OutboxWriter } from './adapters/outbox.repository.js';
import { PiiCrypto } from './adapters/pii-crypto.js';
import type { FarmConfig } from './config/index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<FarmConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool). Repositories only. */
    db: Database;
    runInTransaction: RunInTransaction;
    /** redis-cache: revocation flags + RBAC cache (written by auth), farm caches, rate limits. */
    redis: Redis;
    /** Read-through cache with single-flight loading and TTL jitter (no stampedes). */
    cache: Cache;
    pii: PiiCrypto;
    aadhaarProvider: AadhaarProvider;
    gstProvider: GstProvider;
    outbox: OutboxWriter;
    accessClient: AccessClient;
    tokenVerifier: TokenVerifier;
    jobsRuntime: JobsRuntime;
  }
}

export interface ContainerDeps {
  config: Readonly<FarmConfig>;
  logger: Logger;
}

function buildPii(config: FarmConfig, logger: Logger): PiiCrypto {
  if (config.FARM_PII_ENC_KEY !== undefined && config.FARM_PII_HMAC_KEY !== undefined) {
    return new PiiCrypto(config.FARM_PII_ENC_KEY, config.FARM_PII_HMAC_KEY);
  }
  logger.warn('FARM_PII_* keys not set: using EPHEMERAL keys (local/test only).');
  return PiiCrypto.ephemeral();
}

function kycProviders(config: FarmConfig): { aadhaar: AadhaarProvider; gst: GstProvider } {
  if (config.KYC_PROVIDER === 'fake')
    return { aadhaar: new FakeAadhaarProvider(), gst: new FakeGstProvider() };
  throw new Error(`KYC_PROVIDER "${config.KYC_PROVIDER}" has no adapter yet`);
}

export function createAppContainer({ config, logger }: ContainerDeps): AwilixContainer<Cradle> {
  const container = createContainer<Cradle>({ strict: true });
  const providers = kycProviders(config);

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
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'farm-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    cache: asFunction(({ redis, logger: log }: Cradle) =>
      createCache(redis, { logger: log }),
    ).singleton(),
    pii: asValue(buildPii(config, logger)),
    aadhaarProvider: asValue(providers.aadhaar),
    gstProvider: asValue(providers.gst),
    outbox: asClass(OutboxWriter).singleton(),
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
    jobsRuntime: asFunction((cradle: Cradle) => new JobsRuntime(cradle))
      .singleton()
      .disposer((runtime) => runtime.stop()),
  });

  return container;
}
