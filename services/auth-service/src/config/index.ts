import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface AuthConfig extends BaseConfig {
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  REDIS_CACHE_URL: string;
  /** Swagger UI + /api-docs.json. Default: on, except when APP_ENV=prod. */
  DOCS_ENABLED?: boolean;
  /** "Servers" dropdown in Swagger UI. */
  DOCS_SERVER_LOCAL_URL: string;
  DOCS_SERVER_PROD_URL?: string;

  /** Ed25519 keys as base64-encoded PEM (`scripts/generate-keys.ts`). Required outside local/test. */
  JWT_PRIVATE_KEY?: string;
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** HMAC secret for OTP codes and identifier hashes in Redis keys (≥ 32 chars). */
  OTP_PEPPER?: string;
  /** AES-256-GCM key for TOTP secrets: base64 of 32 random bytes. */
  MFA_ENCRYPTION_KEY?: string;
  /**
   * false (default) = MFA is opt-in: users turn it on from settings (`/me/mfa/totp/*`); once on,
   * every login asks for the code. true = accounts/roles flagged `mfaRequired` must enrol first.
   */
  MFA_ENFORCED: boolean;
  ADMIN_SESSION_IDLE_MINUTES: number;
  ADMIN_SESSION_MAX_HOURS: number;
  CUSTOMER_SESSION_IDLE_DAYS: number;
  CUSTOMER_SESSION_MAX_DAYS: number;
  /** `console` logs SMS/email instead of sending (local/dev only; refused in prod). */
  SMS_PROVIDER: string;
  /**
   * DEV ONLY: fixed OTP (e.g. `123456`) for every login code while `SMS_PROVIDER=console`, so
   * Swagger/Postman testing needs no log reading. Refused when APP_ENV=prod.
   */
  OTP_DEV_CODE?: string;
  /** Shared service-to-service token for `/internal/*` (≥ 32 chars). Unset = internal routes off. */
  INTERNAL_SERVICE_TOKEN?: string;
}

/** Secrets are mandatory on shared environments; local and test runs may use ephemeral ones. */
const requiredOutsideLocal = (schema: Joi.Schema) =>
  schema.when('APP_ENV', { is: Joi.valid('dev', 'prod'), then: Joi.required() });

const schema = Joi.object<AuthConfig>({
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_POOL_SIZE: Joi.number().integer().min(1).max(50).default(10),
  REDIS_CACHE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
  DOCS_SERVER_LOCAL_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3000/v1/auth'),
  DOCS_SERVER_PROD_URL: Joi.string().uri({ scheme: ['https'] }),

  JWT_PRIVATE_KEY: requiredOutsideLocal(Joi.string().base64()),
  JWT_PUBLIC_KEY: requiredOutsideLocal(Joi.string().base64()),
  JWT_KEY_ID: Joi.string()
    .pattern(/^[A-Za-z0-9._-]{1,64}$/)
    .default('dev'),
  JWT_ISSUER: Joi.string().default('farmx-auth'),
  JWT_AUDIENCE: Joi.string().default('farmx'),
  OTP_PEPPER: requiredOutsideLocal(Joi.string().min(32)),
  MFA_ENCRYPTION_KEY: requiredOutsideLocal(Joi.string().base64()),
  MFA_ENFORCED: Joi.boolean().truthy('1').falsy('0').default(false),
  ADMIN_SESSION_IDLE_MINUTES: Joi.number().integer().min(5).max(480).default(30),
  ADMIN_SESSION_MAX_HOURS: Joi.number().integer().min(1).max(72).default(12),
  CUSTOMER_SESSION_IDLE_DAYS: Joi.number().integer().min(1).max(90).default(30),
  CUSTOMER_SESSION_MAX_DAYS: Joi.number().integer().min(1).max(365).default(90),
  SMS_PROVIDER: Joi.when('APP_ENV', {
    is: 'prod',
    then: Joi.string()
      .invalid('console')
      .required()
      .messages({ 'any.invalid': 'SMS_PROVIDER=console is not allowed in prod' }),
    otherwise: Joi.string().default('console'),
  }),
  OTP_DEV_CODE: Joi.when('APP_ENV', {
    is: 'prod',
    then: Joi.forbidden().messages({ 'any.unknown': 'OTP_DEV_CODE is not allowed in prod' }),
    otherwise: Joi.string().pattern(/^\d{6}$/),
  }),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
});

/**
 * The shared root `.env` sets a generic PORT for the gateway, so this service reads its own
 * `AUTH_SERVICE_PORT` (default 3001) and a fixed SERVICE_NAME instead.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<AuthConfig> =>
  createConfig<AuthConfig>(schema, {
    env: { ...env, PORT: env.AUTH_SERVICE_PORT ?? '3001', SERVICE_NAME: 'auth-service' },
  });

/** Swagger is off in production unless DOCS_ENABLED=true is set explicitly. */
export const docsEnabled = (config: Pick<AuthConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
