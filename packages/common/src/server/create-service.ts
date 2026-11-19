import type { BaseConfig } from '../config/index.js';
import type { Logger } from '../logger/index.js';
import {
  authContextPlugin,
  errorHandlerPlugin,
  genRequestId,
  jsonSerializerCompiler,
  joiValidatorCompiler,
  requestContextPlugin,
  securityPlugin,
} from '../middleware/index.js';
import { type Cradle, fastifyAwilixPlugin } from '@fastify/awilix';
import { type AwilixContainer, asValue } from 'awilix';
import Fastify, {
  type FastifyBaseLogger,
  type FastifyInstance,
  type FastifyPluginAsync,
} from 'fastify';

import { type HealthCheck, type LifecycleState, healthRoutes } from './health.js';
import { type ServiceModule, assertModules, collectHealthChecks } from './module.js';
import { createShutdown, registerProcessHandlers } from './shutdown.js';
import { type DocsOptions, registerDocs } from './docs/index.js';

declare module '@fastify/awilix' {
  /** Registered per request in `request.diScope`. Services extend `Cradle` themselves. */
  interface RequestCradle {
    requestId: string;
    log: FastifyBaseLogger;
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    lifecycle: LifecycleState;
  }
}

export interface ServiceOptions {
  config: BaseConfig;
  logger: Logger;
  /**
   * The service's Awilix container, built in its `container.ts` with
   * `createContainer<Cradle>()` after augmenting `Cradle` from '@fastify/awilix'.
   */
  container: AwilixContainer<Cradle>;
  /**
   * The service's business modules (modular monolith). Each module registers its own
   * providers and routes. Order matters only for route registration.
   */
  modules?: readonly ServiceModule[];
  /** Extra routes outside any module (rarely needed). */
  routes?: FastifyPluginAsync;
  /** Prefix for all module routes and `routes`, e.g. `/v1`. Health routes are never prefixed. */
  routePrefix?: string;
  /** Service-level readiness checks, e.g. `{ postgres: () => dbHealth(prisma) }`. */
  healthChecks?: Readonly<Record<string, HealthCheck>>;
  corsOrigins?: readonly string[];
  /** OpenAPI + Swagger UI at `/api-docs` (+ `/api-docs.json`). Omit or `false` to disable. */
  docs?: DocsOptions | false;
  /** Default 1 MiB. */
  bodyLimit?: number;
  /** Trust `X-Forwarded-*` (services sit behind NGINX / the gateway). Default `true`. */
  trustProxy?: boolean;
}

export interface StartServiceOptions extends ServiceOptions {
  /** Default: 0 locally, 5000 ms elsewhere. */
  drainDelayMs?: number;
}

/**
 * Builds a fully configured Fastify app without listening (use `app.inject()` in tests).
 *
 * Registration order: Joi compilers → request context → error handler → auth context →
 * security (helmet, CORS) → module providers + Awilix DI → docs → health routes → module routes.
 */
export async function buildService(options: ServiceOptions): Promise<FastifyInstance> {
  const modules = options.modules ?? [];
  assertModules(modules);
  for (const module of modules) module.register?.(options.container);

  const app = Fastify({
    // tsc needs this cast (pino Logger vs FastifyBaseLogger generics); type-aware ESLint
    // resolves the types differently and calls it unnecessary.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-type-assertion
    loggerInstance: options.logger as FastifyBaseLogger,
    genReqId: genRequestId,
    requestIdHeader: false,
    requestIdLogLabel: 'requestId',
    trustProxy: options.trustProxy ?? true,
    bodyLimit: options.bodyLimit ?? 1_048_576,
    keepAliveTimeout: 72_000,
    return503OnClosing: true,
    forceCloseConnections: 'idle',
  });

  app.setValidatorCompiler(joiValidatorCompiler);
  app.setSerializerCompiler(jsonSerializerCompiler);

  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authContextPlugin);
  await app.register(securityPlugin, { corsOrigins: options.corsOrigins ?? [] });

  await app.register(fastifyAwilixPlugin, {
    container: options.container,
    disposeOnClose: true,
    disposeOnResponse: true,
    asyncInit: true,
    asyncDispose: true,
  });
  app.addHook('onRequest', (request, _reply, done) => {
    request.diScope.register({
      requestId: asValue(request.id),
      log: asValue(request.log),
    });
    done();
  });

  if (options.docs) await registerDocs(app, options.docs);

  const lifecycle: LifecycleState = { shuttingDown: false };
  app.decorate('lifecycle', lifecycle);
  await app.register(healthRoutes, {
    checks: collectHealthChecks(options.healthChecks ?? {}, modules),
    state: lifecycle,
  });

  const routePrefix = options.routePrefix ?? '';
  for (const module of modules) {
    if (module.routes) {
      await app.register(module.routes, { prefix: `${routePrefix}${module.prefix ?? ''}` });
    }
  }
  if (options.routes) await app.register(options.routes, { prefix: routePrefix });

  return app;
}

/** Builds the app, wires graceful shutdown to process signals, and starts listening. */
export async function startService(options: StartServiceOptions): Promise<FastifyInstance> {
  const { config } = options;
  const app = await buildService(options);

  const shutdown = createShutdown({
    app,
    state: app.lifecycle,
    timeoutMs: config.SHUTDOWN_TIMEOUT_MS,
    drainDelayMs: options.drainDelayMs ?? (config.APP_ENV === 'local' ? 0 : 5_000),
  });
  registerProcessHandlers(shutdown, app.log);

  await app.listen({ host: config.HOST, port: config.PORT });
  return app;
}
