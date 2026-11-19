import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';

const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
} as NodeJS.ProcessEnv;

const caller = {
  id: '01900000-0000-7000-8000-000000000001',
  sessionId: 's',
  jti: 'j',
  userType: 'INTERNAL',
  roles: ['super_admin'],
  scope: 'full',
  expiresAt: 4_102_444_800,
} as unknown as AuthUser;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build(options: { allowed?: boolean; verify?: boolean } = {}) {
  app = await buildApp(ENV);
  const usersService = {
    list: vi.fn(() => Promise.resolve({ items: [], nextCursor: null, limit: 20 })),
    create: vi.fn(),
  };
  const accessService = { hasPermission: vi.fn(() => Promise.resolve(options.allowed ?? true)) };
  app.diContainer.register({
    tokenVerifier: asValue(() =>
      options.verify === false ? Promise.reject(new Error('bad token')) : Promise.resolve(caller),
    ),
    accessService: asValue(accessService as never),
    usersService: asValue(usersService as never),
  });
  return { app, usersService, accessService };
}

const auth = { authorization: 'Bearer test-token' };

describe('admin users routes', () => {
  it('fails closed with the default verifier (tokens module not implemented yet)', async () => {
    app = await buildApp(ENV);
    const res = await app.inject({ method: 'GET', url: '/admin/users', headers: auth });
    expect(res.statusCode).toBe(401);
  });

  it('401 without a bearer token', async () => {
    const { app: a } = await build();
    expect((await a.inject({ method: 'GET', url: '/admin/users' })).statusCode).toBe(401);
  });

  it('401 with an invalid token', async () => {
    const { app: a } = await build({ verify: false });
    expect((await a.inject({ method: 'GET', url: '/admin/users', headers: auth })).statusCode).toBe(
      401,
    );
  });

  it('403 when the caller lacks the permission', async () => {
    const { app: a, accessService, usersService } = await build({ allowed: false });
    const res = await a.inject({ method: 'GET', url: '/admin/users', headers: auth });
    expect(res.statusCode).toBe(403);
    expect(accessService.hasPermission).toHaveBeenCalledWith(caller.id, 'users.view');
    expect(usersService.list).not.toHaveBeenCalled();
  });

  it('200 with a paginated envelope when allowed', async () => {
    const { app: a, usersService } = await build();
    const res = await a.inject({
      method: 'GET',
      url: '/admin/users?limit=5&status=ACTIVE',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: [], meta: { nextCursor: null, limit: 20 } });
    expect(usersService.list).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5, status: 'ACTIVE', includeDeleted: false }),
    );
  });

  it('checks the route-specific permission (force-logout → users.sessions_revoke)', async () => {
    const { app: a, accessService } = await build({ allowed: false });
    const res = await a.inject({
      method: 'POST',
      url: '/admin/users/01900000-0000-7000-8000-000000000002/force-logout',
      headers: auth,
      payload: { reason: 'lost device' },
    });
    expect(res.statusCode).toBe(403);
    expect(accessService.hasPermission).toHaveBeenCalledWith(caller.id, 'users.sessions_revoke');
  });

  it('422 on an invalid create body (after auth)', async () => {
    const { app: a, usersService } = await build();
    const res = await a.inject({
      method: 'POST',
      url: '/admin/users',
      headers: auth,
      payload: { userType: 'INTERNAL', fullName: 'No Identifier' },
    });
    expect(res.statusCode).toBe(422);
    expect(usersService.create).not.toHaveBeenCalled();
  });
});
