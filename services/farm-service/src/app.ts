import { createLogger } from '@farmx/common/logger';
import { type ServiceOptions, buildService } from '@farmx/common/server';
import { createDbHealthCheck } from '@farmx/database';
import { createRedisHealthCheck } from '@farmx/infra/redis';
import type { FastifyInstance } from 'fastify';

import { docsEnabled, loadConfig } from './config/index.js';
import { createAppContainer } from './container.js';
import { createDocsOptions, features } from './routes/index.js';

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

  return {
    config,
    logger,
    container,
    modules: features,
    // JSON-only API with small bodies: 64 KB is ample and caps parsing cost.
    bodyLimit: 65_536,
    healthChecks: {
      postgres: createDbHealthCheck(container.cradle.db),
      // Resolved per probe, so the client is created lazily (and test overrides are honoured).
      redis: () => createRedisHealthCheck(container.cradle.redis)(),
    },
    docs: docsEnabled(config) ? createDocsOptions(config) : false,
  };
}

export const buildApp = (env?: NodeJS.ProcessEnv): Promise<FastifyInstance> =>
  buildService(createServiceOptions(env));
