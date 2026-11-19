import { type BaseConfig, Joi, createConfig } from '@farmx/common/config';

import { type ServiceUrls, serviceUrlsSchema } from './services.js';

export interface GatewayConfig extends BaseConfig, ServiceUrls {
  /** The single Swagger UI (all services) at /api-docs. Default: on, except APP_ENV=prod. */
  DOCS_ENABLED?: boolean;
}

const schema = Joi.object<GatewayConfig>({
  ...serviceUrlsSchema,
  DOCS_ENABLED: Joi.boolean().truthy('1').falsy('0'),
});

/** The gateway listens on 3000 (`GATEWAY_PORT` overrides) and always identifies as `api-gateway`. */
export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Readonly<GatewayConfig> =>
  createConfig<GatewayConfig>(schema, {
    env: { ...env, PORT: env.GATEWAY_PORT ?? '3000', SERVICE_NAME: 'api-gateway' },
  });

export const docsEnabled = (config: Pick<GatewayConfig, 'DOCS_ENABLED' | 'APP_ENV'>): boolean =>
  config.DOCS_ENABLED ?? config.APP_ENV !== 'prod';
