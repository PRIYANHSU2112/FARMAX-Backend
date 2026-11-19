import { createLogger } from '../../logger/index.js';
import type { Cradle } from '@fastify/awilix';
import { createContainer } from 'awilix';
import { describe, expect, it, vi } from 'vitest';

import { buildService, createShutdown } from '../index.js';

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

const build = () =>
  buildService({
    config,
    logger: createLogger({ service: 'test-service', level: 'silent', pretty: false }),
    container: createContainer<Cradle>(),
    routes: async () => {},
  });

describe('createShutdown', () => {
  it('flips readiness to 503 while draining, then closes and exits 0', async () => {
    const app = await build();
    const onClose = vi.fn();
    app.addHook('onClose', (_instance, done) => {
      onClose();
      done();
    });
    const exit = vi.fn();

    const shutdown = createShutdown({
      app,
      state: app.lifecycle,
      timeoutMs: 5_000,
      drainDelayMs: 100,
      exit,
    });
    const running = shutdown('SIGTERM');

    const during = await app.inject({ method: 'GET', url: '/health/ready' });
    expect(during.statusCode).toBe(503);
    expect(during.json()).toMatchObject({ status: 'shutting_down' });
    expect(exit).not.toHaveBeenCalled();

    await running;
    expect(onClose).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('runs only once even if signalled twice', async () => {
    const app = await build();
    const exit = vi.fn();
    const shutdown = createShutdown({
      app,
      state: app.lifecycle,
      timeoutMs: 5_000,
      drainDelayMs: 0,
      exit,
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);
    expect(exit).toHaveBeenCalledOnce();
  });

  it('force-exits with 1 when closing hangs past the timeout', async () => {
    const app = await build();
    app.addHook('onClose', () => new Promise(() => {})); // never resolves
    const exit = vi.fn();

    const shutdown = createShutdown({
      app,
      state: app.lifecycle,
      timeoutMs: 100,
      drainDelayMs: 0,
      exit,
    });
    void shutdown('SIGTERM');

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it('exits with the given code for fatal errors', async () => {
    const app = await build();
    const exit = vi.fn();
    const shutdown = createShutdown({
      app,
      state: app.lifecycle,
      timeoutMs: 5_000,
      drainDelayMs: 0,
      exit,
    });

    await shutdown('uncaughtException', 1);
    expect(exit).toHaveBeenCalledWith(1);
  });
});
