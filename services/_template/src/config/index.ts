import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

export interface ServiceConfig extends BaseConfig {
  /** The ONE shared FarmX database URL (root .env). */
  DATABASE_URL: string;
  DB_POOL_SIZE: number;
  /** Swagger UI + /api-docs.json. Default: on, except when APP_ENV=prod. */
  DOCS_ENABLED?: boolean;
}

const schema = Joi.object<ServiceConfig>({
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .required(),
  DB_POOL_SIZE: Joi.number().integer().min(1).max(50).default(10),
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
});

/**
 * The root `.env` sets a generic PORT for the gateway, so each service reads its own
 * `<SERVICE>_PORT` and a fixed SERVICE_NAME. Rename both when copying the template.
 */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<ServiceConfig> =>
  createConfig<ServiceConfig>(schema, {
    env: { ...env, PORT: env.TEMPLATE_SERVICE_PORT ?? '3099', SERVICE_NAME: 'service-template' },
  });

/** Swagger is off in production unless DOCS_ENABLED=true is set explicitly. */
export const docsEnabled = (config: Pick<ServiceConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
