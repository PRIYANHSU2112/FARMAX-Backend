import { setTimeout as sleep } from 'node:timers/promises';

import type { FastifyBaseLogger, FastifyInstance } from 'fastify';

import type { LifecycleState } from './health.js';

export interface ShutdownOptions {
  app: FastifyInstance;
  state: LifecycleState;
  /** Hard limit; the process is force-exited with code 1 after this. */
  timeoutMs: number;
  /** Time to keep serving while the load balancer notices readiness = 503. */
  drainDelayMs: number;
  /** Injectable for tests. */
  exit?: (code: number) => void;
}

export type ShutdownFn = (reason: string, exitCode?: number) => Promise<void>;

/**
 * Graceful shutdown, runs once:
 * 1. readiness → 503   2. wait `drainDelayMs`   3. `app.close()` (stops HTTP, runs onClose
 * hooks, disposes DI resources)   4. exit. Force-exits if it takes longer than `timeoutMs`.
 */
export const createShutdown = (options: ShutdownOptions): ShutdownFn => {
  const { app, state, timeoutMs, drainDelayMs } = options;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let started = false;

  return async (reason, exitCode = 0) => {
    if (started) return;
    started = true;
    state.shuttingDown = true;
    app.log.info({ reason, drainDelayMs, timeoutMs }, 'graceful shutdown started');

    const forceExit = setTimeout(() => {
      app.log.error({ timeoutMs }, 'graceful shutdown timed out, forcing exit');
      exit(1);
    }, timeoutMs);
    forceExit.unref();

    try {
      if (drainDelayMs > 0) await sleep(drainDelayMs);
      await app.close();
      app.log.info('graceful shutdown complete');
      exit(exitCode);
    } catch (error) {
      app.log.error({ err: error }, 'graceful shutdown failed');
      exit(1);
    } finally {
      clearTimeout(forceExit);
    }
  };
};

/** Wires SIGTERM/SIGINT and fatal process errors to the shutdown function. */
export const registerProcessHandlers = (shutdown: ShutdownFn, log: FastifyBaseLogger): void => {
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => void shutdown(signal));
  }
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ err: reason }, 'unhandled promise rejection');
    void shutdown('unhandledRejection', 1);
  });
};
