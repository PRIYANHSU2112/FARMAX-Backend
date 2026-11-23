import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

/**
 * Infrastructure settings only. Business rules (contacts, limits, topics, priority rules, SLA,
 * calendars) are database rows editable from the admin console without a deploy.
 */
export interface SupportConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** redis-cache: config/content caches, rate limits, WebSocket tokens + fan-out, presence. */
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (SLA sweeper, auto-close). */
  REDIS_QUEUE_URL: string;
  DOCS_ENABLED?: boolean;
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  AUTH_SERVICE_URL: string;
  /** Order snapshot for "Attached automatically". */
  ORDER_SERVICE_URL: string;
  /** Upload receipts + signed read URLs for evidence. */
  MEDIA_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Also the HMAC key of media upload receipts. */
  INTERNAL_SERVICE_TOKEN?: string;
  RABBITMQ_URL: string;
  EVENTS_ENABLED: boolean;
  JOBS_ENABLED: boolean;
  /** Browser origins allowed on the chat WebSocket (comma list; `*` = any, refused in prod). */
  SUPPORT_WS_ORIGINS: string;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';
const httpUrl = (fallback: string) =>
  Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default(fallback);

const schema = Joi.object<SupportConfig>({
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
  ORDER_SERVICE_URL: httpUrl('http://localhost:3007'),
  MEDIA_SERVICE_URL: httpUrl('http://localhost:3002'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  JOBS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  SUPPORT_WS_ORIGINS: Joi.string()
    .allow('')
    .default('')
    .when('APP_ENV', {
      is: 'prod',
      then: Joi.string()
        .custom((value: string, helpers) =>
          value
            .split(',')
            .map((o) => o.trim())
            .every((o) => o.startsWith('https://') && !o.includes('*'))
            ? value
            : helpers.error('any.invalid'),
        )
        .messages({
          'any.invalid': 'SUPPORT_WS_ORIGINS must be comma-separated https origins in prod (no *)',
        }),
    }),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads SUPPORT_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<SupportConfig> =>
  createConfig<SupportConfig>(schema, {
    env: { ...env, PORT: env.SUPPORT_SERVICE_PORT ?? '3013', SERVICE_NAME: 'support-service' },
  });

/** Parsed WebSocket origin allowlist. */
export const wsOrigins = (config: Pick<SupportConfig, 'SUPPORT_WS_ORIGINS'>): string[] =>
  config.SUPPORT_WS_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export const docsEnabled = (config: Pick<SupportConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
