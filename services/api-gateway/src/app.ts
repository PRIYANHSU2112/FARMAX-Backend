import { createLogger } from '@farmx/common/logger';
import { type ServiceOptions, buildService } from '@farmx/common/server';
import type { FastifyInstance } from 'fastify';

import { loadConfig } from './config/index.js';
import { createAppContainer } from './container.js';
import { createFeatures } from './routes/index.js';

/** config → logger → container → features. Builds the app WITHOUT listening (tests use this). */
export function createServiceOptions(env: NodeJS.ProcessEnv = process.env): ServiceOptions {
  const config = loadConfig(env);
  const logger = createLogger({
    service: config.SERVICE_NAME,
    level: config.LOG_LEVEL,
    appEnv: config.APP_ENV,
    version: config.SERVICE_VERSION,
  });
  const container = createAppContainer({ config, logger });

  return { config, logger, container, modules: createFeatures(config, logger) };
}

export const buildApp = (env?: NodeJS.ProcessEnv): Promise<FastifyInstance> =>
  buildService(createServiceOptions(env));
