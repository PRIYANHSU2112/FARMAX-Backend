import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface ProductConfig extends BaseConfig {
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
  /** catalog-service base URL for authoritative category/brand checks (`/internal/catalog`). */
  CATALOG_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset = internal routes disabled. */
  INTERNAL_SERVICE_TOKEN?: string;
  /** RabbitMQ for the outbox relay and event consumers. */
  RABBITMQ_URL: string;
  /** Run the outbox relay + consumers (off in tests). */
  EVENTS_ENABLED: boolean;
  /** Reviews: days after delivery a purchase can still be reviewed. */
  REVIEW_WINDOW_DAYS: number;
  /** Reviews: how many times the author may edit one review. */
  REVIEW_MAX_EDITS: number;
  /** Reviews: open reports that auto-hide a published review until an admin decides. */
  REVIEW_AUTO_HIDE_REPORTS: number;
  /** Reviews: comma-separated words / phrases that send a review to moderation. */
  REVIEW_BANNED_WORDS: string;
  /** media-service public base URL; review image URLs must start with it (unset = any https). */
  MEDIA_PUBLIC_BASE_URL?: string;
}

const schema = Joi.object<ProductConfig>({
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
  CATALOG_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3004'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean()
    .truthy('1')
    .falsy('0')
    .default((parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test'),
  REVIEW_WINDOW_DAYS: Joi.number().integer().min(1).max(730).default(180),
  REVIEW_MAX_EDITS: Joi.number().integer().min(0).max(50).default(5),
  REVIEW_AUTO_HIDE_REPORTS: Joi.number().integer().min(1).max(100).default(3),
  REVIEW_BANNED_WORDS: Joi.string()
    .allow('')
    .max(5000)
    .default('whatsapp,telegram,call me,contact me,dm me,cheaper at,buy from outside'),
  MEDIA_PUBLIC_BASE_URL: Joi.string().uri({ scheme: ['https', 'http'] }),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads PRODUCT_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<ProductConfig> =>
  createConfig<ProductConfig>(schema, {
    env: { ...env, PORT: env.PRODUCT_SERVICE_PORT ?? '3005', SERVICE_NAME: 'product-service' },
  });

export const docsEnabled = (config: Pick<ProductConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
