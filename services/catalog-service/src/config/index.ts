import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface CatalogConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  REDIS_CACHE_URL: string;
  /** OpenAPI spec at /api-docs.json (merged into the gateway's single Swagger UI). */
  DOCS_ENABLED?: boolean;
  /** Access tokens are verified with auth-service's PUBLIC key. */
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** auth-service base URL for the permission-cache fallback (`/internal/access`). */
  AUTH_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset = cache-only RBAC. */
  INTERNAL_SERVICE_TOKEN?: string;
  /** product-service base URL for the safe-delete protocol (`/internal/products`). */
  PRODUCT_SERVICE_URL: string;
  /** RabbitMQ for the outbox relay. */
  RABBITMQ_URL: string;
  /** Run the outbox relay (off in tests). */
  EVENTS_ENABLED: boolean;
  /** Guard rail for the category tree (root = depth 0). */
  CATALOG_MAX_CATEGORY_DEPTH: number;
}

const schema = Joi.object<CatalogConfig>({
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_POOL_SIZE: Joi.number().integer().min(1).max(50).default(10),
  REDIS_CACHE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
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
  PRODUCT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3005'),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean()
    .truthy('1')
    .falsy('0')
    .default((parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test'),
  CATALOG_MAX_CATEGORY_DEPTH: Joi.number().integer().min(1).max(20).default(10),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads CATALOG_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<CatalogConfig> =>
  createConfig<CatalogConfig>(schema, {
    env: { ...env, PORT: env.CATALOG_SERVICE_PORT ?? '3004', SERVICE_NAME: 'catalog-service' },
  });

export const docsEnabled = (config: Pick<CatalogConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
