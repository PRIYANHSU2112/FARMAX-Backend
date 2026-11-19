import type { Redis } from 'ioredis';

export type HealthClient = Pick<Redis, 'ping'>;

export interface RedisHealth {
  /** HTTP status for a `/health/ready` response: 200 healthy, 503 not. */
  status: 200 | 503;
  latencyMs: number;
  error?: string;
}

const withTimeout = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`redis ping timed out after ${ms}ms`));
    }, ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
};

/** PING check returning a 200/503 result; never throws. */
export async function redisHealth(client: HealthClient, timeoutMs = 1_500): Promise<RedisHealth> {
  const started = Date.now();
  try {
    const reply: string = await withTimeout(client.ping(), timeoutMs);
    if (reply !== 'PONG') throw new Error(`unexpected PING reply: ${reply}`);
    return { status: 200, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      status: 503,
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Readiness check for `@farmx/server` `healthChecks`: `{ redis: createRedisHealthCheck(client) }`. */
export const createRedisHealthCheck = (client: HealthClient) => async (): Promise<void> => {
  const result = await redisHealth(client);
  if (result.status !== 200) throw new Error(result.error ?? 'redis unhealthy');
};
