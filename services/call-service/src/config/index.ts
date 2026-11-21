import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export type TelephonyProviderName = 'mock';

/**
 * Infrastructure settings only. Business rules (slot length, buffers, hold TTL, SLA, retention …)
 * are `call_settings` rows (D-53), editable without a deploy.
 */
export interface CallConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** redis-cache: availability / pool / config caches, presence, idempotency, rate limits. */
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (hold expiry, reminders, SLA watch, attempts, retention). */
  REDIS_QUEUE_URL: string;
  DOCS_ENABLED?: boolean;
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  AUTH_SERVICE_URL: string;
  /** Product card + authoritative price quote. */
  PRODUCT_SERVICE_URL: string;
  /** Farm ownership, territory, snapshot. */
  FARM_SERVICE_URL: string;
  /** Category ancestry (experts tagged with a parent category match its products). */
  CATALOG_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset → internal calls fail with 503. */
  INTERNAL_SERVICE_TOKEN?: string;
  RABBITMQ_URL: string;
  EVENTS_ENABLED: boolean;
  JOBS_ENABLED: boolean;
  /**
   * Telephony provider. Only `mock` exists until a vendor is chosen (PROJECT_CONTEXT open
   * questions). Mock is REFUSED when APP_ENV=prod, so production cannot boot without a real
   * provider (masked numbers, signed webhooks, recording-consent enforcement).
   */
  TELEPHONY_PROVIDER: TelephonyProviderName;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';
const httpUrl = (fallback: string) =>
  Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default(fallback);

const schema = Joi.object<CallConfig>({
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
  AUTH_SERVICE_URL: httpUrl('http://localhost:3001'),
  PRODUCT_SERVICE_URL: httpUrl('http://localhost:3005'),
  FARM_SERVICE_URL: httpUrl('http://localhost:3003'),
  CATALOG_SERVICE_URL: httpUrl('http://localhost:3004'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  JOBS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  // Fails CLOSED in production: Joi never validates defaults, so prod gets NO default (required)
  // and mock is invalid there. No real provider exists yet, so APP_ENV=prod cannot boot.
  TELEPHONY_PROVIDER: Joi.string()
    .valid('mock')
    .default((parent: { APP_ENV?: string }) => (parent.APP_ENV === 'prod' ? undefined : 'mock'))
    .when('APP_ENV', {
      is: 'prod',
      then: Joi.required().invalid('mock').messages({
        'any.required':
          'TELEPHONY_PROVIDER is required when APP_ENV=prod (mock is refused; integrate a real provider first)',
        'any.invalid':
          'TELEPHONY_PROVIDER=mock is not allowed when APP_ENV=prod (integrate a real provider first)',
      }),
    }),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads CALL_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<CallConfig> =>
  createConfig<CallConfig>(schema, {
    env: { ...env, PORT: env.CALL_SERVICE_PORT ?? '3011', SERVICE_NAME: 'call-service' },
  });

export const docsEnabled = (config: Pick<CallConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
