import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface OrderConfig extends BaseConfig {
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
  /** Shared service-to-service token (≥ 32 chars). */
  INTERNAL_SERVICE_TOKEN?: string;
  /** RabbitMQ: outbox relay + consumers. */
  RABBITMQ_URL: string;
  /** Run the outbox relay and event consumers (off in tests). */
  EVENTS_ENABLED: boolean;
  /** redis-queue: BullMQ (payment timeout, stuck placements). */
  REDIS_QUEUE_URL: string;
  /** Run the BullMQ jobs (off in tests). */
  JOBS_ENABLED: boolean;
  /** Internal service base URLs (service token; never through the gateway). */
  INVENTORY_SERVICE_URL: string;
  PAYMENT_SERVICE_URL: string;
  USER_SERVICE_URL: string;
  /** GST state code of the supplying node (mother warehouse); decides CGST+SGST vs IGST. */
  SELLER_STATE_CODE: string;
  /** Cold-chain freight & packaging (₹) when any line is CC_REF / CC_FRZ. */
  FREIGHT_COLD_CHAIN: string;
  /** Freight (₹) otherwise. */
  FREIGHT_STANDARD: string;
  /** GST rate (%) and SAC code on freight. */
  FREIGHT_GST_RATE: string;
  FREIGHT_SAC_CODE: string;
  /** Max distinct lines in one cart. */
  CART_MAX_LINES: number;
  /** Guest carts expire this many days after their last change. */
  CART_GUEST_TTL_DAYS: number;
}

const RUPEES = Joi.string().pattern(/^\d{1,7}(\.\d{1,2})?$/);

const schema = Joi.object<OrderConfig>({
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
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean()
    .truthy('1')
    .falsy('0')
    .default((parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test'),
  REDIS_QUEUE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6380'),
  JOBS_ENABLED: Joi.boolean()
    .truthy('1')
    .falsy('0')
    .default((parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test'),
  INVENTORY_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3008'),
  PAYMENT_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3009'),
  USER_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3006'),
  SELLER_STATE_CODE: Joi.string()
    .pattern(/^\d{2}$/)
    .default('37'),
  FREIGHT_COLD_CHAIN: RUPEES.default('495.00'),
  FREIGHT_STANDARD: RUPEES.default('0.00'),
  FREIGHT_GST_RATE: Joi.string()
    .pattern(/^\d{1,2}(\.\d{1,2})?$/)
    .default('18'),
  FREIGHT_SAC_CODE: Joi.string()
    .pattern(/^\d{4,8}$/)
    .default('996511'),
  CART_MAX_LINES: Joi.number().integer().min(1).max(200).default(50),
  CART_GUEST_TTL_DAYS: Joi.number().integer().min(1).max(90).default(30),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads ORDER_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<OrderConfig> =>
  createConfig<OrderConfig>(schema, {
    env: { ...env, PORT: env.ORDER_SERVICE_PORT ?? '3007', SERVICE_NAME: 'order-service' },
  });

export const docsEnabled = (config: Pick<OrderConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
