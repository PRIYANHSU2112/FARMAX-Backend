import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface FarmConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  REDIS_CACHE_URL: string;
  DOCS_ENABLED?: boolean;
  /** Own key: the shared root `.env` DOCS_SERVER_LOCAL_URL points at auth-service. */
  FARM_DOCS_SERVER_URL: string;
  /** Access tokens are verified with auth-service's PUBLIC key. */
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** auth-service base URL for the permission-cache fallback (`/internal/access`). */
  AUTH_SERVICE_URL: string;
  /** Shared service-to-service token (≥ 32 chars). Unset = `/internal/*` off, cache-only RBAC. */
  INTERNAL_SERVICE_TOKEN?: string;
  /** base64 of 32 bytes: AES-256-GCM key for PAN. Required outside local/test. */
  FARM_PII_ENC_KEY?: string;
  /** ≥ 32 chars: HMAC secret for PAN lookup hashes and signed Farm-pass QR payloads. */
  FARM_PII_HMAC_KEY?: string;
  /** `fake` = deterministic Aadhaar/GST stubs (refused in prod until a provider is chosen). */
  KYC_PROVIDER: string;
  DEDUPE_RADIUS_M: number;
  REVIEW_SLA_HOURS: number;
  MAX_OPEN_DRAFTS: number;
}

const requiredOutsideLocal = (schema: Joi.Schema) =>
  schema.when('APP_ENV', { is: Joi.valid('dev', 'prod'), then: Joi.required() });

const schema = Joi.object<FarmConfig>({
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_POOL_SIZE: Joi.number().integer().min(1).max(50).default(10),
  REDIS_CACHE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
  FARM_DOCS_SERVER_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3000/v1'),
  JWT_PUBLIC_KEY: requiredOutsideLocal(Joi.string().base64()),
  JWT_KEY_ID: Joi.string().default('dev'),
  JWT_ISSUER: Joi.string().default('farmx-auth'),
  JWT_AUDIENCE: Joi.string().default('farmx'),
  AUTH_SERVICE_URL: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3001'),
  INTERNAL_SERVICE_TOKEN: Joi.string().min(32),
  FARM_PII_ENC_KEY: requiredOutsideLocal(Joi.string().base64()),
  FARM_PII_HMAC_KEY: requiredOutsideLocal(Joi.string().min(32)),
  KYC_PROVIDER: Joi.when('APP_ENV', {
    is: 'prod',
    then: Joi.string().invalid('fake').required(),
    otherwise: Joi.string().default('fake'),
  }),
  DEDUPE_RADIUS_M: Joi.number().integer().min(20).max(2000).default(150),
  REVIEW_SLA_HOURS: Joi.number().integer().min(1).max(168).default(4),
  MAX_OPEN_DRAFTS: Joi.number().integer().min(1).max(20).default(3),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads FARM_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<FarmConfig> =>
  createConfig<FarmConfig>(schema, {
    env: { ...env, PORT: env.FARM_SERVICE_PORT ?? '3003', SERVICE_NAME: 'farm-service' },
  });

export const docsEnabled = (config: Pick<FarmConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
