import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

/**
 * Infrastructure settings only. Business rules (top-up limits, points rates …) are DB rows.
 * Balances are NEVER configured or cached: PostgreSQL is the only source of truth (D-54).
 */
export interface WalletConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** redis-cache: revocation flags + RBAC cache (auth) and rate limits. Never balances. */
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (top-up reconciliation). */
  REDIS_QUEUE_URL: string;
  DOCS_ENABLED?: boolean;
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  AUTH_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset → `/internal/*` routes are off. */
  INTERNAL_SERVICE_TOKEN?: string;
  /** payment-service `/internal/payments/*` (top-up payments, live status). */
  PAYMENT_SERVICE_URL: string;
  RABBITMQ_URL: string;
  EVENTS_ENABLED: boolean;
  JOBS_ENABLED: boolean;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';

const schema = Joi.object<WalletConfig>({
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_POOL_SIZE: Joi.number().integer().min(1).max(50).default(10),
  REDIS_CACHE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  REDIS_QUEUE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6380'),
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
  JWT_PUBLIC_KEY: Joi.string()
    .base64()
    .when('APP_ENV', { is: Joi.valid('dev', 'prod'), then: Joi.required() }),
  JWT_KEY_ID: Joi.string().default('dev'),
  JWT_ISSUER: Joi.string().default('farmx-auth'),
  JWT_AUDIENCE: Joi.string().default('farmx'),
  AUTH_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3001'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  PAYMENT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3009'),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  JOBS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads WALLET_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<WalletConfig> =>
  createConfig<WalletConfig>(schema, {
    env: { ...env, PORT: env.WALLET_SERVICE_PORT ?? '3012', SERVICE_NAME: 'wallet-service' },
  });

export const docsEnabled = (config: Pick<WalletConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
