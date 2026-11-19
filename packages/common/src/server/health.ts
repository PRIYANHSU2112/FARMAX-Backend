import type { FastifyPluginCallback } from 'fastify';

/** Resolves when the dependency is healthy, throws/rejects when it is not. */
export type HealthCheck = () => Promise<void>;

export interface LifecycleState {
  /** Set at the start of graceful shutdown; readiness then returns 503. */
  shuttingDown: boolean;
}

export interface HealthRoutesOptions {
  checks: Readonly<Record<string, HealthCheck>>;
  state: LifecycleState;
  timeoutMs?: number;
}

type CheckStatus = 'up' | 'down';

const withTimeout = async (check: HealthCheck, timeoutMs: number): Promise<void> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`health check timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });
  try {
    await Promise.race([check(), timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** Swagger docs for the public health routes (no lock, no response envelope). */
const LIVE_DOCS = {
  tags: ['Health'],
  summary: 'Liveness probe',
  description: 'The process is up. No dependency checks. Public.',
  response: {
    200: {
      description: 'Alive',
      type: 'object',
      properties: { status: { type: 'string', enum: ['ok'] } },
      example: { status: 'ok' },
    },
  },
} as const;

const READY_DOCS = {
  tags: ['Health'],
  summary: 'Readiness probe',
  description:
    'Every dependency (Postgres, Redis, ...) is reachable and the service is not shutting down. Public.',
  response: {
    200: {
      description: 'Ready',
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['ok'] },
        checks: { type: 'object', additionalProperties: { type: 'string', enum: ['up', 'down'] } },
      },
      example: { status: 'ok', checks: { postgres: 'up' } },
    },
    503: {
      description: 'Not ready (a dependency is down, or the service is shutting down)',
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['degraded', 'shutting_down'] },
        checks: { type: 'object', additionalProperties: { type: 'string', enum: ['up', 'down'] } },
      },
      example: { status: 'degraded', checks: { postgres: 'down' } },
    },
  },
} as const;

/**
 * `GET /health/live`  — process is up (no dependency checks). Used for restarts.
 * `GET /health/ready` — all dependencies reachable and not shutting down. Used for routing traffic.
 */
export const healthRoutes: FastifyPluginCallback<HealthRoutesOptions> = (app, opts, done) => {
  const timeoutMs = opts.timeoutMs ?? 2_000;

  app.get('/health/live', { logLevel: 'silent', schema: LIVE_DOCS }, () => ({ status: 'ok' }));

  app.get('/health/ready', { logLevel: 'silent', schema: READY_DOCS }, async (request, reply) => {
    if (opts.state.shuttingDown) {
      return reply.status(503).send({ status: 'shutting_down', checks: {} });
    }

    const results = await Promise.all(
      Object.entries(opts.checks).map(async ([name, check]): Promise<[string, CheckStatus]> => {
        try {
          await withTimeout(check, timeoutMs);
          return [name, 'up'];
        } catch (error) {
          request.log.warn({ err: error, check: name }, 'readiness check failed');
          return [name, 'down'];
        }
      }),
    );

    const healthy = results.every(([, status]) => status === 'up');
    return reply
      .status(healthy ? 200 : 503)
      .send({ status: healthy ? 'ok' : 'degraded', checks: Object.fromEntries(results) });
  });

  done();
};
