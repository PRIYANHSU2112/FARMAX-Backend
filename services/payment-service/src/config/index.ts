import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export type PaymentProviderName = 'razorpay' | 'mock';

/** Infrastructure + gateway settings. Business settings (refund approval threshold …) are DB rows. */
export interface PaymentConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (webhook processing, refunds, reconciliation). */
  REDIS_QUEUE_URL: string;
  DOCS_ENABLED?: boolean;
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  AUTH_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset → `/internal/*` routes are off. */
  INTERNAL_SERVICE_TOKEN?: string;
  RABBITMQ_URL: string;
  EVENTS_ENABLED: boolean;
  JOBS_ENABLED: boolean;
  /**
   * `razorpay` (real gateway) or `mock` (dev / test bypass: no money moves). Mock is REFUSED when
   * APP_ENV=prod, and its routes are not even registered unless selected.
   */
  PAYMENT_PROVIDER: PaymentProviderName;
  RAZORPAY_KEY_ID?: string;
  RAZORPAY_KEY_SECRET?: string;
  RAZORPAY_WEBHOOK_SECRET?: string;
  RAZORPAY_API_URL: string;
  /** Mock gateway secrets (dev / test only; never real money). */
  MOCK_KEY_SECRET: string;
  MOCK_WEBHOOK_SECRET: string;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';
const razorpaySecret = Joi.string().min(8).when('PAYMENT_PROVIDER', {
  is: 'razorpay',
  then: Joi.required(),
});

const schema = Joi.object<PaymentConfig>({
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
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  JOBS_ENABLED: Joi.boolean().truthy('1').falsy('0').default(offInTests),
  // Fails CLOSED in production: the default there is razorpay (whose keys are then required) and
  // `Joi.override` REPLACES the allowed values, so mock can never be selected with APP_ENV=prod.
  PAYMENT_PROVIDER: Joi.string()
    .valid('razorpay', 'mock')
    .default((parent: { APP_ENV?: string }) => (parent.APP_ENV === 'prod' ? 'razorpay' : 'mock'))
    .when('APP_ENV', {
      is: 'prod',
      then: Joi.valid(Joi.override, 'razorpay').messages({
        'any.only': 'PAYMENT_PROVIDER=mock is not allowed when APP_ENV=prod',
      }),
    }),
  RAZORPAY_KEY_ID: razorpaySecret,
  RAZORPAY_KEY_SECRET: razorpaySecret,
  RAZORPAY_WEBHOOK_SECRET: razorpaySecret,
  RAZORPAY_API_URL: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .default('https://api.razorpay.com/v1'),
  MOCK_KEY_SECRET: Joi.string().min(16).default('mock-key-secret-not-for-production'),
  MOCK_WEBHOOK_SECRET: Joi.string().min(16).default('mock-webhook-secret-not-for-production'),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads PAYMENT_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<PaymentConfig> =>
  createConfig<PaymentConfig>(schema, {
    env: { ...env, PORT: env.PAYMENT_SERVICE_PORT ?? '3009', SERVICE_NAME: 'payment-service' },
  });

export const docsEnabled = (config: Pick<PaymentConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
