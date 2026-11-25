import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

/** Infrastructure settings only (D-60). */
export interface QualityConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** redis-cache: revocation flags + RBAC cache (auth), rate limits. */
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (COA expiry, decision sweep). */
  REDIS_QUEUE_URL: string;
  DOCS_ENABLED?: boolean;
  /** Access tokens are verified with auth-service's PUBLIC key. */
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** auth-service: permission-cache fallback. */
  AUTH_SERVICE_URL: string;
  /** media-service: signed read URLs of COA PDFs. */
  MEDIA_SERVICE_URL: string;
  /** product-service: variant facts for a spec of a SKU never received yet. */
  PRODUCT_SERVICE_URL: string;
  /** warehouse-service: unit trace for a QR scan (`/internal/wms/units/:qr/trace`). */
  WAREHOUSE_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset → `/internal/*` calls are off. */
  INTERNAL_SERVICE_TOKEN?: string;
  RABBITMQ_URL: string;
  /** Outbox relay + warehouse event consumer (off in tests). */
  EVENTS_ENABLED: boolean;
  /** BullMQ jobs (off in tests). */
  JOBS_ENABLED: boolean;
  /** A decision still APPLYING after this many minutes is reported as stuck. */
  DECISION_STUCK_MINUTES: number;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';
const http = (fallback: string) =>
  Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default(fallback);

const schema = Joi.object<QualityConfig>({
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
  AUTH_SERVICE_URL: http('http://localhost:3001'),
  MEDIA_SERVICE_URL: http('http://localhost:3002'),
  PRODUCT_SERVICE_URL: http('http://localhost:3005'),
  WAREHOUSE_SERVICE_URL: http('http://localhost:3014'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  JOBS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  DECISION_STUCK_MINUTES: Joi.number().integer().min(5).max(1440).default(30),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads QUALITY_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<QualityConfig> =>
  createConfig<QualityConfig>(schema, {
    env: { ...env, PORT: env.QUALITY_SERVICE_PORT ?? '3015', SERVICE_NAME: 'quality-service' },
  });

export const docsEnabled = (config: Pick<QualityConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
