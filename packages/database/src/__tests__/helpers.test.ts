import {
  type AppError,
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
} from '@farmx/common/errors';
import { createLogger } from '@farmx/common/logger';
import { describe, expect, it } from 'vitest';

import {
  type PrismaLogDefinition,
  createDbHealthCheck,
  createPrisma,
  cursorArgs,
  isUniqueViolation,
  mapPrismaError,
  toPage,
  withPrismaErrors,
} from '../index.js';

/** Builds an error shaped like Prisma's runtime errors (matched by name, not class). */
const prismaError = (code: string, meta?: Record<string, unknown>) =>
  Object.assign(new Error(`prisma ${code}`), {
    name: 'PrismaClientKnownRequestError',
    code,
    meta,
  });

describe('mapPrismaError', () => {
  it('maps unique violations to 409 with the fields (classic meta.target)', () => {
    const mapped = mapPrismaError(prismaError('P2002', { target: ['email'] }));
    expect(mapped).toBeInstanceOf(ConflictError);
    expect((mapped as AppError).message).toBe('email already exists');
    expect((mapped as AppError).details).toEqual({ fields: ['email'] });
  });

  it('reads unique fields from the driver-adapter meta shape', () => {
    const error = prismaError('P2002', {
      driverAdapterError: { cause: { constraint: { fields: ['phone'] } } },
    });
    expect(isUniqueViolation(error, 'phone')).toBe(true);
    expect(isUniqueViolation(error, 'email')).toBe(false);
    expect((mapPrismaError(error) as AppError).message).toBe('phone already exists');
  });

  it('maps record-not-found to 404', () => {
    const mapped = mapPrismaError(prismaError('P2025', { modelName: 'Session' }));
    expect(mapped).toBeInstanceOf(NotFoundError);
    expect((mapped as AppError).message).toBe('Session not found');
  });

  it('maps connection and pool errors to a non-operational 503', () => {
    const init = Object.assign(new Error('cannot reach db'), {
      name: 'PrismaClientInitializationError',
      errorCode: 'P1001',
    });
    for (const error of [init, prismaError('P2024')]) {
      const mapped = mapPrismaError(error);
      expect(mapped).toBeInstanceOf(ServiceUnavailableError);
      expect((mapped as AppError).isOperational).toBe(false);
    }
  });

  it('returns unknown and non-Prisma errors unchanged', () => {
    const unknownCode = prismaError('P9999');
    const plain = new TypeError('boom');
    expect(mapPrismaError(unknownCode)).toBe(unknownCode);
    expect(mapPrismaError(plain)).toBe(plain);
  });

  it('withPrismaErrors rethrows mapped errors and passes results through', async () => {
    await expect(withPrismaErrors(() => Promise.resolve(42))).resolves.toBe(42);
    await expect(
      withPrismaErrors(() => Promise.reject(prismaError('P2025', { modelName: 'User' }))),
    ).rejects.toThrow('User not found');
  });
});

describe('cursor pagination', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i + 1}` }));

  it('builds args for the first page and following pages', () => {
    expect(cursorArgs({ limit: 10 })).toEqual({ take: 11 });
    expect(cursorArgs({ limit: 10, cursor: 'id-10' })).toEqual({
      take: 11,
      skip: 1,
      cursor: { id: 'id-10' },
    });
  });

  it('clamps the limit to 1..100', () => {
    expect(cursorArgs({ limit: 5_000 }).take).toBe(101);
    expect(cursorArgs({ limit: 0 }).take).toBe(21);
    expect(cursorArgs({ limit: -3 }).take).toBe(2);
  });

  it('returns nextCursor only when more rows exist', () => {
    expect(toPage(rows(11), 10)).toEqual({
      items: rows(10),
      nextCursor: 'id-10',
      limit: 10,
    });
    expect(toPage(rows(4), 10)).toEqual({ items: rows(4), nextCursor: null, limit: 10 });
    expect(toPage([], 10)).toEqual({ items: [], nextCursor: null, limit: 10 });
  });
});

describe('createPrisma', () => {
  type Handler = (event: Record<string, unknown>) => void;

  const fakeClient = (log: PrismaLogDefinition[]) => {
    const handlers: Record<string, Handler> = {};
    return {
      log,
      handlers,
      $on(event: string, handler: Handler) {
        handlers[event] = handler;
      },
    };
  };

  const capture = () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      service: 'test',
      appEnv: 'prod',
      level: 'debug',
      destination: {
        write: (chunk: string) => {
          lines.push(JSON.parse(chunk) as Record<string, unknown>);
        },
      },
    });
    return { lines, logger };
  };

  it('requests event-based logging and logs slow queries without params', () => {
    const { lines, logger } = capture();
    const client = createPrisma(fakeClient, { logger, slowQueryMs: 100 });

    expect(client.log.map((l) => l.level)).toEqual(['query', 'warn', 'error']);

    client.handlers.query?.({ query: 'SELECT 1', params: '["secret"]', duration: 5, target: 'q' });
    client.handlers.query?.({
      query: 'SELECT *',
      params: '["secret"]',
      duration: 250,
      target: 'q',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'warn',
      component: 'prisma',
      durationMs: 250,
      query: 'SELECT *',
    });
    expect(JSON.stringify(lines)).not.toContain('secret');
  });

  it('forwards Prisma warnings and errors to the logger', () => {
    const { lines, logger } = capture();
    const client = createPrisma(fakeClient, { logger });

    client.handlers.warn?.({ message: 'pool nearly exhausted', target: 'pool' });
    client.handlers.error?.({ message: 'connection lost', target: 'conn' });

    expect(lines.map((l) => [l.level, l.msg])).toEqual([
      ['warn', 'pool nearly exhausted'],
      ['error', 'connection lost'],
    ]);
  });
});

describe('createDbHealthCheck', () => {
  it('runs SELECT 1 and propagates failures', async () => {
    const queries: string[] = [];
    const healthy = createDbHealthCheck({
      $queryRaw: (strings) => {
        queries.push(strings.join(''));
        return Promise.resolve([{ '?column?': 1 }]);
      },
    });
    await healthy();
    expect(queries).toEqual(['SELECT 1']);

    const down = createDbHealthCheck({
      $queryRaw: () => Promise.reject(new Error('ECONNREFUSED')),
    });
    await expect(down()).rejects.toThrow('ECONNREFUSED');
  });
});
