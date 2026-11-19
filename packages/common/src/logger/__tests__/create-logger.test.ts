import { describe, expect, it } from 'vitest';

import { createLogger } from '../index.js';

const capture = () => {
  const lines: Record<string, unknown>[] = [];
  const destination = {
    write: (chunk: string) => {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  };
  return { lines, destination };
};

describe('createLogger', () => {
  it('writes structured JSON with service metadata', () => {
    const { lines, destination } = capture();
    const logger = createLogger({
      service: 'auth-service',
      appEnv: 'prod',
      version: '1.2.3',
      destination,
    });

    logger.info({ requestId: 'req-1' }, 'user logged in');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'auth-service',
      env: 'prod',
      version: '1.2.3',
      requestId: 'req-1',
      msg: 'user logged in',
    });
    expect(typeof lines[0]?.time).toBe('string');
    expect(Number.isNaN(Date.parse(lines[0]?.time as string))).toBe(false);
  });

  it('redacts secrets at the top level, nested levels and in HTTP headers', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 'auth-service', appEnv: 'prod', destination });

    logger.info({
      password: 'p1',
      user: { email: 'a@b.c', refreshToken: 'r1' },
      body: { payment: { cvv: '123' } },
      req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1', host: 'x' } },
    });

    const line = JSON.stringify(lines[0]);
    for (const secret of ['p1', 'r1', '"123"', 'Bearer abc', 'sid=1']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('a@b.c');
    expect(line).toContain('"host":"x"');
  });

  it('respects the log level', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 's', appEnv: 'prod', level: 'warn', destination });

    logger.info('hidden');
    logger.warn('shown');

    expect(lines.map((l) => l.msg)).toEqual(['shown']);
  });

  it('serializes errors with type, message and stack', () => {
    const { lines, destination } = capture();
    const logger = createLogger({ service: 's', appEnv: 'prod', destination });

    logger.error({ err: new TypeError('boom') }, 'failed');

    expect(lines[0]?.err).toMatchObject({ type: 'TypeError', message: 'boom' });
    expect((lines[0]?.err as { stack: string }).stack).toContain('TypeError: boom');
  });
});
