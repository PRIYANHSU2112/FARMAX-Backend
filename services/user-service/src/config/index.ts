import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface UserConfig extends BaseConfig {
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
  /** Shared service-to-service token (≥ 32 chars). Unset = internal routes off, cache-only RBAC. */
  INTERNAL_SERVICE_TOKEN?: string;
  /** product-service base URL for wishlist product cards (`/internal/products/cards`). */
  PRODUCT_SERVICE_URL: string;
  /** Home SDUI (D-59): banners + categories (public catalog API). */
  CATALOG_SERVICE_URL: string;
  /** Home SDUI: the farmer's farm (region, depot, farm type) and the news feed. */
  FARM_SERVICE_URL: string;
  /** Home SDUI: the ORDER_LIVE feed (latest active order). */
  ORDER_SERVICE_URL: string;
  /** Home SDUI: hosts a https deep link may point to (comma list; subdomains allowed). */
  HOME_LINK_HOSTS: string;
  /** Home SDUI: CDN hosts an item image may come from (comma list; subdomains allowed). */
  HOME_IMAGE_HOSTS: string;
  /** Per-user limits. */
  MAX_ADDRESSES_PER_USER: number;
  MAX_WISHLIST_ITEMS: number;
}

const schema = Joi.object<UserConfig>({
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
  CATALOG_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3004'),
  FARM_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3003'),
  ORDER_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3007'),
  HOME_LINK_HOSTS: Joi.string().default('farmx.in'),
  HOME_IMAGE_HOSTS: Joi.string().default('cdn.farmx.in,digitaloceanspaces.com'),
  MAX_ADDRESSES_PER_USER: Joi.number().integer().min(1).max(100).default(20),
  MAX_WISHLIST_ITEMS: Joi.number().integer().min(1).max(1000).default(200),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads USER_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<UserConfig> =>
  createConfig<UserConfig>(schema, {
    env: { ...env, PORT: env.USER_SERVICE_PORT ?? '3006', SERVICE_NAME: 'user-service' },
  });

/** Swagger is off in production unless DOCS_ENABLED=true is set explicitly. */
export const docsEnabled = (config: Pick<UserConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
