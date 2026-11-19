import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface MediaConfig extends BaseConfig {
  REDIS_CACHE_URL: string;
  /** DigitalOcean Spaces (S3-compatible). */
  AWS_ENDPOINT: string;
  AWS_REGION: string;
  AWS_BUCKET_NAME: string;
  AWS_ACCESS_KEY_ID: string;
  AWS_SECRET_ACCESS_KEY: string;
  /** Key prefix, e.g. `dev` → `dev/<uuidv7>.webp`. */
  BUCKET_FOLDER_PATH: string;
  /** CDN base, e.g. https://<bucket>.<region>.cdn.digitaloceanspaces.com. Default: bucket origin. */
  MEDIA_PUBLIC_BASE_URL?: string;
  /** Overrides the bundled ffmpeg-static binary. */
  FFMPEG_PATH?: string;
  MEDIA_MAX_CONCURRENT_TRANSCODES: number;
  /** Access tokens are verified with auth-service's public key (never its private key). */
  JWT_PUBLIC_KEY?: string;
  JWT_KEY_ID: string;
  JWT_ISSUER: string;
  JWT_AUDIENCE: string;
  /** Swagger UI + /api-docs.json. Default: on, except when APP_ENV=prod. */
  DOCS_ENABLED?: boolean;
}

const schema = Joi.object<MediaConfig>({
  REDIS_CACHE_URL: Joi.string()
    .uri({ scheme: ['redis', 'rediss'] })
    .default('redis://localhost:6379'),
  AWS_ENDPOINT: Joi.string()
    .uri({ scheme: ['https', 'http'] })
    .required(),
  AWS_REGION: Joi.string().required(),
  AWS_BUCKET_NAME: Joi.string()
    .pattern(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/)
    .required(),
  AWS_ACCESS_KEY_ID: Joi.string().required(),
  AWS_SECRET_ACCESS_KEY: Joi.string().required(),
  BUCKET_FOLDER_PATH: Joi.string()
    .trim()
    // "dev/" and "/dev" are normalised to "dev".
    .replace(/^\/+|\/+$/g, '')
    .pattern(/^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/)
    .required()
    .messages({
      'string.pattern.base': 'BUCKET_FOLDER_PATH must be like "dev" or "media/dev"',
    }),
  MEDIA_PUBLIC_BASE_URL: Joi.string().uri({ scheme: ['https', 'http'] }),
  FFMPEG_PATH: Joi.string(),
  MEDIA_MAX_CONCURRENT_TRANSCODES: Joi.number().integer().min(1).max(8).default(2),
  JWT_PUBLIC_KEY: Joi.string()
    .base64()
    .when('APP_ENV', { is: Joi.valid('dev', 'prod'), then: Joi.required() }),
  JWT_KEY_ID: Joi.string().default('dev'),
  JWT_ISSUER: Joi.string().default('farmx-auth'),
  JWT_AUDIENCE: Joi.string().default('farmx'),
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
});

/** The root `.env` sets a generic PORT for the gateway; this service reads MEDIA_SERVICE_PORT. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<MediaConfig> =>
  createConfig<MediaConfig>(schema, {
    env: { ...env, PORT: env.MEDIA_SERVICE_PORT ?? '3002', SERVICE_NAME: 'media-service' },
  });

export const docsEnabled = (config: Pick<MediaConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
