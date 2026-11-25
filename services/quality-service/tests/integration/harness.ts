import { randomUUID } from 'node:crypto';

import type { AuthUser } from '@farmx/common/types';
import type { EventEnvelope } from '@farmx/infra/events';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { Grants } from '../../src/adapters/auth.js';
import type { UnitTrace } from '../../src/adapters/warehouse-client.js';
import { buildApp } from '../../src/app.js';

/**
 * Integration tests against a REAL Postgres with the migrations applied (local dev DB, never Neon):
 *   QUALITY_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx pnpm --filter @farmx/quality-service test
 * Skipped when the variable is not set. Redis is an in-memory stub; the bearer token IS the user
 * id; media / product / warehouse clients are stubs.
 */
export const DB_URL = process.env.QUALITY_IT_DATABASE_URL;

const users = new Map<string, { user: AuthUser; grants: Grants }>();

const register = (userType: string, grants: Grants): string => {
  const id = randomUUID();
  users.set(id, {
    user: {
      id,
      sessionId: 's',
      jti: 'j',
      userType,
      roles: [],
      scope: 'full',
      expiresAt: 0,
    } as unknown as AuthUser,
    grants,
  });
  return id;
};

/** Staff with GLOBAL keys and optional per-warehouse keys. */
export const staff = (permissions: string[], warehouses: Record<string, string[]> = {}) =>
  register('INTERNAL', { permissions, warehouses });

/** A signed-in CUSTOMER. */
export const customer = () => register('CUSTOMER', { permissions: [], warehouses: {} });

/** Unit QR traces the warehouse stub answers. */
export const traces = new Map<string, UnitTrace>();

const memoryRedis = () => {
  const store = new Map<string, string>();
  return {
    get: (k: string) => Promise.resolve(store.get(k) ?? null),
    mget: (...keys: string[]) => Promise.resolve(keys.map((k) => store.get(k) ?? null)),
    set: (k: string, v: string) => {
      store.set(k, v);
      return Promise.resolve('OK');
    },
    // Rate limiter (Lua) → "Redis down" → the guard allows.
    eval: () => Promise.reject(new Error('no lua in tests')),
    ping: () => Promise.resolve('PONG'),
    quit: () => Promise.resolve('OK'),
  };
};

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: process.env.IT_LOG_LEVEL ?? 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '10',
    INTERNAL_SERVICE_TOKEN: 'it-internal-token-0123456789abcdef0123456789',
  });
  app.diContainer.register({
    redis: asValue(memoryRedis() as never),
    accessClient: asValue({
      grants: (userId: string) =>
        Promise.resolve(users.get(userId)?.grants ?? { permissions: [], warehouses: {} }),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
    mediaClient: asValue({
      verify: (receipt: string) => ({
        key: `quality/${receipt}.pdf`,
        mime: 'application/pdf',
        size: 1,
      }),
      signRead: (keys: readonly string[]) =>
        Promise.resolve(Object.fromEntries(keys.map((k) => [k, `https://signed.test/${k}`]))),
    } as never),
    productClient: asValue({ variantFacts: () => Promise.resolve([]) } as never),
    warehouseClient: asValue({
      unitTrace: (qr: string) => Promise.resolve(traces.get(qr) ?? null),
    } as never),
  });
  await app.ready();
  return app;
};

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  token: string | null,
  payload?: unknown,
  headers: Record<string, string> = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...(token === null ? {} : { authorization: `Bearer ${token}` }), ...headers },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) =>
  res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: Record<string, unknown> } }>().error;

/** Delivers a warehouse event through the real inbox (dedupe by event id). */
export const deliver = async (
  app: FastifyInstance,
  type: string,
  payload: unknown,
  id = randomUUID(),
) => {
  const handle = app.diContainer.resolve('eventsRuntime').handler();
  const env: EventEnvelope = {
    id,
    type,
    version: 1,
    occurredAt: new Date().toISOString(),
    source: 'warehouse-service',
    correlationId: randomUUID(),
    data: payload,
  };
  return handle(env);
};

/** Outbox rows of a type whose `data[key] === value`. */
export const outbox = async (app: FastifyInstance, type: string, key: string, value: string) => {
  const rows = await app.diContainer
    .resolve('db')
    .outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'desc' }, take: 300 });
  return rows
    .map((r) => (r.payload as { data: Record<string, unknown> }).data)
    .filter((d) => d[key] === value);
};
