import { createLogger } from '../../logger/index.js';
import type { Cradle } from '@fastify/awilix';
import { asFunction, createContainer } from 'awilix';
import { describe, expect, it } from 'vitest';

import { type ServiceModule, buildService, defineModule } from '../index.js';

declare module '@fastify/awilix' {
  interface Cradle {
    usersService: { count: () => number };
    sessionsService: { describe: () => string };
  }
}

const config = {
  NODE_ENV: 'test',
  APP_ENV: 'local',
  SERVICE_NAME: 'test-service',
  SERVICE_VERSION: '0.0.0',
  HOST: '127.0.0.1',
  PORT: 0,
  LOG_LEVEL: 'silent',
  SHUTDOWN_TIMEOUT_MS: 5_000,
} as const;

const usersModule = defineModule({
  name: 'users',
  prefix: '/users',
  register: (container) => {
    container.register({ usersService: asFunction(() => ({ count: () => 2 })).singleton() });
  },
  routes: async (app) => {
    app.get('/count', async (request) => ({
      count: request.diScope.resolve('usersService').count(),
    }));
  },
  healthChecks: { cache: async () => {} },
});

// Depends on the users module through DI only (its public service), never its internals.
const sessionsModule = defineModule({
  name: 'sessions',
  prefix: '/sessions',
  register: (container) => {
    container.register({
      sessionsService: asFunction(({ usersService }: Cradle) => ({
        describe: () => `sessions for ${usersService.count()} users`,
      })).singleton(),
    });
  },
  routes: async (app) => {
    app.get('/', async (request) => ({
      text: request.diScope.resolve('sessionsService').describe(),
    }));
  },
});

const build = (modules: readonly ServiceModule[]) =>
  buildService({
    config,
    logger: createLogger({ service: 'test-service', level: 'silent', pretty: false }),
    container: createContainer<Cradle>({ strict: true }),
    modules,
    routePrefix: '/v1',
  });

describe('service modules', () => {
  it('registers each module under routePrefix + module prefix', async () => {
    const app = await build([usersModule, sessionsModule]);

    expect((await app.inject({ method: 'GET', url: '/v1/users/count' })).json()).toEqual({
      count: 2,
    });
    expect((await app.inject({ method: 'GET', url: '/v1/sessions' })).json()).toEqual({
      text: 'sessions for 2 users',
    });
    await app.close();
  });

  it('namespaces module readiness checks', async () => {
    const app = await build([usersModule, sessionsModule]);
    const res = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(res.json()).toEqual({ status: 'ok', checks: { 'users.cache': 'up' } });
    await app.close();
  });

  it('rejects duplicate or invalid module names at boot', async () => {
    await expect(build([usersModule, usersModule])).rejects.toThrow(/Duplicate module "users"/);
    await expect(build([{ name: 'Bad_Name' }])).rejects.toThrow(/Invalid module name/);
  });
});
