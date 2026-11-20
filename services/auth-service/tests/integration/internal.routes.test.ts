import { INTERNAL_TOKEN_HEADER } from '@farmx/common/middleware';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildApp } from '../../src/app.js';

const TOKEN = 'internal-token-for-tests-0123456789abcdef';
const ENV = {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: 'postgresql://test:test@localhost:5432/farmx_test',
  INTERNAL_SERVICE_TOKEN: TOKEN,
} as NodeJS.ProcessEnv;
const USER = '01900000-0000-7000-8000-000000000001';
const WAREHOUSE = '01900000-0000-7000-8000-0000000000a1';
const internal = { [INTERNAL_TOKEN_HEADER]: TOKEN };
/** The `data` of a success envelope. */
const dataOf = (res: LightMyRequestResponse) => res.json<{ data: Record<string, unknown> }>().data;

let app: FastifyInstance | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function build() {
  app = await buildApp(ENV);
  const usersService = {
    getContact: vi.fn((id: string) =>
      Promise.resolve(
        id === USER
          ? {
              id,
              userType: 'CUSTOMER',
              status: 'ACTIVE',
              fullName: 'Ravi',
              email: null,
              emailVerified: false,
              phone: '+919000000001',
              phoneVerified: true,
              preferredLanguage: 'en',
            }
          : null,
      ),
    ),
    listActiveIds: vi.fn(() => Promise.resolve([USER, WAREHOUSE])),
    filterActiveIds: vi.fn((ids: string[]) => Promise.resolve(ids.slice(0, 1))),
  };
  const accessService = {
    listPermissionHolderIds: vi.fn(() => Promise.resolve([USER, WAREHOUSE])),
  };
  app.diContainer.register({
    usersService: asValue(usersService as never),
    accessService: asValue(accessService as never),
  });
  return { app, usersService, accessService };
}

describe('auth internal routes (notification-service)', () => {
  it('401 without the internal token, before validation', async () => {
    const { app: a } = await build();
    for (const url of [
      `/internal/users/${USER}/contact`,
      '/internal/users/ids?userType=CUSTOMER',
      '/internal/access/recipients?permission=orders.confirm',
      '/internal/users/not-a-uuid/contact',
    ]) {
      expect((await a.inject({ method: 'GET', url })).statusCode).toBe(401);
    }
  });

  it('contact: 200 for a known user, 404 otherwise', async () => {
    const { app: a } = await build();
    const ok = await a.inject({ url: `/internal/users/${USER}/contact`, headers: internal });
    expect(ok.statusCode).toBe(200);
    expect(dataOf(ok)).toMatchObject({ id: USER, phone: '+919000000001', phoneVerified: true });
    const missing = await a.inject({
      url: `/internal/users/${WAREHOUSE}/contact`,
      headers: internal,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('ids: keyset page, nextCursor only when the page is full', async () => {
    const { app: a, usersService } = await build();
    const full = await a.inject({
      url: '/internal/users/ids?userType=CUSTOMER&limit=2',
      headers: internal,
    });
    expect(dataOf(full)).toEqual({ ids: [USER, WAREHOUSE], nextCursor: WAREHOUSE });
    expect(usersService.listActiveIds).toHaveBeenCalledWith('CUSTOMER', undefined, 2);
    const last = await a.inject({
      url: `/internal/users/ids?userType=CUSTOMER&cursor=${USER}`,
      headers: internal,
    });
    expect(dataOf(last).nextCursor).toBeNull();
    const bad = await a.inject({ url: '/internal/users/ids?userType=ROBOT', headers: internal });
    expect(bad.statusCode).toBe(422);
  });

  it('recipients: holders at GLOBAL / warehouse scope, filtered to ACTIVE staff', async () => {
    const { app: a, accessService, usersService } = await build();
    const res = await a.inject({
      url: `/internal/access/recipients?permission=inventory.view&warehouseId=${WAREHOUSE}`,
      headers: internal,
    });
    expect(res.statusCode).toBe(200);
    expect(dataOf(res)).toEqual({ userIds: [USER] });
    expect(accessService.listPermissionHolderIds).toHaveBeenCalledWith('inventory.view', WAREHOUSE);
    expect(usersService.filterActiveIds).toHaveBeenCalledWith([USER, WAREHOUSE], 'INTERNAL');
    const bad = await a.inject({
      url: '/internal/access/recipients?permission=DROP TABLE',
      headers: internal,
    });
    expect(bad.statusCode).toBe(422);
  });
});
