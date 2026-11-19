import { randomBytes } from 'node:crypto';

import { type JwtKeys, generateJwtKeys, loadJwtKeys } from '@farmx/common/auth';
import type { Logger } from '@farmx/common/logger';
import type { TokenVerifier } from '@farmx/common/middleware';
import { type RunInTransaction, createTransactionRunner } from '@farmx/database';
import { type Database, closeDatabase, getDatabase } from '@farmx/database/client';
import { type Redis, createCacheClient } from '@farmx/infra/redis';
import type { Cradle } from '@fastify/awilix';
import { type AwilixContainer, asFunction, asValue, createContainer } from 'awilix';

import {
  ConsoleEmailSender,
  ConsoleSmsSender,
  type EmailSender,
  type SmsSender,
} from './adapters/messaging.js';
import type { AuthConfig } from './config/index.js';
import { createTokenVerifier } from './features/tokens/index.js';

/** Secrets used by OTP hashing and MFA secret encryption. */
export interface AuthSecrets {
  otpPepper: string;
  /** 32 bytes for AES-256-GCM. */
  mfaKey: Buffer;
}

declare module '@fastify/awilix' {
  interface Cradle {
    config: Readonly<AuthConfig>;
    logger: Logger;
    /** The shared FarmX database (singleton pool from @farmx/database). Repositories only. */
    db: Database;
    /** redis-cache: revoked sessions/tokens, OTPs, rate limits, access cache. */
    redis: Redis;
    runInTransaction: RunInTransaction;
    authSecrets: AuthSecrets;
    smsSender: SmsSender;
    emailSender: EmailSender;
    /** Verifies a Bearer access token for `requireAuth`. */
    tokenVerifier: TokenVerifier;
  }
}

export interface ContainerDeps {
  config: Readonly<AuthConfig>;
  logger: Logger;
}

/** Local/test only: secrets that are missing are generated per process (and say so loudly). */
const isLocal = (config: AuthConfig) => config.APP_ENV === 'local' || config.NODE_ENV === 'test';

function buildJwtKeys(config: AuthConfig, logger: Logger): JwtKeys {
  if (config.JWT_PRIVATE_KEY !== undefined && config.JWT_PUBLIC_KEY !== undefined) {
    return loadJwtKeys(config.JWT_KEY_ID, config.JWT_PRIVATE_KEY, config.JWT_PUBLIC_KEY);
  }
  if (!isLocal(config)) throw new Error('JWT_PRIVATE_KEY and JWT_PUBLIC_KEY are required');
  if (config.NODE_ENV !== 'test') {
    logger.warn(
      'JWT keys not set: using EPHEMERAL keys (tokens die on restart). Run scripts/generate-keys.ts.',
    );
  }
  return generateJwtKeys(`ephemeral-${randomBytes(4).toString('hex')}`);
}

function buildSecrets(config: AuthConfig, logger: Logger): AuthSecrets {
  const missing = config.OTP_PEPPER === undefined || config.MFA_ENCRYPTION_KEY === undefined;
  if (missing && !isLocal(config))
    throw new Error('OTP_PEPPER and MFA_ENCRYPTION_KEY are required');
  if (missing && config.NODE_ENV !== 'test') {
    logger.warn(
      'OTP_PEPPER / MFA_ENCRYPTION_KEY not set: using EPHEMERAL secrets (MFA secrets unreadable after restart).',
    );
  }
  const mfaKey =
    config.MFA_ENCRYPTION_KEY === undefined
      ? randomBytes(32)
      : Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64');
  if (mfaKey.length !== 32)
    throw new Error('MFA_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  return { otpPepper: config.OTP_PEPPER ?? randomBytes(32).toString('hex'), mfaKey };
}

/** Only the dev console adapter exists today; a real provider (DLT templates) plugs in here. */
function buildSmsSender(config: AuthConfig, logger: Logger): SmsSender {
  if (config.SMS_PROVIDER === 'console') return new ConsoleSmsSender(logger);
  throw new Error(`SMS_PROVIDER "${config.SMS_PROVIDER}" has no adapter yet`);
}

/** Service-wide providers. Each feature registers its own providers in `<feature>.module.ts`. */
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
    redis: asFunction(({ config: cfg, logger: log }: Cradle) =>
      createCacheClient(cfg.REDIS_CACHE_URL, { logger: log, name: 'auth-service-cache' }),
    )
      .singleton()
      .disposer(async (client) => {
        await client.quit();
      }),
    runInTransaction: asFunction(({ db }: Cradle) => createTransactionRunner(db)).singleton(),
    jwtKeys: asValue(buildJwtKeys(config, logger)),
    authSecrets: asValue(buildSecrets(config, logger)),
    smsSender: asValue(buildSmsSender(config, logger)),
    emailSender: asValue(new ConsoleEmailSender(logger)),
    tokenVerifier: asFunction((cradle: Cradle) => createTokenVerifier(cradle)).singleton(),
  });

  return container;
}
