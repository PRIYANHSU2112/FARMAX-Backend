import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

/** Infrastructure settings only (D-56). */
export interface WarehouseConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** redis-cache: revocation flags + RBAC cache (auth), rate limits, contact cache. */
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (stock stats refresh). */
  REDIS_QUEUE_URL: string;
  /** OpenAPI spec at /api-docs.json (merged into the gateway's single Swagger UI). */
  DOCS_ENABLED?: boolean;
  /** Access tokens are verified with auth-service's PUBLIC key. */
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** auth-service: permission-cache fallback, staff contacts, invitations. */
  AUTH_SERVICE_URL: string;
  /** catalog-service: category names / existence for zones and storage rules. */
  CATALOG_SERVICE_URL: string;
  /** media-service: signed read URLs of staff documents. */
  MEDIA_SERVICE_URL: string;
  /** inventory-service: per-warehouse stock figures (`/internal/inventory/warehouse-stats`). */
  INVENTORY_SERVICE_URL: string;
  /** product-service: variant facts for SKUs missing from the stock projection (D-57). */
  PRODUCT_SERVICE_URL: string;
  /** order-service: fulfilment facts of an order (D-57b). */
  ORDER_SERVICE_URL: string;
  /** payment-service: capture SLA stats for the payments view (D-57b W3.18). */
  PAYMENT_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset → `/internal/*` calls are off. */
  INTERNAL_SERVICE_TOKEN?: string;
  /** D-57b delivery OTP key (≥ 32 chars); unset → derived from INTERNAL_SERVICE_TOKEN (dev). */
  DELIVERY_OTP_KEY?: string;
  /** Public base URL of 3PL driver trip links (e.g. https://app.farmx.in/driver). */
  DRIVER_LINK_BASE_URL?: string;
  RABBITMQ_URL: string;
  /** Outbox relay + order event consumer (off in tests). */
  EVENTS_ENABLED: boolean;
  /** BullMQ stats refresh job (off in tests). */
  JOBS_ENABLED: boolean;
  /** How often stock figures are pulled from inventory-service. */
  STATS_REFRESH_SECONDS: number;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';

const schema = Joi.object<WarehouseConfig>({
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
  CATALOG_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3004'),
  MEDIA_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3002'),
  INVENTORY_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3008'),
  PRODUCT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3005'),
  ORDER_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3007'),
  PAYMENT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3009'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  DELIVERY_OTP_KEY: Joi.string().min(32),
  DRIVER_LINK_BASE_URL: Joi.string().uri(),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  JOBS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  STATS_REFRESH_SECONDS: Joi.number().integer().min(15).max(3600).default(60),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads WAREHOUSE_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<WarehouseConfig> =>
  createConfig<WarehouseConfig>(schema, {
    env: { ...env, PORT: env.WAREHOUSE_SERVICE_PORT ?? '3014', SERVICE_NAME: 'warehouse-service' },
  });

export const docsEnabled = (config: Pick<WarehouseConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
