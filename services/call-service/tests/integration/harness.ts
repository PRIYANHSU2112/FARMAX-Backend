import { randomUUID } from 'node:crypto';

import { NotFoundError } from '@farmx/common/errors';
import type { AuthUser } from '@farmx/common/types';
import { asValue } from 'awilix';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';

import type { FarmView, ProductCard } from '../../src/adapters/upstreams.js';
import { buildApp } from '../../src/app.js';

/**
 * Integration tests against REAL Postgres (a local DB with every migration applied, never Neon)
 * and a real redis-cache DB 8:
 *   CALL_IT_DATABASE_URL=postgresql://farmx:farmx@127.0.0.1:5433/farmx_calltest pnpm --filter @farmx/call-service test
 * Skipped when the variable is not set. Token verification + permissions are stubbed (the bearer
 * token IS the user id); product / catalog / farm / auth upstreams are in-memory fakes.
 */
export const DB_URL = process.env.CALL_IT_DATABASE_URL;

type UserType = 'CUSTOMER' | 'INTERNAL' | 'VENDOR';
const users = new Map<string, { user: AuthUser; permissions: string[] }>();

const register = (userType: UserType, permissions: string[]): string => {
  const id = randomUUID();
  users.set(id, {
    user: { id, sessionId: 's', jti: 'j', userType, roles: [], scope: 'full', expiresAt: 0 } as unknown as AuthUser,
    permissions,
  });
  return id;
};
export const customer = (): string => register('CUSTOMER', []);
export const staff = (...permissions: string[]): string => register('INTERNAL', permissions);
export const vendorUser = (): string => register('VENDOR', []);

// ── upstream fakes ──
export const products = new Map<string, ProductCard>();
export const categoryPaths = new Map<string, string[]>();
export const farms = new Map<string, FarmView>();

export const addProduct = (o: { brandId: string; categoryId: string }): string => {
  const id = randomUUID();
  products.set(id, {
    id,
    name: 'ND LaSota live',
    slug: `nd-${id.slice(0, 8)}`,
    categoryId: o.categoryId,
    brand: { id: o.brandId, name: 'Godavari Biologicals' },
    imageUrl: null,
    isColdChain: true,
    isPrescriptionRequired: false,
    available: true,
  });
  return id;
};

export const addFarm = (ownerUserId: string, productionTypes: string[], territoryCode = 'WG'): string => {
  const id = randomUUID();
  farms.set(id, {
    id,
    farmCode: 'FX-WG-L-00418',
    name: 'Sri Lakshmi Poultry',
    category: 'COMMERCIAL',
    status: 'ACTIVE',
    productionTypes,
    totalBirdCapacity: 60000,
    owner: { userId: ownerUserId, fullName: 'Venkata Ramana' },
    location: { territoryCode, districtName: 'West Godavari', village: 'Tanuku' },
  });
  return id;
};

export const buildTestApp = async (): Promise<FastifyInstance> => {
  const app = await buildApp({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_URL: DB_URL,
    DB_POOL_SIZE: '10',
    REDIS_CACHE_URL: 'redis://localhost:6379/8',
    TELEPHONY_PROVIDER: 'mock',
  });
  app.diContainer.register({
    accessClient: asValue({
      hasPermission: (userId: string, key: string) =>
        Promise.resolve(users.get(userId)?.permissions.includes(key) ?? false),
    } as never),
    tokenVerifier: asValue((token: string) => {
      const u = users.get(token);
      return u === undefined ? Promise.reject(new Error('bad token')) : Promise.resolve(u.user);
    }),
    authDirectory: asValue({ userExists: (id: string) => Promise.resolve(users.has(id)) } as never),
    productClient: asValue({
      card: (id: string) => {
        const p = products.get(id);
        return p === undefined ? Promise.reject(new NotFoundError('Product')) : Promise.resolve(p);
      },
    } as never),
    catalogClient: asValue({
      pathIds: (categoryId: string) => Promise.resolve(categoryPaths.get(categoryId) ?? [categoryId]),
    } as never),
    farmClient: asValue({
      ownedActive: (farmId: string, userId: string) => {
        const f = farms.get(farmId);
        return f?.owner.userId === userId ? Promise.resolve(f) : Promise.reject(new NotFoundError('Farm'));
      },
    } as never),
  });
  await app.ready();
  // Clean slate for the poolGen / recommended / config caches of this test DB.
  await app.diContainer.resolve('redis').flushdb();
  return app;
};

export interface Req {
  user?: string;
  payload?: object;
  headers?: Record<string, string>;
}

export const call = (
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  r: Req = {},
) =>
  app.inject({
    method,
    url,
    headers: { ...(r.user === undefined ? {} : { authorization: `Bearer ${r.user}` }), ...r.headers },
    ...(r.payload === undefined ? {} : { payload: r.payload }),
  });

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- typed test reads
export const data = <T = Record<string, unknown>>(res: LightMyRequestResponse) => res.json<{ data: T }>().data;

export const errorOf = (res: LightMyRequestResponse) =>
  res.json<{ error: { code: string; message: string; details?: { reason?: string; issues?: { path: string }[] } } }>()
    .error;
