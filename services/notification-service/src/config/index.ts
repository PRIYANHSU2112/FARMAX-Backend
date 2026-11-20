import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

/** Infrastructure settings. Notification content lives in DB templates, not config. */
export type PushProviderName = 'fcm' | 'console' | 'none';
export type EmailProviderName = 'smtp' | 'console' | 'none';
export type SmsProviderName = 'console' | 'none';

export interface NotificationConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** redis-cache: auth revocation flags + RBAC cache, rate limits, SSE pub/sub. */
  REDIS_CACHE_URL: string;
  /** redis-queue: BullMQ (per-channel delivery queues + repeating jobs). */
  REDIS_QUEUE_URL: string;
  DOCS_ENABLED?: boolean;
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  AUTH_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Needed for contacts and staff audiences. */
  INTERNAL_SERVICE_TOKEN?: string;
  RABBITMQ_URL: string;
  EVENTS_ENABLED: boolean;
  JOBS_ENABLED: boolean;
  /** Prometheus `/metrics` on the service port (never routed by the gateway). */
  METRICS_ENABLED: boolean;
  /** Parallel fan-out jobs per replica. */
  FANOUT_CONCURRENCY: number;
  /**
   * Providers. `console` logs instead of sending (dev / test; REFUSED when APP_ENV=prod).
   * `none` turns the channel off: its deliveries are SKIPPED (PROVIDER_DISABLED).
   */
  PUSH_PROVIDER: PushProviderName;
  /** Firebase service-account JSON, base64 (FCM HTTP v1). Required for `fcm`. */
  FCM_SERVICE_ACCOUNT_JSON?: string;
  EMAIL_PROVIDER: EmailProviderName;
  /** smtp(s)://user:pass@host:port (SES, Gmail, Zoho …). Required for `smtp`. */
  SMTP_URL?: string;
  EMAIL_FROM: string;
  SMS_PROVIDER: SmsProviderName;
  /** Per provider call. */
  PROVIDER_TIMEOUT_MS: number;
  /** Attempts per delivery before FAILED (transient errors only). */
  DELIVERY_MAX_ATTEMPTS: number;
  /** Parallel sends per replica, per channel. */
  PUSH_CONCURRENCY: number;
  EMAIL_CONCURRENCY: number;
  SMS_CONCURRENCY: number;
  /** Max sends per second across ALL replicas, per channel (BullMQ limiter). */
  PUSH_RATE_PER_SEC: number;
  EMAIL_RATE_PER_SEC: number;
  SMS_RATE_PER_SEC: number;
  /** Notifications older than this are deleted (recipients + deliveries cascade). */
  NOTIFICATION_RETENTION_DAYS: number;
}

const offInTests = (parent: { NODE_ENV?: string }) => parent.NODE_ENV !== 'test';
const flag = () => Joi.boolean().truthy('1').falsy('0');

/**
 * A provider choice. Default: `prodDefault` in prod, `console` elsewhere. `console` is REFUSED in
 * prod (it would silently "send" nothing); `Joi.override` replaces the allowed values there.
 */
const provider = (values: string[], prodDefault: string) =>
  Joi.string()
    .valid(...values)
    .default((parent: { APP_ENV?: string }) =>
      parent.APP_ENV === 'prod' ? prodDefault : 'console',
    )
    .when('APP_ENV', {
      is: 'prod',
      then: Joi.valid(Joi.override, ...values.filter((v) => v !== 'console')).messages({
        'any.only': 'console providers are not allowed when APP_ENV=prod',
      }),
    });

const schema = Joi.object<NotificationConfig>({
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
  DOCS_ENABLED: flag(),
  JWT_PUBLIC_KEY: Joi.string()
    .base64()
    .when('APP_ENV', { is: Joi.valid('dev', 'prod'), then: Joi.required() }),
  JWT_KEY_ID: Joi.string().default('dev'),
  JWT_ISSUER: Joi.string().default('farmx-auth'),
  JWT_AUDIENCE: Joi.string().default('farmx'),
  AUTH_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3001'),
  INTERNAL_SERVICE_TOKEN: Joi.string()
    .min(32)
    .when('APP_ENV', { is: 'prod', then: Joi.required() }),
  RABBITMQ_URL: Joi.string()
    .uri({ scheme: ['amqp', 'amqps'] })
    .default('amqp://farmx:farmx@localhost:5672'),
  EVENTS_ENABLED: flag().default(offInTests),
  JOBS_ENABLED: flag().default(offInTests),
  METRICS_ENABLED: flag().default(true),
  FANOUT_CONCURRENCY: Joi.number().integer().min(1).max(32).default(4),
  PUSH_PROVIDER: provider(['fcm', 'console', 'none'], 'fcm'),
  FCM_SERVICE_ACCOUNT_JSON: Joi.string()
    .base64()
    .when('PUSH_PROVIDER', { is: 'fcm', then: Joi.required() }),
  EMAIL_PROVIDER: provider(['smtp', 'console', 'none'], 'smtp'),
  SMTP_URL: Joi.string()
    .uri({ scheme: ['smtp', 'smtps'] })
    .when('EMAIL_PROVIDER', { is: 'smtp', then: Joi.required() }),
  EMAIL_FROM: Joi.string().max(200).default('FarmX <no-reply@farmx.in>'),
  SMS_PROVIDER: provider(['console', 'none'], 'none'),
  PROVIDER_TIMEOUT_MS: Joi.number().integer().min(1000).max(60_000).default(10_000),
  DELIVERY_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(6),
  PUSH_CONCURRENCY: Joi.number().integer().min(1).max(100).default(20),
  EMAIL_CONCURRENCY: Joi.number().integer().min(1).max(50).default(5),
  SMS_CONCURRENCY: Joi.number().integer().min(1).max(50).default(5),
  PUSH_RATE_PER_SEC: Joi.number().integer().min(1).max(10_000).default(300),
  EMAIL_RATE_PER_SEC: Joi.number().integer().min(1).max(1000).default(10),
  SMS_RATE_PER_SEC: Joi.number().integer().min(1).max(1000).default(10),
  NOTIFICATION_RETENTION_DAYS: Joi.number().integer().min(7).max(3650).default(180),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads NOTIFICATION_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<NotificationConfig> =>
  createConfig<NotificationConfig>(schema, {
    env: {
      ...env,
      PORT: env.NOTIFICATION_SERVICE_PORT ?? '3010',
      SERVICE_NAME: 'notification-service',
    },
  });

export const docsEnabled = (
  config: Pick<NotificationConfig, 'DOCS_ENABLED' | 'APP_ENV'>,
): boolean => config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
