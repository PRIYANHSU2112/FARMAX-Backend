import type { AuthUser, SessionId, UserId } from '../../types/index.js';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import {
  authContextPlugin,
  authenticate,
  errorHandlerPlugin,
  getRequestContext,
  internalAuth,
  requestContextPlugin,
  requireRoles,
} from '../index.js';

const customer: AuthUser = {
  id: 'u-1' as UserId,
  sessionId: 's-1' as SessionId,
  jti: 'j-1',
  userType: 'CUSTOMER',
  roles: [],
  scope: 'full',
  expiresAt: 0,
};
const admin: AuthUser = {
  ...customer,
  id: 'u-2' as UserId,
  userType: 'INTERNAL',
  roles: ['admin'],
};

const verify = (token: string) => {
  if (token === 'customer-token') return Promise.resolve(customer);
  if (token === 'admin-token') return Promise.resolve(admin);
  return Promise.reject(new Error('jwt expired'));
};

const INTERNAL_TOKEN = 'x'.repeat(40);

let app: FastifyInstance;

const build = async () => {
  app = Fastify();
  await app.register(requestContextPlugin);
  await app.register(errorHandlerPlugin);
  await app.register(authContextPlugin);

  const auth = authenticate(verify);
  app.get('/me', { preHandler: [auth] }, async (request) => ({
    user: request.user?.id,
    contextUser: getRequestContext()?.userId,
  }));
  app.get('/admin', { preHandler: [auth, requireRoles('admin')] }, async () => ({ ok: true }));
  app.get('/internal/ping', { preHandler: [internalAuth(INTERNAL_TOKEN)] }, async () => ({
    ok: true,
  }));
  return app;
};

const get = (url: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers });

afterEach(async () => {
  await app.close();
});

describe('authenticate', () => {
  it('rejects requests without a bearer token', async () => {
    await build();
    const res = await get('/me');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects invalid tokens without leaking the reason', async () => {
    await build();
    const res = await get('/me', { authorization: 'Bearer nope' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('jwt expired');
  });

  it('sets request.user and the request context user', async () => {
    await build();
    const res = await get('/me', { authorization: 'Bearer customer-token' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ user: 'u-1', contextUser: 'u-1' });
  });
});

describe('requireRoles', () => {
  it('returns 403 when the role is missing', async () => {
    await build();
    expect((await get('/admin', { authorization: 'Bearer customer-token' })).statusCode).toBe(403);
  });

  it('allows callers with the role', async () => {
    await build();
    expect((await get('/admin', { authorization: 'Bearer admin-token' })).statusCode).toBe(200);
  });
});

describe('internalAuth', () => {
  it('accepts only the exact shared token', async () => {
    await build();
    expect((await get('/internal/ping')).statusCode).toBe(401);
    expect((await get('/internal/ping', { 'x-internal-token': 'wrong' })).statusCode).toBe(401);
    expect((await get('/internal/ping', { 'x-internal-token': INTERNAL_TOKEN })).statusCode).toBe(
      200,
    );
  });

  it('refuses weak tokens at startup', () => {
    expect(() => internalAuth('short')).toThrow(/at least 32/);
  });
});
