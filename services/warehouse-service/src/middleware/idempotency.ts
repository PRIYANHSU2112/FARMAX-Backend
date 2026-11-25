import { createHash } from 'node:crypto';

import { AppError, ConflictError, ErrorCode } from '@farmx/common/errors';
import { ok } from '@farmx/common/response';
import { warehouseKeys } from '@farmx/infra/redis';
import type { FastifyReply, FastifyRequest } from 'fastify';

const KEY = /^[A-Za-z0-9._-]{8,64}$/;
const TTL_SECONDS = 86_400;
const PENDING_SECONDS = 60;

interface Stored {
  /** SHA-256 of the request (params + query + body). */
  h: string;
  /** null while the first request is still running. */
  s: number | null;
  b?: unknown;
}

/** Stable JSON (sorted keys) so the same body always hashes the same. */
const stable = (v: unknown): string => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
};

export const requestHash = (request: FastifyRequest): string =>
  createHash('sha256')
    .update(stable({ p: request.params, q: request.query, b: request.body }))
    .digest('hex');

/**
 * Generic idempotency for warehouse writes (D-62): the stored response of a write retried with
 * the same `Idempotency-Key` is replayed for 24 h, per user AND route. The same key with a
 * different request → 422 IDEMPOTENCY_KEY_REUSED; a concurrent duplicate → 409. Without the
 * header (or with Redis down) the write runs normally: DB state guards and unique keys remain
 * the backstop.
 */
export async function idempotent<T>(
  request: FastifyRequest,
  routeId: string,
  work: () => Promise<{ status: number; body: T }>,
): Promise<{ status: number; body: T; replayed: boolean }> {
  const header = request.headers['idempotency-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key === undefined || request.user === null || !KEY.test(key))
    return { ...(await work()), replayed: false };

  const redis = request.diScope.resolve('redis');
  const redisKey = warehouseKeys.idempotency(request.user.id, routeId, key);
  const hash = requestHash(request);
  let raw: string | null;
  try {
    raw = await redis.get(redisKey);
  } catch {
    return { ...(await work()), replayed: false };
  }
  if (raw !== null) {
    const prev = JSON.parse(raw) as Stored;
    if (prev.h !== hash)
      throw new AppError(
        ErrorCode.VALIDATION_ERROR,
        'This Idempotency-Key was already used with a different request',
        422,
        { details: { reason: 'IDEMPOTENCY_KEY_REUSED' } },
      );
    if (prev.s === null)
      throw new ConflictError('A request with this Idempotency-Key is in progress');
    return { status: prev.s, body: prev.b as T, replayed: true };
  }
  const pending: Stored = { h: hash, s: null };
  const claimed = await redis
    .set(redisKey, JSON.stringify(pending), 'EX', PENDING_SECONDS, 'NX')
    .catch(() => 'OK');
  if (claimed !== 'OK')
    throw new ConflictError('A request with this Idempotency-Key is in progress');
  try {
    const result = await work();
    const done: Stored = { h: hash, s: result.status, b: result.body };
    await redis.set(redisKey, JSON.stringify(done), 'EX', TTL_SECONDS).catch(() => undefined);
    return { ...result, replayed: false };
  } catch (error) {
    await redis.del(redisKey).catch(() => undefined);
    throw error;
  }
}

/** Runs an idempotent write and sends `{ success, data }` with its status (replays included). */
export async function sendIdempotent(
  request: FastifyRequest,
  reply: FastifyReply,
  routeId: string,
  status: 200 | 201,
  work: () => Promise<unknown>,
): Promise<FastifyReply> {
  const r = await idempotent(request, routeId, async () => ({ status, body: await work() }));
  if (r.replayed) void reply.header('idempotent-replayed', 'true');
  return reply.code(r.status).send(ok(r.body));
}
